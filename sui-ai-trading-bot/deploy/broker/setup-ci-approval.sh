#!/usr/bin/env bash
# One-time host setup for the broker's CI approval mode.
#
# Run once on the VPS as root (sudo bash setup-ci-approval.sh). It:
#   1. fetches the current broker.py from the public repository and
#      installs it only if its sha256 matches the pinned digest;
#   2. installs the pinned MemWAL runtime helper, wrapper and sudoers rule;
#   3. creates /opt/suiba/shared/runtime.env and admin-token when
#      missing (existing files are never overwritten);
#   4. fetches docker/compose.vps.yaml from the repository, verifies
#      its pinned sha256 and installs it as the policy compose at
#      /etc/suiba-deploy/compose.yaml (with the optional "prod"
#      argument, docker/compose.vps-prod.yaml is installed instead);
#   5. adds "approval_source": "ci" to /etc/suiba-deploy/policy.json
#      and sets compose_sha256 to the installed compose's digest
#      (helper_image is left untouched).
# Backups of replaced files are kept next to the originals.
# The script is idempotent: a second run reports "already present"
# for everything it created the first time.
#
# Variant guard: when a policy compose is already installed, the
# setup refuses to replace it with a compose whose PAPER_CHECK_MODE
# differs. A bare re-run on the production host would otherwise
# silently downgrade the production compose (sui-prod) to the
# validation one (sui-30m) and re-pin it, after which every
# production start fails the controller's preflight env check.
# Set SUIBA_SETUP_ALLOW_MODE_CHANGE=1 to allow an intentional
# mode change.
set -Eeuo pipefail
umask 077

BROKER_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/broker/broker.py'
BROKER_SHA256='68154c4db86523f9e52d29e67c007e641adf50b4605220b88fc1fccb8deef76e'
BROKER_TARGET='/usr/local/libexec/suiba-deploy-broker.py'
MEMWAL_BASE_URL='https://raw.githubusercontent.com/tajumaru/SuiBa/main/sui-ai-trading-bot/deploy/paper-check'
MEMWAL_HELPER_SHA256='fe44e69329cf53c16d18873c845c03a910169277cfc443a3b9247ea53be4b75e'
MEMWAL_WRAPPER_SHA256='523f942e7105d945f85d398713b07b1d30b0d4bde605ae34e44683f6d64edf93'
MEMWAL_SUDOERS_SHA256='7edfbd82b607b46f600c2d90a04fcfc2dd71f3344681b72620f0ebd3d3470af1'
MEMWAL_HELPER_TARGET='/usr/local/libexec/suiba-memwal-runtime.py'
MEMWAL_WRAPPER_TARGET='/usr/local/sbin/suiba-memwal-runtime'
MEMWAL_SUDOERS_TARGET='/etc/sudoers.d/suiba-memwal-runtime'
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

# Print the PAPER_CHECK_MODE value carried by a compose file
# (empty when the file has no such line).
compose_mode() {
  awk '/^[[:space:]]*PAPER_CHECK_MODE:/ { sub(/^[[:space:]]*PAPER_CHECK_MODE:[[:space:]]*/, ""); print $1; exit }' "$1"
}

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
[[ -d $(dirname "$MEMWAL_WRAPPER_TARGET") ]] || fail 'sbin ディレクトリがありません'
[[ -d $(dirname "$MEMWAL_SUDOERS_TARGET") ]] || fail 'sudoers.d ディレクトリがありません'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
stamp=$(date +%Y%m%d%H%M%S)

echo '== 1/4 broker.py、MemWAL helper、compose.yaml を取得して検証 =='
curl -fsSL "$BROKER_URL" -o "$tmp/broker.py" || fail 'broker.py の取得に失敗'
printf '%s  %s\n' "$BROKER_SHA256" "$tmp/broker.py" | sha256sum -c - >/dev/null || fail 'broker.py の sha256 が一致しません'
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$tmp/broker.py" || fail 'broker.py の構文検証に失敗'
curl -fsSL "$MEMWAL_BASE_URL/memwal-runtime.py" -o "$tmp/memwal-runtime.py" || fail 'MemWAL helper の取得に失敗'
curl -fsSL "$MEMWAL_BASE_URL/suiba-memwal-runtime" -o "$tmp/suiba-memwal-runtime" || fail 'MemWAL wrapper の取得に失敗'
curl -fsSL "$MEMWAL_BASE_URL/suiba-memwal-runtime.sudoers" -o "$tmp/suiba-memwal-runtime.sudoers" || fail 'MemWAL sudoers の取得に失敗'
printf '%s  %s\n' "$MEMWAL_HELPER_SHA256" "$tmp/memwal-runtime.py" | sha256sum -c - >/dev/null || fail 'MemWAL helper の sha256 が一致しません'
printf '%s  %s\n' "$MEMWAL_WRAPPER_SHA256" "$tmp/suiba-memwal-runtime" | sha256sum -c - >/dev/null || fail 'MemWAL wrapper の sha256 が一致しません'
printf '%s  %s\n' "$MEMWAL_SUDOERS_SHA256" "$tmp/suiba-memwal-runtime.sudoers" | sha256sum -c - >/dev/null || fail 'MemWAL sudoers の sha256 が一致しません'
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$tmp/memwal-runtime.py" || fail 'MemWAL helper の構文検証に失敗'
visudo -cf "$tmp/suiba-memwal-runtime.sudoers" >/dev/null || fail 'MemWAL sudoers の構文検証に失敗'
curl -fsSL "$COMPOSE_URL" -o "$tmp/compose.yaml" || fail 'compose.yaml の取得に失敗'
printf '%s  %s\n' "$COMPOSE_SHA256" "$tmp/compose.yaml" | sha256sum -c - >/dev/null || fail 'compose.yaml の sha256 が一致しません'

