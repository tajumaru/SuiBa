# さくらVPS: Actions専用SSH準備と接続確認（未実施）

基準main: `7cf204a`（PR #32）。既存 `SAKURA_VPS_JA.md` とローカル
`docs/SAKURA_VPS_POST_MERGE_PREPARATION_20261031_JA.md` を参照した具体化手順。
以下は将来の実施例であり、今回は鍵生成・VPS操作・Secrets登録・SSH接続を行っていない。
実VPSへの接続確認は別途明示承認後に限る。

既存Windows用SSH秘密鍵は使わず、必ず新しい専用鍵を生成する。
秘密鍵・管理トークン・認証情報をGit、チャット、Actionsログ、artifactへ出力しない。
mainへの直接コミット、実デプロイ、実Worker/Bot起動、maintenance解除、LIVE取引は禁止を維持する。

## 1. 信頼できるWindows端末で新しい鍵を作る（後日実行）

PowerShell例。作業ディレクトリをリポジトリにせず、専用ファイル名を使う。
同名ファイルが存在したら中止する。既存の `id_ed25519` 等は指定しない。

```powershell
$suibaSshDir = Join-Path $env:USERPROFILE '.ssh'
$suibaKeyPath = Join-Path $suibaSshDir 'suiba-actions-20261031'
if ((Test-Path -LiteralPath $suibaKeyPath) -or (Test-Path -LiteralPath "$suibaKeyPath.pub")) {
    throw '専用鍵が既にあります。上書きせず確認してください。'
}
New-Item -ItemType Directory -Force -Path $suibaSshDir | Out-Null
ssh-keygen -t ed25519 -f $suibaKeyPath -C 'suiba-actions-20261031'
$suibaPrincipal = [Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls.exe $suibaKeyPath /inheritance:r | Out-Null
icacls.exe $suibaKeyPath /grant:r "${suibaPrincipal}:(R)" | Out-Null
ssh-keygen -lf "$suibaKeyPath.pub" -E sha256
```

現行のデプロイ/接続確認workflowは鍵のパスフレーズ解除を実装していない。
その方式を使う専用鍵は、ssh-keygenのパスフレーズ質問で空を2回入力する。
暗号化鍵が必要なら解除方法を別設計にし、既存Windows秘密鍵を転用して解決しない。
ACLは現在ユーザーの読み取りだけを付与する例。継承元以外の既存許可も確認し、
他ユーザーが読み取れるなら登録に進まない。上記fingerprintは公開鍵のものだけで、秘密鍵を表示しない。
鍵ローテーション時は新規鍵→公開鍵追加→承認済み確認→Secrets更新→旧公開鍵失効の順にする。

## 2. VPSコンソール等の承認済み管理経路でユーザー・公開鍵を登録

初期のSSH確認段階は、sudo権限・dockerグループ・秘密情報への読み取り権限を付けない。
既存のホスト準備手順にあるdockerグループ追加は、将来の実デプロイ権限付与の段階の話。
dockerグループはroot相当であり、「最小限の権限」とは扱わない。
現行deploy-vps.shはDockerアクセスを必要とするため、将来はその広い権限を明示承認するか、
root所有の限定デプロイラッパー等を別PRで設計・検証する必要がある。広いNOPASSWD sudoは付けない。

VPSの信頼できるコンソールで、既存同名ユーザーがいないことを確認してから実施する例:

```bash
getent passwd suiba-deploy
# 存在しないことを確認した場合だけ、以下を実施する。
sudo adduser --disabled-password --gecos '' suiba-deploy
sudo install -d -o suiba-deploy -g suiba-deploy -m 700 /home/suiba-deploy/.ssh
sudo install -d -o root -g root -m 755 /opt/suiba
sudo install -d -o suiba-deploy -g suiba-deploy -m 700 /opt/suiba/releases
sudo install -d -o root -g root -m 700 /opt/suiba/shared /opt/suiba/backups
```

接続確認段階では書き込み権限をreleasesだけに限定し、shared/backupsはroot管理のままにする。
将来の実デプロイではlock/backup書き込み等の追加権限が必要であり、今回の確認では付与しない。
既存ディレクトリやユーザーがある場合は一括chown・上書きをせず、所有者/用途を調べる。
VPS側の管理用エディタで `/home/suiba-deploy/.ssh/authorized_keys` に**新規公開鍵の1行だけ**を追加する。
キー行の先頭に `restrict ` を付ける（PTY・転送等を禁止、通常の非対話コマンドは許可）。
公開鍵の取得元は `suiba-actions-20261031.pub` のみ。秘密鍵ファイルを送信しない。
既存authorized_keysがあれば保持して追記し、別ユーザーの認証設定には触れない。

