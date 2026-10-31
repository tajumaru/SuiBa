# さくらVPS運用準備（PAPER限定）

対象: Ubuntu 26.04 LTS / RAM 2GB / SSD 100GB / Docker Engine公式版とCompose v2。
このPRの作成ではVPS操作・実デプロイ・Bot起動を行わない。

## 構成

`docker/compose.vps.yaml` は既存Composeとは独立した固定プロジェクト
`suiba-vps` を使う。既存ダッシュボード・API・通貨ペア・設定・認証・検証機能は
同じイメージとWorkerを利用する。Nodeは既存Dockerfileの24.22.1とdigestを維持し、
実行時バージョンガードも維持する。更新時は24.22.1以上の24系を検証して固定する。

ホストではビルド・pnpm install・テストをしない。Actionsのamd64 Ubuntu runnerで
ビルドし、コミットSHAタグ・revisionラベル・転送チェックサム付きでSSH転送する。
VPSがx86_64であることを `uname -m` で確認すること（ARMは別途対応が必要）。

コンテナ上限は1GiB、V8 old spaceは640MiB、予約512MiB、PID上限128、CPU上限1。
残りをOS・Docker・SSH・ページキャッシュ用に確保する。`memswap_limit` を
メモリ上限と同値にしてコンテナのswap依存を避ける。これは2GBでの長時間安定性の
実測保証ではない。初回運用では `docker stats`、`free -h`、`df -h`、OOM回数・
再起動回数・healthを監視し、PAPER停止状態から段階的に検証する。
ログは10MB×3、tmpfsは64MB。DB・チャート履歴・レポートとリリース/バックアップは
増加するため、空き20GBを目安に通知し、確認済みの古いバックアップ・リリース・
未使用イメージを個別に整理する。自動pruneや自動データ削除は行わない。

## 後日実施するホスト準備

以下は手順書であり、この変更では実行しない。

1. 専用SSHユーザーを作り、鍵認証・ファイアウォール・時刻同期を設定する。
   Docker操作権限はホスト管理者相当として扱う。
2. `/opt/suiba/{shared,releases,backups}` を専用ユーザー所有で作成し、700にする。
3. `/opt/suiba/shared/runtime.env` を600で作成する。`.env.example` の公開接続設定を
   基準に `SUI_GRPC_URL`、`MARKET_DATA_PROVIDER` 等のみを設定する。
   ウォレット秘密鍵やseedは不要。MODE・DBパス・認証パスはComposeが固定する。
4. `/opt/suiba/shared/admin-token` に暗号学的乱数32バイト以上のhex文字列を保存する。
   Composeのローカルsecretはホストファイルのbind mountなので、コンテナUID 1000が
   読める所有者/権限（例: UID1000所有、0400）にする。親ディレクトリは700を維持する。
   トークンをGit、Actionsログ、コマンド引数へ入れない。
5. `suiba-vps-data` と `suiba-vps-reports` の外部ボリュームを明示的に作成する。
   `/app/data` と `/app/reports` の書き込み所有者は既存イメージと同じUID1000。
   Composeはボリュームが存在しなければ失敗する。
6. 既存データを移行する場合は元Workerを正常停止し、データディレクトリ全体を
   コールドバックアップして復元する。SUI/WAL両方、ペア選択、履歴、SQLite WAL/SHM、
   lifecycle、instance lockファイルを含める。稼働中のSQLiteファイルを単純コピーしない。
   元環境と移行先を同時に稼働させない。
7. 空の新規運用では別途承認された初期DB作成が必要。このComposeは
   `REQUIRE_EXISTING_DATABASE=1` を固定し、未初期化DBを起動で自動作成しない。
   初期残高は既存BotDatabaseのデフォルト（各ペア100 USDC相当のPAPER残高）を使う。
   運用開始の承認後、次のオフライン操作でのみ作成する。Workerは起動しない。
   空でないボリューム（maintenanceのみ存在する場合を除く）は必ず拒否する。
   初期化に失敗した部分データを自動で上書き/削除しない。既存台帳の欠落を新規残高で隠さない。

   ```bash
   docker run --rm --network none --read-only --user 1000:1000 \
     --memory 256m --memory-swap 256m --pids-limit 64 \
     --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000 \
     -v suiba-vps-data:/app/data suiba:<承認済みSHA> \
     node --import tsx docker/vps-data.mjs initialize NEW-PAPER-LEDGER
   ```