# Mode-change guard: never silently swap the session mode of an
# already-installed policy compose (see the header note). Checked
# here, before anything is installed, so a refusal changes nothing.
if [[ -e $COMPOSE_TARGET ]]; then
  current_mode=$(compose_mode "$COMPOSE_TARGET")
  candidate_mode=$(compose_mode "$tmp/compose.yaml")
  if [[ $current_mode != "$candidate_mode" ]]; then
    if [[ ${SUIBA_SETUP_ALLOW_MODE_CHANGE:-} == 1 ]]; then
      echo "警告: PAPER_CHECK_MODE を $current_mode から $candidate_mode へ変更します（SUIBA_SETUP_ALLOW_MODE_CHANGE=1 が指定されています）"
    else
      fail "compose の PAPER_CHECK_MODE が変わります（設置済み: $current_mode / 候補: $candidate_mode）。本番と検証の取り違え防止のため中止しました。意図した変更なら SUIBA_SETUP_ALLOW_MODE_CHANGE=1 を付けて再実行してください"
    fi
  fi
fi

echo '== 2/4 broker.py、MemWAL helper、compose.yaml を配置 =='
if [[ -e $BROKER_TARGET ]]; then
  cp -a "$BROKER_TARGET" "$BROKER_TARGET.bak-$stamp"
  echo "旧 broker.py をバックアップ: $BROKER_TARGET.bak-$stamp"
fi
install -o root -g root -m 755 "$tmp/broker.py" "$BROKER_TARGET"
printf '配置後の sha256: '
sha256sum "$BROKER_TARGET" | awk '{print $1}'
for target in "$MEMWAL_HELPER_TARGET" "$MEMWAL_WRAPPER_TARGET" "$MEMWAL_SUDOERS_TARGET"; do
  if [[ -e $target ]]; then
    cp -a "$target" "$target.bak-$stamp"
    echo "旧 MemWAL 配布物をバックアップ: $target.bak-$stamp"
  fi
done
install -o root -g root -m 755 "$tmp/memwal-runtime.py" "$MEMWAL_HELPER_TARGET"
install -o root -g root -m 755 "$tmp/suiba-memwal-runtime" "$MEMWAL_WRAPPER_TARGET"
install -o root -g root -m 440 "$tmp/suiba-memwal-runtime.sudoers" "$MEMWAL_SUDOERS_TARGET"
printf '%s  %s\n' "$MEMWAL_HELPER_SHA256" "$MEMWAL_HELPER_TARGET" | sha256sum -c - >/dev/null || fail '配置後の MemWAL helper が一致しません'
printf '%s  %s\n' "$MEMWAL_WRAPPER_SHA256" "$MEMWAL_WRAPPER_TARGET" | sha256sum -c - >/dev/null || fail '配置後の MemWAL wrapper が一致しません'
printf '%s  %s\n' "$MEMWAL_SUDOERS_SHA256" "$MEMWAL_SUDOERS_TARGET" | sha256sum -c - >/dev/null || fail '配置後の MemWAL sudoers が一致しません'
if [[ -e $COMPOSE_TARGET ]]; then
  cp -a "$COMPOSE_TARGET" "$COMPOSE_TARGET.bak-$stamp"
  echo "旧 compose.yaml をバックアップ: $COMPOSE_TARGET.bak-$stamp"
fi
install -o root -g root -m 644 "$tmp/compose.yaml" "$COMPOSE_TARGET"
printf 'compose.yaml 配置後の sha256: '
sha256sum "$COMPOSE_TARGET" | awk '{print $1}'
echo "compose.yaml の実効 PAPER_CHECK_MODE: $(compose_mode "$COMPOSE_TARGET")"

echo '== 3/4 runtime.env と admin-token =='
if [[ -e $SHARED/runtime.env ]]; then
  echo 'runtime.env: 既にあるため変更しません（キー構成だけ確認します。値は出しません）'
  keys=$(cut -d= -f1 "$SHARED/runtime.env")
  for want in MARKET_DATA_PROVIDER DEEPBOOK_RECONSTRUCT_CANDLES SUI_GRPC_URL SUIBA_SHADOW_ENABLED SUIBA_SHADOW_API_KEY SUIBA_MEMWAL_ENABLED MEMWAL_PRIVATE_KEY MEMWAL_ACCOUNT_ID MEMWAL_RELAYER_URL MEMWAL_NAMESPACE; do
    grep -qx "$want" <<< "$keys" || echo "  警告: runtime.env に $want がありません"
  done
  while IFS= read -r key; do
    case $key in
      ''|MARKET_DATA_PROVIDER|DEEPBOOK_RECONSTRUCT_CANDLES|SUI_GRPC_URL|SUIBA_SHADOW_ENABLED|SUIBA_SHADOW_API_KEY|SUIBA_MEMWAL_ENABLED|MEMWAL_PRIVATE_KEY|MEMWAL_ACCOUNT_ID|MEMWAL_RELAYER_URL|MEMWAL_NAMESPACE) ;;
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