```bash
sudo chown suiba-deploy:suiba-deploy /home/suiba-deploy/.ssh/authorized_keys
sudo chmod 600 /home/suiba-deploy/.ssh/authorized_keys
sudo ssh-keygen -lf /home/suiba-deploy/.ssh/authorized_keys -E sha256
id -nG suiba-deploy
sudo -l -U suiba-deploy
sudo /usr/sbin/sshd -t
```

合格条件: 新規公開鍵fingerprintが手元と一致、.ssh=700/authorized_keys=600、
sudo許可なし、dockerグループなし。鍵認証が既に利用可能ならsshd設定を変更する必要はない。
専用ユーザーに対するsshd Match設定を追加する場合は、PublickeyAuthentication=yes、
PasswordAuthentication=no、KbdInteractiveAuthentication=no、DisableForwarding=yes、PermitTTY=noを
検討し、`sshd -t` と `sshd -T -C user=suiba-deploy,addr=<接続元IP>,host=<接続元名>` で検証してから反映する。
現在の管理セッションを閉じず、コンソールで復旧可能な状態を維持する。
ホーム/.ssh以外のファイル編集やコンテナ起動を、接続確認の合格条件にしない。

## 3. SSHサーバーのホスト鍵を独立経路で照合

VPSコンソールで次を確認する。これはログイン用公開鍵とは別物。

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

接続確認の承認後、手元PowerShellでホスト公開鍵候補を取得する例。
`ssh-keyscan` 自体もVPSへのネットワーク接続なので、今回は実行しない。

```powershell
$suibaVpsHost = '<VPSのDNS名またはIPv4>'
$suibaVpsPort = 22  # 実際のSSHポート
$suibaKnownHosts = Join-Path $suibaSshDir 'suiba-actions-known-hosts'
if (Test-Path -LiteralPath $suibaKnownHosts) { throw '照合済みファイルを上書きしないでください' }
ssh-keyscan -T 10 -t ed25519 -p $suibaVpsPort $suibaVpsHost 2>$null |
    Set-Content -Encoding ascii -LiteralPath $suibaKnownHosts
ssh-keygen -lf $suibaKnownHosts -E sha256
```

SHA256 fingerprintをコンソールの値と人が照合し、一致したときだけ採用する。
取得成功だけでは信頼しない。不一致なら中止し、StrictHostKeyCheckingを無効にしない。
DNSとIPを取り違えず、22以外では `[HOST]:PORT` のエントリーが必要。
提案workflowはEd25519ホスト鍵だけを許可する。サーバーが提供しない場合は設定を確認する。

## 4. Environment「sakura-vps」を保護する

Repository Settings → Environments → sakura-vps。名前の誤りで未保護の別Environmentを作らない。

- Deployment branches/tags: Selected branches and tagsで、Branchの `main` だけを許可する。タグは許可しない。
- 利用できる場合はRequired reviewersを設定し、自己承認と管理者bypassを禁止する。
- Private repoのプランによってはEnvironmentや承認機能を利用できないため、実際の画面で確認する。
  利用不可なら保護済みと扱わず、代替承認手順を決めるまで鍵を利用可能にしない。
- 専用workflowはRepository variable `SUIBA_SSH_CHECK_ENABLED` が文字列 `true` のときだけ動く。
  最初は未設定または `false` のままにする。Environment variableではない（job開始前の条件で評価するため）。
- 接続確認の別途承認、Draft PRのレビュー/マージ、保護設定の確認が済んでからだけ有効化する。
  試験のためにmain以外の許可やEnvironment保護の緩和を行わない。
- 試験後はRepository variableを `false` に戻し、常時有効にしない。

## 5. Environment Secretsへ登録する

以下は `sakura-vps` のEnvironment secretsへ登録する。Repository/Organization secretsへ複製しない。
管理トークンは含めない。GitHub CLIを使う場合は別途インストール・本人認証が必要。

| Secret          | 登録値                      | 入力時の注意                                           |
| --------------- | --------------------------- | ------------------------------------------------------ |
| VPS_HOST        | VPSのDNS名またはIPv4        | URL、ユーザー名、ポートなし。現行コードはIPv6非対応    |
| VPS_USER        | suiba-deploy                | rootではなく専用ユーザー                               |
| VPS_PORT        | SSHポート                   | 数字1〜65535                                           |
| VPS_SSH_KEY     | 新規生成した専用秘密鍵全文  | 改行・ヘッダー/フッターを保持。既存Windows秘密鍵は禁止 |
| VPS_KNOWN_HOSTS | 独立照合済みknown_hostsの行 | 実接続の名前/IP/ポートと一致させる                     |

PowerShell例（パイプで入力し、秘密鍵を端末表示・引数展開しない）:

