#!/usr/bin/env bash
# One-time host setup for the broker's CI approval mode.
#
# Run once on the VPS as root (sudo bash setup-ci-approval.sh). It:
#   1. fetches the current broker.py from the public repository and
#      installs it only if its sha256 matches the pinned digest;
#   2. creates /opt/suiba/shared/runtime.env and admin-token when
#      missing (existing files are never overwritten);
#   3. fetches docker/compose.vps.yaml from the repository, verifies
#      its pinned sha256 and installs it as the policy compose at
#      /etc/suiba-deploy/compose.yaml (with the optional "prod"
#      argument, docker/compose.vps-prod.yaml is installed instead);
#   4. adds "approval_source": "ci" to /etc/suiba-deploy/policy.json
#      and sets compose_sha256 to the installed compose's digest
#      (helper_image is left untouched).
# Backups of replaced files are kept next to the originals.
# The script is idempotent: a second run reports "already present"
# for everything it created the first time.
set -Eeuo pipefail
umask 077

BROKER_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/broker/broker.py'
BROKER_SHA256='b95201b97b733c12d0c4d21c14a192c02a024379ad467217c250f93b1de2f3b5'
BROKER_TARGET='/usr/local/libexec/suiba-deploy-broker.py'
# The policy compose is the repository's docker/compose.vps.yaml, or
# docker/compose.vps-prod.yaml when the "prod" variant is selected.
# Update these pins in the same commit as any compose change.
COMPOSE_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/docker/compose.vps.yaml'
COMPOSE_SHA256='930add4598baf4b3357c08628d1cc8082cb88014d487ff5b3226c1df643d157d'
COMPOSE_PROD_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/docker/compose.vps-prod.yaml'
COMPOSE_PROD_SHA256='8bdbf50cd8fe577c62f6186a93de040ed4c9395b1621527cb7121e2417c054ed'
COMPOSE_TARGET='/etc/suiba-deploy/compose.yaml'
POLICY='/etc/suiba-deploy/policy.json'
SHARED='/opt/suiba/shared'
GRPC_URL='https://fullnode.mainnet.sui.io:443'

fail() { echo "SETUP_FAILED: $1" >&2; exit 1; }

# Variant selection comes before every other check so that an
# unknown variant is rejected for any caller, root or not.
VARIANT="${1:-paper}"
case "$VARIANT" in
  paper) ;;
  prod)
    COMPOSE_URL="$COMPOSE_PROD_URL"
    COMPOSE_SHA256="$COMPOSE_PROD_SHA256"
    ;;
  *) fail "不明なバリアントです: $VARIANT（paper か prod を指定してください）" ;;
esac

[[ $(id -u) -eq 0 ]] || fail 'rootで実行してください（sudo bash setup-ci-approval.sh）'
[[ -f $POLICY ]] || fail "policy.json がありません: $POLICY"
[[ -d $SHARED ]] || fail "shared ディレクトリがありません: $SHARED"
[[ -d $(dirname "$BROKER_TARGET") ]] || fail 'libexec ディレクトリがありません'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stamp=$(date +%Y%m%d%H%M%S)

echo '== 1/4 broker.py を取得して検証 =='
curl -fsSL "$BROKER_URL" -o "$tmp/broker.py" || fail 'broker.py の取得に失敗'
printf '%s  %s\n' "$BROKER_SHA256" "$tmp/broker.py" | sha256sum -c - >/dev/null || fail 'broker.py の sha256 が一致しません'
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$tmp/broker.py" || fail 'broker.py の構文検証に失敗'
curl -fsSL "$COMPOSE_URL" -o "$tmp/compose.yaml" || fail 'compose.yaml の取得に失敗'
printf '%s  %s\n' "$COMPOSE_SHA256" "$tmp/compose.yaml" | sha256sum -c - >/dev/null || fail 'compose.yaml の sha256 が一致しません'

echo '== 2/4 broker.py と compose.yaml を配置 =='
if [[ -e $BROKER_TARGET ]]; then
  cp -a "$BROKER_TARGET" "$BROKER_TARGET.bak-$stamp"
  echo "旧 broker.py をバックアップ: $BROKER_TARGET.bak-$stamp"
fi
install -o root -g root -m 755 "$tmp/broker.py" "$BROKER_TARGET"
printf '配置後の sha256: '
sha256sum "$BROKER_TARGET" | awk '{print $1}'
if [[ -e $COMPOSE_TARGET ]]; then
  cp -a "$COMPOSE_TARGET" "$COMPOSE_TARGET.bak-$stamp"
  echo "旧 compose.yaml をバックアップ: $COMPOSE_TARGET.bak-$stamp"
