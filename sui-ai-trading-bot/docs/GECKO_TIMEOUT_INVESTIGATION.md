# GeckoTerminal通信失敗・PAPER異常停止の調査

調査日：2026-10-21（日本時間）。基準はmain `67ccf1c`。`git fetch origin main` 後の差分は0/0で、稼働コンテナとホストの `api.ts` / `market-data/index.ts` のSHA256も一致しました。実運用コンテナは読み取り専用で調べ、停止・再開・再作成を行っていません。

## A. 原因

### 確定したこと

1. 稼働SQLiteの `operation_events` に `MARKET_UPSTREAM_TIMEOUT` → `ANOMALY UPSTREAM_TIMEOUT` → `STOP UPSTREAM_TIMEOUT` が残っています。運用開始から停止まで180,430msです。Sui/Cetusではなく、GeckoTerminalの市場データ取得経路の例外で停止しています。
2. 修正前 `packages/shared/src/api.ts` の `apiFetch`、244行目は、`rawFetch` の全例外を `UPSTREAM_TIMEOUT` に置き換えます。DNS、TLS、接続拒否、切断でも同じ表示になります。元の原因、URL、処理名、時間は保存されません。この誤分類・診断不足はソースと再現テストで確定です。
3. `apps/worker/src/engine.ts` の `tick` は取得例外を捕捉すると `monitor.failCycle` を呼び、`running: false` とエラーを保存します。3連続エラーの監視とは別に、1回の市場データ取得失敗でも即時停止します。これは既存安全設計で、今回も維持しています。
4. 停止後に市場データ正常取得と `lastHealthyAt` の更新が戻っても、`runtime.running` はfalse、停止理由は残っています。復旧後の自動再開禁止は動作しています。
5. 修正前は応答本文の `arrayBuffer()` が例外分類の外にあり、本文受信中の時間切れは統一した診断になりません。今回この範囲も修正しました。

当時の失敗は応答ヘッダー取得までのfetchで発生したことまでは追跡できます。しかし本当の10秒の期限到達、接続タイムアウト、DNS/TLS/切断のどれだったかは元の例外が捨てられており、確定できません。どの時間足のURLだったかも記録がありません。過去の診断情報を後から復元したとは扱いません。

### 実際のURLと処理

`packages/market-data/src/index.ts` の `discover`（65行目付近）、`candles`（102行目付近）で構築します。すべてGET、SDKは使わずNode fetchで取得します。

- 自動探索：`/api/v2/networks/sui-network/tokens/0x2%3A%3Asui%3A%3ASUI/pools?include=base_token,quote_token`
- 指定プール：`/api/v2/networks/sui-network/pools/{pool}?include=base_token,quote_token`
- 5分・15分足：`/api/v2/networks/sui-network/pools/{pool}/ohlcv/minute?aggregate=5または15&limit=1000&currency=token&token=baseまたはquote&include_empty_intervals=false`
- 1時間足：同じプールの `/ohlcv/hour?aggregate=1&...`

今回のプールは `0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443`。実レスポンスのbaseはNative USDC、quoteはSUIなので `token=quote` です。価格は確定5分足のcloseで、別の価格API呼出しはありません。