## GitHub Actions

`SuiBa offline validation` の既存Windows/Linux検証は維持する。
追加workflowはPR/push時に型・build・offlineテスト・shellcheck・Compose構文・
Dockerイメージbuildと、外部通信を遮断した使い捨て環境でのコンテナ検証を行う。
追加の実起動検証はHTTPサーバー・SQLite・メモリ割当のテスト用プロセスのみで、
Worker/engineを起動しない。実Workerを使う既存自動検証とは区別する。
`node docker/verify-vps-config.mjs` は実際に展開したComposeのメモリ上限・
PAPER制限・認証・外部ボリューム等も検査する。既存の `docker/verify-compose.mjs`
による起動/停止/永続化の実結合検証は維持するが、この準備段階では実行しない。

後日 `sakura-vps` Environmentを作り、mainのみ許可し、利用プランで可能なら
Required reviewersを設定する。
Environment secrets: `VPS_HOST`（DNSまたはIPv4）、`VPS_USER`、`VPS_PORT`、
`VPS_SSH_KEY`（専用鍵）、`VPS_KNOWN_HOSTS`（ポートを含むknown_hosts形式）。
ホスト鍵はVPSコンソール等の独立した経路でfingerprintを照合する。
実行中のssh-keyscanによる自動信頼はしない。

mainへのマージ後、明示的な運用承認を得たときだけRun workflowをmainで手動実行し、
`DEPLOY-PAPER` と入力する。pushやPRではSSHジョブは動かない。
管理トークンはVPSにのみ置き、Actionsへ渡さない。

デプロイはホストflockで直列化し、UID1000でmaintenanceファイルをfsyncしてUI開始を禁止する。
maintenance作成前に失敗ハンドラーを登録する。作成に失敗しても既存コンテナの再起動を
禁止し、40秒停止を要求し、失敗時はkillを試みる。Docker自体が利用不能な場合は
停止を保証できないためCRITICALを出して中止し、直ちに運用者が状態確認する。
SIGTERMで40秒待ち、既存コンテナが停止・OOMなし・終了コード0であることを確認する。
40秒でSIGKILLされた137、Worker内部25秒タイムアウトの1、OOMはすべて中止する。
バックアップ中は既存instance lockを保持し、clean lifecycle・停止済みruntime・
全SQLiteのintegrity/foreign keyを検査し、使い捨てディスクボリュームにWAL/SHMを含めて
コピーして復元整合性を確認する。tarは全データを含み、成功後のみ.partialから確定し、
SHA256とfsyncを行う。コピー用ディスクにはデータ量相当の追加空き容量が必要。
失敗時は自動rollbackやBot再開始をしない。health成功後のみcurrentシンボリックリンクを更新する。
初回も再デプロイもmaintenanceは残るため、取引ループは開始しない。
コンテナのhealthyはプロセス正常を表し、取引実行中を意味しない。

## 管理アクセス・停止・復旧

公開listenは127.0.0.1:3100のみ。手元から
`ssh -N -L 3100:127.0.0.1:3100 USER@HOST` を張り、ブラウザでlocalhost:3100を開き、
既存の管理認証を使う。ポート3100をインターネット公開しない。

停止は `/opt/suiba/current` に移動し、`SUIBA_IMAGE=suiba:<SHA>` を指定して
`docker compose -f compose.vps.yaml stop --timeout 40 bot` を使う。
`down -v`、volume rm、稼働中のDB差し替えを行わない。
通常のSIGTERMは停止状態を永続化し、再起動でも自動的に取引を開始しない。
OOM/SIGKILL時も既存Workerの再起動停止・緊急状態維持ロジックが働く。

復旧時はまず停止して原因・終了コード・ログ・空き容量を確認する。
旧リリースのComposeとSHAイメージで戻す場合も、DBスキーマ互換性を確認する。
互換性がない場合は現在データを退避し、停止中に対応するコールドバックアップ全体を
復元してUID1000所有に戻す。外部ボリューム名は変更しない。
maintenanceは意図的に残す。後日運用承認後、停止中に
`bot.sqlite.maintenance` を明示的に除去し、再起動・認証後にhealth/会計を確認して
UIから手動開始する。このPRでは解除も開始もしない。

参考: [Compose services](https://docs.docker.com/reference/compose-file/services/)、
[GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。
