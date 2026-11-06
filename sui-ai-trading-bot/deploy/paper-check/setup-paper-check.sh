#!/usr/bin/env bash
# Host update for the validation and production PAPER supervisors.
#
# Run once on the VPS as root, after the change has landed on main:
#   curl -fsSL https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check/setup-paper-check.sh -o /tmp/setup-paper-check.sh
#   sudo bash /tmp/setup-paper-check.sh
#
# It fetches the controller, the fixed sudo wrapper, the sudoers rule and
# the systemd units from the public repository and installs each file
# only if its sha256 matches the digest pinned below. Replaced files are
# backed up next to the originals (.bak-<timestamp>). The script refuses
# to run while either supervisor is active or has a pending job, verifies that policy.json is
# untouched, and after installing it checks the result itself:
# daemon-reload, systemd-analyze verify, LoadState of every unit, the
# installed hashes, and one real status call through the sudo wrapper
# as suiba-deploy. When any pinned file changes, update its digest here
# in the same commit (same discipline as setup-ci-approval.sh).
# prod-policy.json is never installed or enabled here. Production activation
# is a separate explicit cutover operation; installing a unit never starts it.
set -Eeuo pipefail
umask 077

BASE_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check'
POLICY='/etc/suiba-paper-check/policy.json'
SERVICE='suiba-paper-check.service'
PROD_SERVICE='suiba-prod.service'
TIMERS='suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer'
UNITS='suiba-paper-check.service suiba-prod.service suiba-prod-watchdog.service suiba-prod-watchdog.timer suiba-paper-check-cutoff.service suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer'

# name|sha256|target|mode
FILES=(
  'controller.py|8fd16793a4a4c386489a7519f5c5866216a3e0e0e04c33f723103f3cc6cc2921|/usr/local/libexec/suiba-paper-check.py|755'
  'suiba-paper-check|583c298737449e7ce7a8b42dc424d0c891d12101bef1adee0ebc4daa07010e22|/usr/local/sbin/suiba-paper-check|755'
  'suiba-paper-check.sudoers|54d64fdadf0b38749008c112fc12761e03f633538e526ebe6f37eb4b1ec38607|/etc/sudoers.d/suiba-paper-check|440'
  'suiba-paper-check.service|44efe8db2b1c569fd8c2176002acc76b724d6d4c66fa1df1babb988e63f60e95|/etc/systemd/system/suiba-paper-check.service|644'
  'suiba-prod.service|042b393fd872481faffa17d09e57fe7c7a2d57ddb931d609655f4cf29f6ddb02|/etc/systemd/system/suiba-prod.service|644'
  'watchdog.py|7042e7e198fa4b24a33ee61791b093ca91db0ba64129d5a988489330e5eb1822|/usr/local/libexec/suiba-prod-watchdog.py|755'
  'suiba-prod-watchdog.service|88ac174a834219b34d23ee6864ce4c8f676e7b0a72e970ea82c12c1d125f1b0d|/etc/systemd/system/suiba-prod-watchdog.service|644'
  'suiba-prod-watchdog.timer|43e893738a839eb12cfd0fe8fa8b464bcb25e751d2a3ee115b7558e9d70a02cf|/etc/systemd/system/suiba-prod-watchdog.timer|644'
  'suiba-paper-check-cutoff.service|8b40feb7b662796763e53eb6114083233d240d49229027ccea3104c7a628bd96|/etc/systemd/system/suiba-paper-check-cutoff.service|644'
  'suiba-paper-check-cutoff.timer|a9d92ed010eb701ec46bef03b716e973092d696e40890f2e9ddfb2a0a2c96d39|/etc/systemd/system/suiba-paper-check-cutoff.timer|644'
  'suiba-paper-check-cutoff-6h.timer|d6bf9d6194ecaeee0e728bd90ec83a5989ce8ea1e057b5a98b891baa6dbf29ff|/etc/systemd/system/suiba-paper-check-cutoff-6h.timer|644'
  'suiba-paper-check-cutoff-24h.timer|f5646da04eb0917ea279ab7c5b497d51d75b9d8689b658643dc8d8ff3aa46570|/etc/systemd/system/suiba-paper-check-cutoff-24h.timer|644'
)

fail() { echo "SETUP_FAILED: $1" >&2; exit 1; }

[[ $(id -u) -eq 0 ]] || fail 'rootで実行してください（sudo bash setup-paper-check.sh）'
for dir in /usr/local/libexec /usr/local/sbin /etc/systemd/system /etc/sudoers.d; do
  [[ -d $dir ]] || fail "ディレクトリがありません: $dir"
done
[[ -f $POLICY ]] || fail "policy.json がありません: $POLICY"
id suiba-deploy >/dev/null 2>&1 || fail 'suiba-deploy ユーザーがありません'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stamp=$(date +%Y%m%d%H%M%S)