fi
install -o root -g root -m 644 "$tmp/compose.yaml" "$COMPOSE_TARGET"
printf 'compose.yaml 配置後の sha256: '
sha256sum "$COMPOSE_TARGET" | awk '{print $1}'

echo '== 3/4 runtime.env と admin-token =='
if [[ -e $SHARED/runtime.env ]]; then
  echo 'runtime.env: 既にあるため変更しません（キー構成だけ確認します。値は出しません）'
  keys=$(cut -d= -f1 "$SHARED/runtime.env")
  for want in MARKET_DATA_PROVIDER DEEPBOOK_RECONSTRUCT_CANDLES SUI_GRPC_URL; do
    grep -qx "$want" <<< "$keys" || echo "  警告: runtime.env に $want がありません"
  done
  while IFS= read -r key; do
    case $key in
      ''|MARKET_DATA_PROVIDER|DEEPBOOK_RECONSTRUCT_CANDLES|SUI_GRPC_URL) ;;
      *) echo "  警告: runtime.env に想定外のキー $key があります" ;;
    esac
  done <<< "$keys"
else
  printf '%s\n' \
    'MARKET_DATA_PROVIDER=deepbook' \
    'DEEPBOOK_RECONSTRUCT_CANDLES=off' \
    "SUI_GRPC_URL=$GRPC_URL" > "$SHARED/runtime.env"
  chown root:root "$SHARED/runtime.env"
  chmod 600 "$SHARED/runtime.env"
  echo 'runtime.env: 作成しました'
fi
if [[ -e $SHARED/admin-token ]]; then
  echo 'admin-token: 既にあるため変更しません（形だけ確認します。中身は出しません）'
  size=$(stat -c %s "$SHARED/admin-token")
  if [[ $size -ge 33 && $size -le 256 ]] && grep -qE '^[0-9a-fA-F]+$' "$SHARED/admin-token"; then
    echo '  admin-token: 形は正常です（中身は出しません）'
  else
    echo "  警告: admin-token の形が想定と違います（サイズ: $size バイト）"
  fi
else
  token=$(openssl rand -hex 32)
  printf '%s' "$token" > "$SHARED/admin-token"
  chown 1000:1000 "$SHARED/admin-token"
  chmod 600 "$SHARED/admin-token"
  echo 'admin-token: 作成しました'
  echo '--- 次の値をパスワード管理などに保存してください（この画面だけに表示されます） ---'
  echo "$token"
  echo '--------------------------------------------------------------------------'
fi

echo '== 4/4 policy.json に approval_source と compose_sha256 を設定 =='
cp -a "$POLICY" "$POLICY.bak-$stamp"
python3 - "$POLICY" "$COMPOSE_SHA256" <<'PYEOF'
import json, re, sys
path = sys.argv[1]
with open(path) as source:
    policy = json.load(source)
assert policy.get('helper_image') and policy.get('compose_sha256'), 'policy に必須キーがありません'
policy['approval_source'] = 'ci'
assert re.fullmatch(r'[0-9a-f]{64}', sys.argv[2]), 'compose_sha256 の形が不正です'
policy['compose_sha256'] = sys.argv[2]
with open(path, 'w') as target:
    target.write(json.dumps(policy, indent=2) + '\n')
PYEOF
python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); assert d["approval_source"] == "ci"; assert d["compose_sha256"] == sys.argv[2]; print("policy OK:", ", ".join(sorted(d)))' "$POLICY" "$COMPOSE_SHA256"

echo '== 補足チェック: shared ディレクトリの所有者と権限 =='
shared_uid=$(stat -c %u "$SHARED")
shared_mode=$(stat -c %a "$SHARED")
echo "shared: uid=$shared_uid mode=$shared_mode"
if [[ $shared_uid -ne 0 ]] || (( (8#$shared_mode & 022) != 0 )); then
  echo '警告: ブローカーは shared が root 所有で、グループ/他者に書込不可であることを要求します。'
  echo 'このままだと初回配置が DIRECTORY_OWNER_MODE で止まる可能性があります。必要なら次を実行してください:'
  echo "  sudo chown root:root $SHARED && sudo chmod 755 $SHARED"
fi

echo
echo '完了しました。シロ（Muse）に「終わった」と伝えてください。'
echo 'こちらで SUIBA_BROKER_ENABLED を ON にして初回配置を dispatch します。'