ユーザーが診断に使った `/networks/sui/pools?page=1` はアプリのURLではありません。HTTP 404を返しても、その結果だけでアプリのOHLCV取得URLの誤りや接続失敗は判断できません。公式の[GeckoTerminal OpenAPI](https://api.geckoterminal.com/docs/v2/swagger.json)のパスと実際の200応答で確認しました。

### Windows / Docker実通信

追加の実API診断は合計5回のGETに限定しました。既存Workerの定期取得は別です。TLS確認はHTTPリクエストを送らずハンドシェイクだけ実行しています。

| 試験 | 結果 |
| --- | --- |
| Windows Node・正しいプールGET | 200、1,020ms |
| Docker Node・同じプールGET | 200、245ms |
| Windows curl・実際の5分OHLCV URL | 200、354ms。DNS58/TCP99/TLS186/先頭応答268ms（開始からの累積値） |
| Docker・実 `GeckoMarketData.candles(300)` | 探索とOHLCVの2GET、999本、362ms、既存の鮮度・OHLC検証を通過 |
| OS名前解決 | 両環境で `104.18.0.233` / `104.18.1.233`（IPv4） |
| IPv6 | DockerのAAAAはENODATA。明示IPv6診断は `SKIPPED_NO_ADDRESS`、HTTPアクセスなし |
| TLS | 両環境・両IPで証明書検証成功、TLSv1.3 |
| プロキシ・追加CA・Nodeオプション | 稼働コンテナの関連環境変数は未設定。値や認証情報は出力していません |
| HTTP 429 | 今回の追加実通信では未観測 |

Windowsの `dns.resolve4/6` はECONNREFUSEDでしたが、OSの `dns.lookup` と実fetchは成功しています。両APIは名前解決の実装が異なります。[Node 24 DNS仕様](https://nodejs.org/docs/latest-v24.x/api/dns.html#implementation-considerations)のとおり、resolve系だけの結果をDockerの障害原因と結び付けていません。

### 未確定事項

- 当時の正確な例外・IP・処理段階・経過時間・時間足。
- 一時的な回線、Dockerネットワーク、接続再利用、CDN、API応答遅延のどれだったか。
- Docker Desktop内部やホストの透過プロキシ/VPN/セキュリティソフトの影響。環境変数が空でも存在しないとは断定できません。
- 持続的な通信不良は今回再現していません。正常応答数回で24時間安定性を証明したとは扱いません。

## B. 修正内容

| ファイル | 変更理由 |
| --- | --- |
| `packages/shared/src/http-errors.ts` | 許可済み原因コードによる分類、公開URLだけを残す診断情報生成 |
| `packages/shared/src/api.ts` | 接続・本文両方の例外処理、API別の最終失敗記録、Requestの中断伝播 |
| `packages/shared/src/index.ts` | 新しい安全なエラーコードとHTTP 404を監視に渡す |
| `apps/worker/src/index.ts` | `UPSTREAM_REQUEST_FAILED` JSONログ。生エラー・ヘッダー・本文・認証情報を出さない |
| `apps/dashboard/src/OperationsPanel.tsx` / `operationLabels.ts` | 日本語で原因、処理、ホスト、段階、所要時間、HTTP状態、発生時刻、秘密除外済みURLを表示 |
| `tests/http-errors.test.ts` | 20件の分類・HTTP・実接続/本文待ち・切断・秘密除外・中断テスト |
| `tests/e2e/operations.pw.ts` | 詳細表示と長いURLの折返しを4画面幅で確認 |
| `tests/settings-api.test.ts` | 実Workerの診断JSON・URL秘匿・トークン非出力を確認 |
| `docker/diagnose-gecko.mjs` | DB/売買を触らず、同じ公開URLで少数の診断を実行 |
| 本手順書・README | 根拠、未確定事項、再試験方法 |

### 分類の意味

- `UPSTREAM_DNS_FAILED`：ENOTFOUND/EAI_AGAIN。
- `UPSTREAM_CONNECT_TIMEOUT`：Undiciが明示する接続期限到達。
- `UPSTREAM_HEADERS_TIMEOUT`：Undiciが明示する応答ヘッダー期限到達。
- `UPSTREAM_BODY_TIMEOUT`：応答本文の受信中の期限到達。
- `UPSTREAM_TLS_FAILED`：証明書・TLS検証の失敗。
- `UPSTREAM_NETWORK_FAILED`：拒否・リセット・切断など。元の分類が不明でも時間切れとは断定しません。
- `UPSTREAM_TIMEOUT`：アプリの期限到達が応答ヘッダー前に起きたもの。接続かヘッダー待ちかを区別できない場合は `HEADERS_OR_CONNECT` と明記します。
- `API_CANCELLED`：停止・終了等による中断。時間切れと混同しません。
- HTTP 404/429/500/503はHTTP状態を保存し、タイムアウトと混同しません。

最終失敗はプロセス内のAPI監視とDockerログに残ります。後で正常取得しても最終失敗情報は保持し、現在の接続状態は別に表示します。監視のプロセス内統計は再起動で初期化されるため、再起動前にログを保存してください。既存SQLiteの停止イベントは維持されます。

タイムアウトは各HTTP試行10秒、同一取得の集約、API別同時通信1件、足20秒キャッシュ、Suiヘルス120秒再利用、見積もり15秒期限を維持しました。429だけ最大2回再試行・バックオフで即時PAPER停止、その他は1回失敗で従来どおり停止します。新しい通常障害リトライ、DNS変更、IPv4強制、TLS検証無効化、タイムアウト延長は追加していません。RiskEngine・Profit Guard・Paper Ledger・緊急停止・売買本体・DBスキーマは変更していません。

## C. テスト結果

| 実行コマンド | 結果 |
| --- | --- |
| `pnpm build` | 型検査・本番ビルド成功 |
| `pnpm test` | 12ファイル・180件成功（従来160＋20） |
| `pnpm test -- tests/settings-api.test.ts` と隔離Linuxでの同テスト | 診断ログの実出力を追加検証、各1件成功（180件中の1件を再検証） |
| `pnpm run test:e2e --config playwright.diagnostics.config.ts` | 一時設定の空きポートで56件成功。375/390/430/1280px。設定は実行後に削除 |
| `node --check docker/diagnose-gecko.mjs` | 成功 |
| `node docker/diagnose-gecko.mjs $url --dns-only` | WindowsのOS名前解決と直接DNSの差を確認 |
| コンテナで同スクリプト `--ipv6` | アドレスなしを確認、HTTPは送信せず |
| `node docker/verify-paper.mjs` | 修正版のLinuxイメージビルド、起動、ヘルス、停止・緊急停止・履歴保持に成功 |
| `node docker/verify-compose.mjs suiba-verify:5012098cb8e2 --browser` | Linux内180件、実ブラウザー、SIGTERM/SIGKILL/再作成、停止保持、WAL・バックアップ、LIVE拒否、専用tmpfs容量不足の検証成功 |

最初の通常 `pnpm run test:e2e` は既存開発サーバーの5174番ポート使用により起動できませんでした。既存サーバーを終了せず、一時設定の空きポートで全件実行しました。

接続/DNS/TLSの異常分類は模擬例外、応答ヘッダー/本文の期限到達と切断はローカルHTTPサーバーで検証しました。実外部APIの障害を意図的に起こしたり、公開APIへ負荷を掛けたりしていません。キャッシュ期限・429上限・古い見積もり・自動再開禁止・再起動保持・Profit Guard/RiskEngine/PAPER専用は既存回帰テストで確認しています。

本番 `docker-bot-1` は既存イメージのままです。専用新規ボリュームだけを使い、実運用履歴は削除していません。今回保持した検証用ボリュームは `suiba-verify-5012098cb8e2-data` と `suiba-compose-verify-9f2791138c79_paper-data` です。

未実施：同じ間欠障害の再発、実際の429、実市場24時間/7日運用、ホスト全体の容量枯渇・停電・ディスク破損。24時間安定化が完了したとは報告しません。

## D. 24時間PAPER再テスト（Windows 11 PowerShell）

### 1. 現在のデータを保存して更新

既存Composeプロジェクト名は `docker`、作業先は次の場所です。プロジェクト名を変えると別ボリュームになります。同じ名前とComposeファイルを使います。修正版はローカルmainにコミットし、GitHubへのpushは別操作です。

画面でPAPER停止を確認してから実行：

```powershell
cd D:\Source\SuiBa\sui-ai-trading-bot
docker compose -p docker -f docker/compose.yaml ps
docker inspect docker-bot-1 --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}'
docker compose -p docker -f docker/compose.yaml stop bot
$backup = Join-Path 'D:\Source\SuiBa-backups' (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $backup -Force
docker compose -p docker -f docker/compose.yaml cp bot:/app/data/. $backup
Get-ChildItem -LiteralPath $backup
```

`bot.sqlite` がコピーされたことを確認。稼働中のDB本体だけをコピーしないでください。DB/WAL/SHMをディレクトリごと保存します。

```powershell
docker compose -p docker -f docker/compose.yaml up -d --build bot
docker compose -p docker -f docker/compose.yaml ps
```

再起動後は停止です。古いエラーや緊急停止も手動解除するまで残ります。`down -v` やボリューム削除を実行しないでください。

### 2. 取得確認と手動開始

http://127.0.0.1:3100 に管理トークンで接続し、次を確認します。

1. MODEはPAPER、安全重視設定・Profit Guard有効を維持。
2. 1～2周期待ち、Sui/Geckoの正常取得と5分足の鮮度、台帳照合を確認。Cetusは必要な時だけアクセスするため「未確認」だけでは異常とは限りません。
3. 元のエラーを確認後、手動で停止解除。PAPERが停止したままを確認。
4. 別操作でPAPER開始。開始時刻を日本時間で記録。
5. 取得確認で再び通信異常が出た場合は開始しない。

```powershell
[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Tokyo Standard Time').ToString('o')
docker compose -p docker -f docker/compose.yaml logs --tail 100 -f bot
```

Ctrl+Cはログ表示だけを終了します。Windowsのスリープを無効にし、Docker Desktopを一時停止しないでください。同時にsmokeや実市場診断を繰り返さないでください。

### 3. 異常停止した場合

PAPERを再開せず、先に記録を保存します。

```powershell
$logs = Join-Path $backup 'paper-docker-logs.txt'
docker compose -p docker -f docker/compose.yaml logs --no-color --timestamps --since 24h bot | Set-Content -LiteralPath $logs -Encoding utf8
Select-String -LiteralPath $logs -Pattern 'UPSTREAM_REQUEST_FAILED'
```

新しいJSONログにはapi、秘密除外済みurl、host、operation、phase、elapsedMs、status、causeCode、occurredAtが入ります。ダッシュボードの最終通信障害も保存します。生のヘッダー、トークン、`.env` はチャットやログに貼らないでください。

診断は同じURLをホストとコンテナで各1回に限定します。以下は今回のプールの実URLです。プールが変わったら新ログの公開URLを使います。

```powershell
$url = 'https://api.geckoterminal.com/api/v2/networks/sui-network/pools/0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443/ohlcv/minute?aggregate=5&limit=1000&currency=token&token=quote&include_empty_intervals=false'
node docker/diagnose-gecko.mjs $url
Get-Content -LiteralPath docker/diagnose-gecko.mjs -Raw | docker exec -i docker-bot-1 node --input-type=module - $url
```

DNSだけなら `--dns-only`、HTTPを送らずTLSだけなら `--tls-only`。必要な場合のみ `--ipv4` / `--ipv6` を指定します。`--ipv6` でアドレスがなければ取得をスキップします。これらは診断専用で、BotのDNS/IPv4/IPv6設定を変更しません。TLS証明書検証は無効にしません。

429ならRetry-Afterと再試行可能時刻に従って待ち、繰り返し診断しません。障害コードを根拠に追加調査し、原因が未確定のまま停止条件を緩めないでください。

### 4. 24時間後

稼働時間・停止イベント・API別エラーと最終正常時刻・古いデータの拒否・残高照合・PAPER履歴を確認します。24時間経過だけで成功とせず、異常停止や照合失敗がないか確認してください。記録後は画面で手動停止し、コンテナ停止後にもう一度DBディレクトリをバックアップします。途中で異常停止した場合、その試行は24時間連続稼働成功には数えません。
