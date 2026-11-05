#!/usr/bin/env bash
# SuiBa paper-check 是正（起動前チェックで死んだラン専用・1回きり）
#
# 対象は「Bot が一度も起動しないまま PREFLIGHT_INCOMPLETE で死んだ」
# ランだけ。証拠が1つでも想定と違えば何も変更せずに失敗する。
# やること: 証拠を /root/reconcile-<時刻> に退避 → 障害ラッチと
# fault ファイルを退避先へ移動 → 停止レシートを clean_stopped に
# 是正 → 公式の approve-retry で再試行を許可する。
#
# 使い方（ホストで root）:
#   curl -fsSL https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check/reconcile-preflight.sh -o /tmp/reconcile-preflight.sh
#   sudo bash /tmp/reconcile-preflight.sh
set -euo pipefail

STATE=/var/lib/suiba-paper-check
DEPLOY_STATE=/var/lib/suiba-deploy
CONTAINER=suiba-vps-bot-1
DATA_VOLUME=suiba-vps-data
CONTROLLER=/usr/local/libexec/suiba-paper-check.py

fail() { echo "RECONCILE_FAILED: $*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'root で実行してください（sudo bash ...）'
for cmd in python3 docker systemctl; do
  command -v "$cmd" >/dev/null || fail "$cmd がありません"
done

json_get() { # file key -> scalar value (empty when absent)
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=d.get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"
}

echo '== 1/4 証拠の確認（1つでも違えば中止） =='
[[ -f $STATE/run.json ]] || fail 'run.json がありません'
run_id=$(json_get "$STATE/run.json" id)
[[ $run_id =~ ^[a-f0-9]{32}$ ]] || fail "run id の形が不正です: $run_id"
[[ $(json_get "$STATE/run.json" status) == 'failed_requires_review' ]] \
  || fail '現行ランが failed_requires_review ではありません'
folder=$STATE/$run_id
[[ -d $folder ]] || fail 'ランのフォルダがありません'

python3 - "$folder/stop.json" "$run_id" <<'PY' || fail '停止レシートが想定と違います（failed_state_unknown / PREFLIGHT_INCOMPLETE のみ是正対象）'
import json, sys
stop = json.load(open(sys.argv[1]))
assert stop.get('id') == sys.argv[2], 'id mismatch'
assert stop.get('status') == 'failed_state_unknown', stop.get('status')
assert stop.get('errors') == ['PREFLIGHT_INCOMPLETE'], stop.get('errors')
PY

# Bot が一度も起動していないこと（起動済みなら DB が動いている可能性があり是正しない）
started_at=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER")
[[ $started_at == '0001-01-01T00:00:00Z' ]] || fail "コンテナが起動済みです（StartedAt=$started_at）"
running=$(docker inspect --format '{{.State.Running}}' "$CONTAINER")
[[ $running == 'false' ]] || fail 'コンテナが実行中です'
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER")
[[ $exit_code == '0' ]] || fail "コンテナの終了コードが 0 ではありません: $exit_code"

# 台帳は配置済み（prepared_stopped）のままであること
[[ $(json_get "$DEPLOY_STATE/ledger.json" status) == 'prepared_stopped' ]] \
  || fail '台帳が prepared_stopped ではありません'

# メンテナンスラッチが残っていること（= worker は停止したまま）
mountpoint=$(docker volume inspect --format '{{.Mountpoint}}' "$DATA_VOLUME")
[[ -f $mountpoint/bot.sqlite.maintenance ]] || fail 'メンテナンスラッチが見えません'

# 実行中の検証ラン・残留タイマーがないこと
systemctl is-active --quiet suiba-paper-check.service && fail '検証サービスが実行中です'
for timer in suiba-paper-check-cutoff.timer suiba-paper-check-cutoff-6h.timer suiba-paper-check-cutoff-24h.timer; do
  systemctl is-active --quiet "$timer" && fail "カットオフタイマーが残っています: $timer"
done
[[ -f $STATE/paper-check-failed.json ]] || fail '障害ラッチ（paper-check-failed.json）がありません'
echo "証拠 OK: run=$run_id は未起動のまま PREFLIGHT_INCOMPLETE で終了"

echo '== 2/4 証拠の退避 =='
backup=/root/reconcile-$(date +%Y%m%d%H%M%S)
mkdir -p "$backup"
cp -a "$STATE/run.json" "$backup/run.json"
cp -a "$folder/stop.json" "$backup/run-stop.json"
[[ -f $STATE/stop.json ]] && cp -a "$STATE/stop.json" "$backup/state-stop.json"
echo "退避先: $backup"

echo '== 3/4 是正（ラッチと fault の移動、レシートの書き換え） =='
mv "$STATE/paper-check-failed.json" "$backup/paper-check-failed.json"
shopt -s nullglob
faults=("$folder"/fault-*.json)
if (( ${#faults[@]} > 0 )); then mv "${faults[@]}" "$backup/"; fi
shopt -u nullglob
python3 - "$run_id" "$folder/stop.json" "$STATE/stop.json" <<'PY'
import json, os, sys, time
value = {'id': sys.argv[1], 'status': 'clean_stopped', 'errors': [], 'at': int(time.time())}
targets = [sys.argv[2]]
if os.path.exists(sys.argv[3]):
    existing = json.load(open(sys.argv[3]))
    assert existing.get('id') == sys.argv[1], 'state stop id mismatch'
    targets.append(sys.argv[3])
for path in targets:
    tmp = path + '.reconcile-tmp'
    with open(tmp, 'w') as out:
        json.dump(value, out)
    os.replace(tmp, path)
PY
echo 'レシートを clean_stopped に是正しました'

echo '== 4/4 公式の再試行許可（approve-retry） =='
out=$(python3 -I "$CONTROLLER" approve-retry "$run_id")
echo "$out"
[[ $out == *PAPER_CHECK_RETRY_APPROVED* ]] || fail 'approve-retry が許可を出しませんでした'
echo
echo 'RECONCILE_OK: 再試行が許可されました。START-PAPER で開始できます。'
echo "シロ（Muse）に「終わった」と伝えてください。"
