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
# The needrestart drop-in is also pinned. It is installed when absent,
# left untouched when identical, and rejected if an existing copy differs.
# prod-policy.json is never installed or enabled here. Production activation
# is a separate explicit cutover operation; installing a unit never starts it.
# It also installs the read-only monitoring identity: user suiba-observe,
# whose only sudo command is the observe wrapper, whose authorized_keys
# entry forces that wrapper, and which the controller itself confines to
# read-only requests (status, plus the fixed public extract of the live
# production databases for the daily review). Its key is pinned below
# like every other file.
set -Eeuo pipefail
umask 077

BASE_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check'
POLICY='/etc/suiba-paper-check/policy.json'
SERVICE='suiba-paper-check.service'
PROD_SERVICE='suiba-prod.service'
TIMERS='suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-2h.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer'
UNITS='suiba-paper-check.service suiba-prod.service suiba-prod-watchdog.service suiba-prod-watchdog.timer suiba-paper-check-cutoff.service suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-2h.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer'

# Cross-setup integrity pin, checked by test_setup.py (not installed here).
# shellcheck disable=SC2034 # Consumed by the cross-setup integrity test.
SETUP_CI_APPROVAL_SHA256='9ea212dfec43baf43a590624b279cf06caa2888b0c9642746cf378689552a364'

