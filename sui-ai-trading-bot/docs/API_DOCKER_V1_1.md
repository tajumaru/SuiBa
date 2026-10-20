# API安定化・Docker運用 1.1（Windows 11）

この版はPAPER専用です。実SUIの署名・売買・送信は行いません。既存DB・設定・履歴をそのまま使用します。

## 調査結果と制御仕様

調査基準はmain `18ace9f`。既存の `PAPER_OPERATIONS_V1.md` には実市場検証で上流HTTP 429が発生した記録があります。このコードを直接返すのは共有 `jsonFetch` を使うGeckoTerminalです。Suiの失敗は `SUI_READ_FAILED`、CetusのHTTP失敗はSDKで見積もりエラーに変換されます。GeckoTerminalが有力ですが、当時の生ログ・ヘッダーがなくレート枠や同一IPからの他アプリの負荷までは断定できません。

従来は通常60秒周期でSuiメタデータ2件、GeckoTerminalの5分・15分・1時間足3件、初回にプール探索1件。SUI保有時は売却見積もり、BUY候補では購入と逆方向見積もりが追加されます。停止中も監視取得は継続します。設定の最短周期は30秒です。実市場検証ツールや複数コンテナを並行実行すると同じ公開APIへの負荷が増えます。

改善後：

- Suiは読み取り専用gRPC。正常ヘルス確認を120秒共有し、2件/周期のメタデータ取得を削減。以前の250/500msの一律リトライを廃止。
- GeckoTerminalは同一URLの取得を集約。ローソク足は20秒、プール探索は300秒だけHTTP応答をキャッシュ。毎回ローソク足検証を実施し、古い足はキャッシュでも拒否。通常60秒周期では足のHTTP取得数は変わりません。
- API別に同時通信は1件。同一リクエストは処理中・再試行待機中も1つのPromiseを共有。異なるAPIは独立。
- HTTP応答本文まで含めて試行ごと10秒で中断。タイムアウトした通信を残したまま次の試行を開始しません。429以外はその場で失敗し既存の安全停止に従います。
- HTTP 429は検出直後にPAPER停止をDBへ保存し、キャッシュを無効化。API取得のみ最大2回再試行（初回込み3回）。復旧してもPAPERを自動再開しません。
- `Retry-After` は秒数とHTTP日時を解釈。欠落・不正時は1秒、2秒の指数待機。正のジッターは基準待機の25%か1秒の小さい方まで、総待機は最大60秒。
- 60秒を超えるサーバー指定は、短縮してアクセスせず自動試行を打ち切ります。指定時刻まで異常解除を拒否。上限到達後は明示的な手動解除が必要です。最終429の後にも再アクセス禁止時刻を保持します。
- API別のクールダウン・上限状態はSQLiteに保存し再起動で引き継ぎ。画面の件数はプロセス起動後の集計。Cetus内部の追加通信もCetusとして集計し、そのAPI枠を共有します。
- Cetus SDKにはfetch注入機能がないため、AsyncLocalStorageでSDK呼び出しの非同期処理内だけHTTP捕捉を適用。SDK更新時はこの経路を再検証してください。見積もりの結果キャッシュはありません。
- 停止・緊急停止は待機と独立して処理。SIGTERMは待機とHTTPを中断し、処理終了後にDBを閉じます。約定直前にも停止状態、足の鮮度、見積もり期限を再検証します。

Profit Guard、RiskEngine、PAPERの台帳照合ルールは維持します。利用制限中は損切りも含め新規約定しません。

## 初回セットアップ

1. Windows 11にGitとDocker Desktopをインストールします。Docker DesktopでWSL 2バックエンドとLinuxコンテナを使用します。起動してEngineが準備できるまで待ちます。
2. PowerShellで次を実行します。既に取得済みなら、そのフォルダーで変更を確認してからmainを更新してください。既存作業を上書きしないでください。

```powershell
git clone https://github.com/tajumaru/SuiBa.git
cd SuiBa\sui-ai-trading-bot
Copy-Item .env.example .env
notepad .env
```

3. `.env` の `MODE=PAPER` を維持します。`ADMIN_TOKEN` に32文字以上の十分にランダムな値を設定します。次のコマンドで生成した値を自分の端末内だけでコピーしてください。チャットやログに貼らないでください。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

この生成コマンドだけはローカルNode.js 24が必要です。Nodeがない場合はパスワード管理ソフトのランダム生成機能を使えます。

