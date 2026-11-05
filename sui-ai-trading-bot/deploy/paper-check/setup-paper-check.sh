#!/usr/bin/env bash
# Host update for the paper-check supervisor (validation length selection).
#
# Run once on the VPS as root, after the change has landed on main:
#   curl -fsSL https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check/setup-paper-check.sh -o /tmp/setup-paper-check.sh
#   sudo bash /tmp/setup-paper-check.sh
#
# It fetches the controller, the fixed sudo wrapper, the sudoers rule and
# the systemd units from the public repository and installs each file
# only if its sha256 matches the digest pinned below. Replaced files are
# backed up next to the originals (.bak-<timestamp>). The script refuses
# to run while a validation run is active, verifies that policy.json is
# untouched, and after installing it checks the result itself:
# daemon-reload, systemd-analyze verify, LoadState of every unit, the
# installed hashes, and one real status call through the sudo wrapper
# as suiba-deploy. When any pinned file changes, update its digest here
# in the same commit (same discipline as setup-ci-approval.sh).
set -Eeuo pipefail
umask 077

BASE_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check'
POLICY='/etc/suiba-paper-check/policy.json'
SERVICE='suiba-paper-check.service'
TIMERS='suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer'
UNITS='suiba-paper-check.service suiba-paper-check-cutoff.service suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer'

# name|sha256|target|mode
FILES=(
  'controller.py|b2616df70e277071d8717fa9e88ceb65cc405bc96b702253cea2388df6e708bc|/usr/local/libexec/suiba-paper-check.py|755'
  'suiba-paper-check|583c298737449e7ce7a8b42dc424d0c891d12101bef1adee0ebc4daa07010e22|/usr/local/sbin/suiba-paper-check|755'
  'suiba-paper-check.sudoers|54d64fdadf0b38749008c112fc12761e03f633538e526ebe6f37eb4b1ec38607|/etc/sudoers.d/suiba-paper-check|440'
  'suiba-paper-check.service|44efe8db2b1c569fd8c2176002acc76b724d6d4c66fa1df1babb988e63f60e95|/etc/systemd/system/suiba-paper-check.service|644'
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

echo '== 1/5 実行中の検証ランがないことを確認 =='
if systemctl is-active --quiet "$SERVICE"; then
  fail 'paper-check が実行中です。ランが終わってから実行してください'
fi
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
echo 'シロ（Muse）に「終わった」と伝えてください。'