echo '== 1/5 検証・本番 supervisor が静止していることを確認 =='
for service in "$SERVICE" "$PROD_SERVICE"; do
  # First install may legitimately have no production unit. Other errors and
  # activating/deactivating states fail closed before stopping any timer or
  # fetching/replacing shared controller code.
  if ! state=$(systemctl show "$service" -p LoadState -p ActiveState -p Job); then
    if [[ $service != "$PROD_SERVICE" ]] || ! grep -qx 'LoadState=not-found' <<< "$state"; then
      fail "unit 状態を確認できません: $service"
    fi
  fi
  if [[ $service == "$PROD_SERVICE" ]] && grep -qx 'LoadState=not-found' <<< "$state"; then
    if ! grep -Eq '^ActiveState=(inactive|failed)$' <<< "$state" || ! grep -Eq '^Job=(0)?$' <<< "$state"; then
      fail "未配置 unit に未完了の状態があります: $service"
    fi
    continue
  fi
  if ! grep -qx 'LoadState=loaded' <<< "$state" ||
      ! grep -Eq '^ActiveState=(inactive|failed)$' <<< "$state" || ! grep -Eq '^Job=(0)?$' <<< "$state"; then
    fail "supervisor が静止していません: $service"
  fi
done
for timer in $TIMERS; do
  if systemctl is-active --quiet "$timer"; then
    echo "残っている cutoff タイマーを止めます: $timer（ランは動いていません）"
    systemctl stop "$timer"
  fi
done
if ! python3 - <<'PYEOF'
import json
with open('/etc/suiba-paper-check/policy.json') as source:
    policy = json.load(source)
assert policy == {'enabled': True, 'mode': 'sui-30m'}, policy
PYEOF
then
  fail 'policy.json が想定と違います（enabled=true / mode=sui-30m のはずです）'
fi
echo 'policy.json OK（このスクリプトは変更しません）'

echo '== 2/5 ファイルを取得して検証 =='
for entry in "${FILES[@]}"; do
  IFS='|' read -r name sha target mode <<< "$entry"
  curl -fsSL "$BASE_URL/$name" -o "$tmp/$name" || fail "$name の取得に失敗"
  printf '%s  %s\n' "$sha" "$tmp/$name" | sha256sum -c - >/dev/null || fail "$name の sha256 が一致しません"
  echo "取得 OK: $name"
done
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$tmp/controller.py" || fail 'controller.py の構文検証に失敗'
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$tmp/watchdog.py" || fail 'watchdog.py の構文検証に失敗'
visudo -cf "$tmp/suiba-paper-check.sudoers" >/dev/null || fail 'sudoers の構文検証に失敗'

echo '== 3/5 配置（旧ファイルはバックアップ） =='
for entry in "${FILES[@]}"; do
  IFS='|' read -r name sha target mode <<< "$entry"
  if [[ -e $target ]]; then
    cp -a "$target" "$target.bak-$stamp"
    echo "バックアップ: $target.bak-$stamp"
  fi
  install -o root -g root -m "$mode" "$tmp/$name" "$target"
  echo "配置: $target"
done

echo '== 4/5 配置後の検証 =='
for entry in "${FILES[@]}"; do
  IFS='|' read -r name sha target mode <<< "$entry"
  printf '%s  %s\n' "$sha" "$target" | sha256sum -c - >/dev/null || fail "配置後の sha256 が一致しません: $target"
done
echo '配置後の sha256: 全ファイル一致'
systemctl daemon-reload || fail 'daemon-reload に失敗'
unit_paths=()
for unit in $UNITS; do unit_paths+=("/etc/systemd/system/$unit"); done
systemd-analyze verify "${unit_paths[@]}" || fail 'systemd ユニットの検証に失敗'
for unit in $UNITS; do
  [[ $(systemctl show "$unit" -p LoadState --value) == loaded ]] || fail "ユニットが loaded になりません: $unit"
done
echo 'systemd ユニット: 全て loaded'

echo '== 5/5 実経路スモーク（suiba-deploy から status を1回読む） =='
printf '%s' '{"operation":"status"}' > "$tmp/status-request.json"
if ! su -s /bin/sh suiba-deploy -c 'sudo -n /usr/local/sbin/suiba-paper-check' \
    < "$tmp/status-request.json" > "$tmp/status.json" 2> "$tmp/status.err"; then
  fail 'status スモークが失敗しました（ファイルは配置済みで、バックアップから戻せます）'
fi
if ! python3 - "$tmp/status.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as source:
    payload = json.load(source)
run = payload['run']
assert run['status'] in ('in_progress', 'finishing', 'completed', 'failed_requires_review')
print('status スモーク OK: 現在のラン状態 =', run['status'], '/ 時間 =', run.get('duration', '30m'))
PYEOF
then
  fail 'status スモークの応答が想定と違います'
fi

echo
echo '完了しました。検証ランは開始ワークフロー（START-PAPER）で 30m / 6h / 24h を選べます。'
echo '本番 service は配置のみです。prod-policy.json は変更せず、本番運転も開始していません。'
echo 'watchdog timer も配置のみです。有効化は切替時に明示操作してください。'
echo 'シロ（Muse）に「終わった」と伝えてください。'