`SUI_GRPC_URL` は既定のHTTPS URLで開始できます。`MARKET_POOL` は空欄でSUI/Native USDCを自動探索します。`READ_ONLY_ADDRESS` は任意の公開アドレスで、秘密鍵は設定しません。コンテナ内のDBパス・PAPERモードはComposeで固定しています。

## 起動とPAPER運用開始

```powershell
docker version
docker compose -f docker/compose.yaml config --quiet
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml ps
```

ブラウザーで http://127.0.0.1:3100 を開き、管理トークンを入力して接続します。PC外には公開しません。「運用検証」でAPI取得時刻・遅延・照合状態を確認し、設定を確認してからPAPER開始を押します。初期状態とコンテナ再起動後は必ず停止です。緊急停止やエラーが残る場合は原因を解消して異常解除を行い、停止状態を確認してから別操作で開始します。

## ログ・停止・再起動

```powershell
docker compose -f docker/compose.yaml logs --tail 100 -f bot
```

ログ表示終了はCtrl+Cです。Bot自体は停止しません。通常停止は先に画面で停止し、その後コンテナを停止します。

```powershell
docker compose -f docker/compose.yaml stop
docker compose -f docker/compose.yaml start
```

コンテナだけを再起動する場合：

```powershell
docker compose -f docker/compose.yaml restart bot
```

再起動後にPAPER開始を押すまでは売買しません。緊急停止は維持されます。ログは10MB×3ファイルでローテーションします。ComposeのヘルスチェックはWorkerの応答と監視の生存を確認するものです。安全停止中も正常なコンテナと判定します。Dockerのunhealthy判定だけで自動再起動はされません。

## DBバックアップ

SQLite本体とWAL/SHMを同じ永続ボリュームに保持します。稼働中の `bot.sqlite` だけをコピーしないでください。簡単な方法は停止後にデータディレクトリ全体をコピーすることです。

```powershell
docker compose -f docker/compose.yaml stop bot
$backupFolder = Join-Path (Get-Location) ("backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $backupFolder
docker compose -f docker/compose.yaml cp bot:/app/data/. $backupFolder
Get-ChildItem $backupFolder
docker compose -f docker/compose.yaml start bot
```

バックアップ先にDBファイルがあることを確認します。起動後は再び手動開始が必要です。復元時もBotを停止し、現行データを別にバックアップしてから行ってください。`docker compose down -v` やDocker Desktopのボリューム削除は履歴を消すため実行しないでください。

## 429発生時

1. 画面の「APIの利用制限に達しました」を確認し、PAPERが停止していることを確認。
2. API別の429件数、リトライ、バックオフ、再試行可能時刻を見る。時刻前に解除・再起動を繰り返さない。
3. 他のBot・実市場検証コマンドの同時実行を止め、必要なら取得周期を長くする。同じ公開APIを使うPC内外の処理も影響します。
4. 上限未到達なら取得だけが再試行されます。上限到達時は指定時刻後に異常解除。これはAPI試行枠を解除する操作で、売買開始ではありません。
5. 次の監視周期で正常取得とデータ鮮度を確認。必要なら緊急停止状態を保持したまま待ち、原因解消後に異常解除、別操作でPAPER開始。

API復旧やバックオフ終了だけでPAPERは開始しません。過去の価格表示が残っていても、その価格で約定を許可するものではありません。

## Docker更新・容量不足

更新前はPAPER停止→コンテナ停止→上記バックアップを実施。同じフォルダー・同じComposeプロジェクト名で `up -d --build` を実行します。フォルダー名や `-p` を変えると別のボリュームが作成され、履歴が消えたように見えることがあります。既存ボリュームを削除しないでください。

`docker system df` とWindows/WSLのディスク空き容量を確認します。SQLite書込み・照合失敗時は売買継続を許可せず停止/プロセス終了となり得ます。再起動しても停止で立ち上がります。DBを削除して復旧しようとせず、停止して空き容量を確保し、バックアップと履歴・台帳照合を確認してください。ディスク枯渇時には停止理由自体を書き込めない可能性があります。SQLiteはWALと `synchronous=FULL` を使用しますが、ホスト障害やディスク破損からの復旧にはバックアップが必要です。

## 検証方法と制約

```powershell
pnpm build
pnpm test
pnpm run test:e2e
node docker/verify-paper.mjs
```