```powershell
Get-Content -Raw -LiteralPath $suibaKeyPath |
    gh secret set VPS_SSH_KEY --repo tajumaru/SuiBa --env sakura-vps
Get-Content -Raw -LiteralPath $suibaKnownHosts |
    gh secret set VPS_KNOWN_HOSTS --repo tajumaru/SuiBa --env sakura-vps
gh secret set VPS_HOST --repo tajumaru/SuiBa --env sakura-vps
gh secret set VPS_USER --repo tajumaru/SuiBa --env sakura-vps
gh secret set VPS_PORT --repo tajumaru/SuiBa --env sakura-vps
gh secret list --repo tajumaru/SuiBa --env sakura-vps
```

残り3項目はCLIの入力プロンプトで設定する。`--body <秘密鍵>` や `Get-Content` 単独表示を使わない。
トランスクリプト、shell trace、デバッグログ、クリップボード履歴等への漏えいにも注意する。
Secret一覧は**名前の存在**だけの確認で、保存値や公開鍵との対応を証明しない。

## 6. 別途承認後だけ行う、デプロイなし・WorkerなしSSH確認

### 手元からの限定確認（未実施）

新規専用鍵と照合済みknown_hostsだけを使う。既存Windows鍵やssh-agentにフォールバックしない。

```powershell
$suibaSshOpts = @('-F', 'NUL', '-i', $suibaKeyPath, '-p', "$suibaVpsPort", '-T', '-n',
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$suibaKnownHosts",
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1')
ssh @suibaSshOpts "suiba-deploy@$suibaVpsHost" `
    'set -eu; test "$(id -u)" -ne 0; test -w /opt/suiba/releases; command -v docker >/dev/null; docker --version >/dev/null; docker compose version >/dev/null; printf "SSH_PREFLIGHT_OK\n"'
```

この例は手元端末用で、ユーザー名/ホスト名を含むSSHエラーをActionsログへ流す例ではない。
接続先の認証情報を含み得るエラーは共有せず、必要なら伏せ字で原因を整理する。
Windows OpenSSHのNUL設定ファイル指定が利用環境で異なる場合は、空の専用設定ファイルを用意して指定する。

### Actionsでの限定確認（今回のDraft PRで提案、未実行）

提案ファイル: `.github/workflows/suiba-ssh-preflight.yml` と `docker/ssh-preflight.sh`。
push/PR/scheduleでは動かない。main、入力 `CHECK-SSH-ONLY`、Repository variable=true、
Environmentの承認条件がそろったときだけ接続する。**今回は有効化・dispatchしない。**

別途承認後にのみ実行する例:

```powershell
gh variable set SUIBA_SSH_CHECK_ENABLED --repo tajumaru/SuiBa --body true
gh workflow run suiba-ssh-preflight.yml --repo tajumaru/SuiBa --ref main -f confirmation=CHECK-SSH-ONLY
# ジョブ完了後（失敗した場合も）無効化する。
gh variable set SUIBA_SSH_CHECK_ENABLED --repo tajumaru/SuiBa --body false
```

成功ログは固定の `SSH_PREFLIGHT_OK` だけ。秘密鍵/ホスト鍵内容、接続先、ユーザー名、
remote stdout/stderrはログやartifactへ出さない。失敗は詳細を伏せた固定エラーにする。
一時認証ファイルはEXIT trapで削除。接続中断/強制runner停止時にも残らない保証はないため、
使い捨てのGitHub-hosted runnerを使い、artifactをアップロードしない。

遠隔で行うのは非root確認、既存ディレクトリの存在/書込可否のtest、Docker CLI/Composeの
バージョン確認だけ。`docker version`（daemon接続）ではなく `docker --version` を使う。
sudo、docker run、compose up、scp、ファイル変更、deploy-vps.sh、Bot API呼出しは含まない。
全コマンド成功と固定応答一致が合格条件。転送、Docker daemon権限、実デプロイの成功は証明しない。

既存 `DEPLOY-PAPER` は実デプロイ経路なので、接続確認目的で実行しない。
GitHub-hosted runnerと管理端末では接続元IPが違う。FW/SSH許可元は実ランナー構成に合わせて確認する。

## 未検証として残すこと

- Actionsから実VPSへの到達性・SSH認証・Environmentの実際の保護/Secret値。
- 将来のDocker実行権限とSFTP転送、台帳移行、実デプロイ。
- 実WorkerフルCI、初回起動・停止・OOM復旧、2GB VPSでの長時間安定性。
- maintenance解除、Bot開始、LIVE取引はいずれも今回の準備に含めない。

## 仕様の参照

- [OpenSSH ssh-keygen](https://man.openbsd.org/ssh-keygen)
- [OpenSSH authorized_keys](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT)
- [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [Dockerグループの権限](https://docs.docker.com/engine/install/linux-postinstall/)