# name|sha256|target|mode
FILES=(
  'shadow-runtime.py|b01865234bff5f271b163c97e4023fb3cd1a2582511806a5b8606f4c9d301c8b|/usr/local/libexec/suiba-shadow-runtime.py|755'
  'suiba-shadow-runtime|4a058c1f881c028ebdb573890e540175a0d10ed5cc534b1c5ff2d48c3cdae201|/usr/local/sbin/suiba-shadow-runtime|755'
  'suiba-shadow-runtime.sudoers|39c85055fc1fd995853e06004eafc071727575e0ebfa61de53d06e1573c0bc2e|/etc/sudoers.d/suiba-shadow-runtime|440'
  'export_snapshot.py|1649b22aa44dd033636f1ea389cb612a0116689e3f52745c58a642d28ad55e10|/usr/local/libexec/suiba-paper-export.py|755'
  'controller.py|e948ef4612b3d7269da85cedc86833bb3aec473114ea2e86817c19bb06a72e98|/usr/local/libexec/suiba-paper-check.py|755'
  'suiba-paper-check|583c298737449e7ce7a8b42dc424d0c891d12101bef1adee0ebc4daa07010e22|/usr/local/sbin/suiba-paper-check|755'
  'suiba-paper-check.sudoers|54d64fdadf0b38749008c112fc12761e03f633538e526ebe6f37eb4b1ec38607|/etc/sudoers.d/suiba-paper-check|440'
  'suiba-paper-observe|583c298737449e7ce7a8b42dc424d0c891d12101bef1adee0ebc4daa07010e22|/usr/local/sbin/suiba-paper-observe|755'
  'suiba-paper-observe.sudoers|6a725a0f8ab853c2f8db4fe176e30ea8a4d337112a0f9ec3f0cea337bdfaabe4|/etc/sudoers.d/suiba-paper-observe|440'
  'suiba-needrestart.conf|0d0ff8114a4c713321cd6082c98a663a02785fcfdf0ebd13fb54d97722de1cc6|/etc/needrestart/conf.d/suiba.conf|644'
  'suiba-paper-check.service|44efe8db2b1c569fd8c2176002acc76b724d6d4c66fa1df1babb988e63f60e95|/etc/systemd/system/suiba-paper-check.service|644'
  'suiba-prod.service|042b393fd872481faffa17d09e57fe7c7a2d57ddb931d609655f4cf29f6ddb02|/etc/systemd/system/suiba-prod.service|644'
  'watchdog.py|85ab96aa3bb402fe549c25ff7b2973c6ad46e4293f65cd235bd112fe88c2b1e3|/usr/local/libexec/suiba-prod-watchdog.py|755'
  'suiba-prod-watchdog.service|88ac174a834219b34d23ee6864ce4c8f676e7b0a72e970ea82c12c1d125f1b0d|/etc/systemd/system/suiba-prod-watchdog.service|644'
  'suiba-prod-watchdog.timer|43e893738a839eb12cfd0fe8fa8b464bcb25e751d2a3ee115b7558e9d70a02cf|/etc/systemd/system/suiba-prod-watchdog.timer|644'
  'suiba-paper-check-cutoff.service|8b40feb7b662796763e53eb6114083233d240d49229027ccea3104c7a628bd96|/etc/systemd/system/suiba-paper-check-cutoff.service|644'
  'suiba-paper-check-cutoff.timer|a9d92ed010eb701ec46bef03b716e973092d696e40890f2e9ddfb2a0a2c96d39|/etc/systemd/system/suiba-paper-check-cutoff.timer|644'
  'suiba-paper-check-cutoff-2h.timer|c71c94fbae4afaf9cce76829de54505f36eb970aeb2b2002bc4d4ba4ea2370c1|/etc/systemd/system/suiba-paper-check-cutoff-2h.timer|644'
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
visudo -cf "$tmp/suiba-paper-observe.sudoers" >/dev/null || fail 'observe sudoers の構文検証に失敗'

visudo -cf "$tmp/suiba-shadow-runtime.sudoers" >/dev/null || fail 'shadow sudoers の構文検証に失敗'
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$tmp/shadow-runtime.py" || fail 'shadow helper の構文検証に失敗'

echo '== 3/5 配置（旧ファイルはバックアップ） =='
install -d -o root -g root -m 755 /etc/needrestart/conf.d || fail 'needrestart 設定ディレクトリを作れません'
for entry in "${FILES[@]}"; do
  IFS='|' read -r name sha target mode <<< "$entry"
  if [[ $name == suiba-needrestart.conf && -e $target ]]; then
    printf '%s  %s\n' "$sha" "$target" | sha256sum -c - >/dev/null ||
      fail "既存の needrestart 設定が想定と違います: $target"
    echo "変更なし: $target"
    continue
  fi
  if [[ -e $target ]]; then
    cp -a "$target" "$target.bak-$stamp"
    echo "バックアップ: $target.bak-$stamp"
  fi
  install -o root -g root -m "$mode" "$tmp/$name" "$target"
  echo "配置: $target"
done
OBSERVE_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPkDaHF4zxvMzkdofBMBwFm0p5WKxN7K6apM6b2H0Ywg suiba-observe'
OBSERVE_AUTHORIZED="restrict,command=\"sudo -n /usr/local/sbin/suiba-paper-observe\" $OBSERVE_KEY"
if ! id suiba-observe >/dev/null 2>&1; then
  useradd --create-home --shell /bin/sh suiba-observe || fail 'suiba-observe の作成に失敗'
  echo '作成: suiba-observe ユーザー（読み取り専用モニター）'
fi
observe_home=$(getent passwd suiba-observe | cut -d: -f6)
observe_group=$(id -gn suiba-observe)
[[ -n $observe_home && -d $observe_home ]] || fail 'suiba-observe のホームを確認できません'
install -d -o suiba-observe -g "$observe_group" -m 700 "$observe_home/.ssh" || fail 'suiba-observe の .ssh を作れません'
printf '%s\n' "$OBSERVE_AUTHORIZED" > "$tmp/authorized_keys"
install -o suiba-observe -g "$observe_group" -m 600 "$tmp/authorized_keys" "$observe_home/.ssh/authorized_keys" || fail 'suiba-observe の authorized_keys を配置できません'
echo '配置: suiba-observe の authorized_keys（status 固定の強制コマンド）'

echo '== 4/5 配置後の検証 =='
for entry in "${FILES[@]}"; do
  IFS='|' read -r name sha target mode <<< "$entry"
  printf '%s  %s\n' "$sha" "$target" | sha256sum -c - >/dev/null || fail "配置後の sha256 が一致しません: $target"
done
echo '配置後の sha256: 全ファイル一致'
grep -qxF "$OBSERVE_AUTHORIZED" "$observe_home/.ssh/authorized_keys" || fail 'suiba-observe の authorized_keys が想定と違います'
echo 'suiba-observe の authorized_keys OK'
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
if ! su -s /bin/sh suiba-observe -c 'sudo -n /usr/local/sbin/suiba-paper-observe' \
    < "$tmp/status-request.json" > "$tmp/observe-status.json" 2> "$tmp/observe-status.err"; then
  fail 'suiba-observe の status スモークが失敗しました（ファイルは配置済みで、バックアップから戻せます）'
fi
python3 - "$tmp/observe-status.json" <<'PYEOF' || fail 'suiba-observe の status 応答が想定と違います'
import json, sys
with open(sys.argv[1]) as source:
    payload = json.load(source)
assert payload['run']['status'] in ('in_progress', 'finishing', 'completed', 'failed_requires_review')
print('observe status スモーク OK')
PYEOF
printf '%s' '{"operation":"diagnose"}' > "$tmp/observe-denied.json"
if su -s /bin/sh suiba-observe -c 'sudo -n /usr/local/sbin/suiba-paper-observe' \
    < "$tmp/observe-denied.json" > /dev/null 2>&1; then
  fail 'suiba-observe で status 以外の操作が通ってしまいました'
fi
echo 'observe scope OK: 許可した読み取り操作以外は拒否'

echo
echo '完了しました。検証ランは開始ワークフロー（START-PAPER）で 30m / 2h / 6h / 24h を選べます。'
echo '本番 service は配置のみです。prod-policy.json は変更せず、本番運転も開始していません。'
echo 'watchdog timer も配置のみです。有効化は切替時に明示操作してください。'
echo 'シロ（Muse）に「終わった」と伝えてください。'