最後はDocker専用の任意テストです。プロジェクトルート（この手順の `sui-ai-trading-bot`）で実行します。専用イメージ・ランダム名の新規ボリュームとコンテナを作り、Linux起動、ヘルス、再起動時停止、緊急停止・履歴保持を確認します。ネットワーク異常下で動かし、実市場売買はしません。終了時に専用コンテナだけ削除し、検証用ボリュームとイメージは残して名前を表示します。実運用ボリュームは触りません。

この実装環境にはDocker CLI/Desktopがなく、Dockerビルド・Linux起動・容量枯渇の実機試験は未検証です。Windows上のNodeプロセスでの起動・再起動とSQLite保持の回帰テスト、模擬HTTPサーバーの429・タイムアウト、ブラウザー表示を検証します。実APIの割当枠は共有IPや提供者側の変更で変わります。複数プロセス間の同時接続制限は共有しません。

## 今回の検証結果

2026-10-21、Windows / Node.js 24.14.0で実行しました。実運用DBは使用せず、一時DB・メモリDB・模擬HTTPを使用しています。実市場APIへの追加の疎通試験・長時間連続運用は実施していません。

| 検証 | 結果 |
| --- | --- |
| `pnpm build` | 型検査と本番ビルド成功。既存Zodのpure注釈警告のみ |
| `pnpm test` | 11ファイル・160件成功。API関連15件、約定直前の停止・期限境界3件を追加 |
| `pnpm run test:e2e` | Chromium、375/390/430/1280pxで52件成功。429表示4件を追加 |
| `node --check docker/verify-paper.mjs` | 構文検証成功 |
| Dockerビルド・コンテナ再起動・永続ボリューム | Docker未導入のため未実施。任意統合スクリプトを追加 |
| Profit Guard / RiskEngine / PAPER専用 | 既存回帰テスト成功。LIVE起動拒否も確認 |

要求された安全性の対応：429検出・Retry-After・指数待機・ジッター上限・最大試行・集約・キャッシュ期限は `api-access.test.ts`。古い足・古い見積もり・停止・緊急停止は `core.test.ts` / `operations.test.ts`。API復旧後の停止維持は `api-access.test.ts`。プロセス再起動とSQLite履歴は `settings-api.test.ts` / `operations.test.ts`。Docker固有の停止維持・履歴保持はスクリプト追加までで、実行成功とはしていません。

## 変更ファイル

パスは `sui-ai-trading-bot/` からの相対パスです。

| ファイル | 変更内容 |
| --- | --- |
| `packages/shared/src/api.ts` | API別制御、429、待機、集約、キャッシュ、統計、HTTP中断 |
| `packages/shared/src/sdk-requests.ts` | Cetus SDKの非同期呼び出しに限定したHTTP捕捉 |
| `packages/shared/src/index.ts` | GeckoTerminal共通取得を新制御に接続、安全なエラーコード |
| `packages/sui-client/src/index.ts` | gRPCの共通制御と120秒のヘルス再利用 |
| `packages/dex-router/src/index.ts` | Cetus見積もりをHTTP捕捉に接続 |
| `packages/database/src/index.ts` | WAL維持、同期書込みFULL |
| `apps/worker/src/engine.ts` | 429直後の永続停止、約定直前の停止・鮮度再確認 |
| `apps/worker/src/index.ts` | クールダウン復元、解除・開始ゲート、SIGTERMの中断とDB終了 |
| `apps/worker/src/operations.ts` | 監視APIへのAPI別統計追加 |
| `apps/dashboard/src/OperationsPanel.tsx` | 日本語API監視表示 |
| `apps/dashboard/src/operationLabels.ts` | 制限・待機・上限の日本語理由 |
| `tests/api-access.test.ts` | API制御と実HTTPの15件 |
| `tests/core.test.ts` | 最終非同期検証中の停止・期限切れ3件 |
| `tests/e2e/operations.pw.ts` | 429のブラウザー表示 |
| `docker/verify-paper.mjs` | 実運用データから隔離した任意Docker統合検証 |
| `docs/API_DOCKER_V1_1.md` / `README.md` | 運用手順、調査根拠、仕様、検証範囲 |

既存 `docker/compose.yaml` とDockerfileは調査のうえ変更不要と判断しました。Linux用Node 24イメージ、非root実行、データディレクトリ全体のボリューム、init、30秒終了猶予、ヘルス、ログローテーション、localhost公開を維持しています。今回の改善はWorkerのシグナル処理・SQLite書込み・運用検証に限定しています。
