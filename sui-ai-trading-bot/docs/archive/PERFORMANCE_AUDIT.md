# SuiBa 全体性能診断・高速化計画

調査日：2026-10-23 JST。対象：`tajumaru/SuiBa / sui-ai-trading-bot`。
本調査で変更するのは本書のみ。実装・デプロイ・設定変更・DB変更は行っていない。

## 1. 結論と監査条件

優先対象は **表示用集計の再計算、同期SQLite処理、履歴ソート、初期JS転送**。
軽量サマリーAPI・差分配信・10秒ポーリング・HTTP/2再利用は実装済みであり、新設しない。
通信失敗時の約8秒／10秒は安全のための期限を含む。期限短縮や復旧条件緩和を高速化策にしない。

### ソースと実行版を区別する

| 対象 | 識別情報・状態 |
|---|---|
| 調査開始時のリモートmain | `bf9c465cb6a5253dfd718c8d2f51f5b5f86fffd2`（Node.jsセキュリティ版指定） |
| 最終固定したリモートmain・ソース監査基準 | `d1b6b7cc22cf5322aee2e14cde5d24498dac468e`、2026-10-23 06:14:48 +09:00。06:19頃の `git ls-remote origin refs/heads/main` とローカルHEADが一致 |
| 調査開始時のローカルHEAD | `bdd9f9eccf3a46f18bf88fdbb7783c02de1fa255`。開始時リモートより4コミット先。未コミット変更あり |
| 運用検証3101 | `suiba-deepbook-24h-bot-1`、イメージ `sha256:b7ddf53183c1c089fb79c852eeb4384a1d6e2e307e1ca9c9ccdd96346ea3ad13` |
| 同コンテナ起動 | `2026-10-22T15:21:26.01139313Z`、内部Node `v24.22.1`、healthy |
| 通常3100 | `docker-bot-1`、イメージ `sha256:307674eac6c5b4b64455c11d616fd94fb913e8967021f9f07a9d5eeba63b26f8`、起動 `2026-10-21T22:06:57.830341055Z`、healthy |
| ホスト計測環境 | Windows、Node `v24.14.0`。指定版24.22.1と異なる。隔離ビルドは既存node_modules（Vite 7.3.7）を参照し、依存関係を再インストールしていない |

調査中に別作業でmain・作業ツリーが更新されたため、Git archiveで固定SHAを別ディレクトリに展開して監査した。
既存の変更は監査対象ソースへ混ぜず、取り消し・ステージングもしていない。

3101内の13ファイルをSHA-256比較した結果、最終基準mainと一致したのは
`packages/database/src/index.ts` のみ。workerのindex/engine/operations/validation/dashboard-feed、
dashboardのmain/OperationsPanel、DeepBookのprovider/transport、shared/api、package.json、lockfileは不一致。
稼働版の正確なGit SHAは未確認。イメージIDだけからコミットを断定しない。
例えばDB実装は両者とも `2d7829c205d4d67bfc8a57992296753d793a168900d19e929f45c657d1969cfa`、
transportは稼働版 `2e5eb2b816e62b4edffb82037370418bbcd15e383862c2518a7ee876414ae640`、
監査ソースの同ファイルは `44a317cf004158d26529c66e055937682db7b75e54a389b2e00d8f472aceb34a`。
したがって、**稼働版実測は最新mainの性能保証ではない**。

### 制約と測定ルール

- Dockerの再起動・再作成、PAPER停止／再開、制御API、実注文は実施していない。
- DBはコンテナ内の `DATABASE_PATH` を `new DatabaseSync(path, {readOnly:true})` で開いた。アプリのDBコンストラクタは初期化・書込みを行うため使用していない。DDL・ANALYZE・VACUUM・チェックポイント・PRAGMA変更なし。
- 実行したSQLは件数確認、既存監査ログの読み取り集計、EXPLAIN QUERY PLAN。既存データのコピーや負荷試験は行っていない。
- HTTP計測は直列、サマリーと運用検証各3回、10秒間隔。records・5分足差分の初回resetを各1回。3100・3101を別に測定。
- ブラウザは3101にデスクトップ幅／モバイル幅で各1回。GET以外を遮断し、接続とタブ選択のみ。自動ポーリングを継続させずコンテキストを閉じた。
- DeepBook公開APIへの追加GETは計7回（status 4回、OHLCV各足1回）。レート制限・障害注入試験なし。追加gRPC通信なし。
- 認証情報・レスポンス全文・取引明細は本書に保存しない。トークンは既存設定からプロセス内だけで利用。
- 以下の「実測」は単発観測または既存記録集計。「推定」「目標」は未検証。キャッシュcold/warmを統制した負荷試験は未実施。

## 2. 速度の現状

### 2.1 フロントエンド

最新固定mainの隔離Vite productionビルド：188 modules、ビルド所要2.58秒。

| 出力 | 非圧縮 | gzip換算 |
|---|---:|---:|
| JS `index-B_eGx8kr.js` | 476.84 kB | 151.84 kB |
| CSS | 10.87 kB | 2.81 kB |
| HTML | 0.43 kB | 0.32 kB |

単位はVite出力のdecimal kB。gzip換算は転送実測ではない。
開始時SHAのJSは470.06 kB／gzip149.99 kBだったが、異なるSHAなので改善前後比較には使用しない。
指定Node版・frozen lockfileによる正規再ビルドは未測定。上記は同じ既存依存関係を使った参考ビルド。

06:25頃、稼働3101のPlaywright Chromium headless、新規context、同一PC、loopback、CPU・回線制限なし：

| 指標 | Desktop 1440×900 | Mobile幅390×844 |
|---|---:|---:|
| 文書ロード完了 | 96.4 ms | 72.2 ms |
| FCP | 204 ms | 164 ms |
| 運用検証タブclick→取得中表示消失＋2 animation frames | 561.5 ms | 266.7 ms |
| その操作中のoperations resource時間 | 340.5 ms | 33.1 ms |
| 最終DOM要素数 | 554 | 554 |
| Long Tasks観測 | 0件 | 0件 |

各n=1。ログイン前のFCPと、認証後タブ内容の表示時間は異なる指標。
ロード完了がFCPより早くても矛盾しない。上記表示時間には自動操作待機も含み、React描画時間そのものではない。
モバイルはviewportのみで実機・低速回線・CPU低速化ではない。順序効果とサーバーキャッシュ差があり、モバイルのほうが速いとは結論しない。
LCP、INP、CLS、React Profilerのcommit回数、チャート単独描画時間、実機モバイル性能は**未測定**。

稼働版初期ロードはJS本文466,313 B、CSS本文10,866 Bで、両方 `encodedBodySize == decodedBodySize`。
静的JS/CSSの圧縮なしを確認。監査ソースの `index.ts` も静的ファイルはreadFile→res.endで、JSONのgzip経路を通らない。
全レスポンスにno-storeが設定されるため、ハッシュ付き静的資産の再訪キャッシュも改善候補。

タブ表示までのブラウザAPIは両画面とも5回：summary 2回、candles 1回、records 1回、operations 1回。
これはOverview接続後に運用検証へ切り替えた経路。運用検証だけの定常負荷と混同しない。
desktopのAPI `transferSize` 合計32,800 B（ブラウザの推定ヘッダー分を含む）。
APIの圧縮本文合計は31,300 B。JS/CSSのtransferSize合計477,779 B。

### 2.2 バックエンドAPI応答

3101測定窓：`2026-10-22T21:15:18.698Z`〜`21:15:39.425Z`。
Node fetch、gzip要求、レスポンス本文全受信まで。JSON.parse時間は別。
nearest-rank（昇順の `ceil(n*p)-1`）を使用。n=3のp95/p99は最大値に一致し、安定したtail推定ではない。

| 3101のGET | n | 全受信ms（採取順） | p50 | 標本p95 / p99 | 展開後本文B | gzip本文B |
|---|---:|---|---:|---:|---:|---:|
| `/api/dashboard/summary` | 3 | 65.16 / 17.42 / 17.43 | 17.43 | 65.16 / 65.16 | 4,067 | 1,512〜1,513 |
| `/api/operations` | 3 | 17.42 / 298.75 / 322.56 | 298.75 | 322.56 / 322.56 | 31,092〜31,101 | 5,853〜5,964 |
| `/api/dashboard/records` | 1 | 4.77 | 参考4.77 | 評価不可 | 6,489 | 922 |
| `/api/dashboard/candles?timeframe=300`（reset） | 1 | 19.47 | 参考19.47 | 評価不可 | 341,884 | 21,539 |

summaryのJSON.parseは0.09〜0.18ms、operationsは0.34〜0.37ms、candlesは2.21ms。
operationsのヘッダー到着は16.61／298.17／321.89msで、本文受信後半やクライアントJSON.parseより前の待ちが支配的。
10秒キャッシュ失効による再集計との整合性はあるが、CPU span未計測なので原因の断定はしない。

3100は別版。healthz 2.98ms、operations 3回は35.94／33.07／30.88ms（p50 33.07、標本p95/p99 35.94ms）、本文約10,083 B、gzipなし。
summaryは3回とも404、records・candlesも404。404応答をサマリーAPIの性能として採用しない。
両系統ともoperationsのstatusは観測時 `ABNORMAL_STOP`。調査開始前からの状態を観測したもので、停止・復旧操作はしていない。
したがって、PAPERが連続実行中のAPI競合性能は**未測定**。

`/api/state`、`/api/validation`、markdown出力、chart/history、balances、backtestその他APIのエンドツーエンドp50/p95/p99は**未測定**。
chart/historyはキャッシュDBへ書き込む可能性があるため、本番への手動プローブ対象にしなかった。

### 2.3 DeepBook・Sui通信

固定ソースのDeepBook HTTP/2 transportを隔離プロセスで使用。Node24.14、Windows側ネットワーク、再試行なし、直列、間隔1秒。
このtransportは成功レスポンスを本文までbufferしてからResponseを返すため、fetch解決時間をTTFBとは呼ばない。

| 公開GET | n | 全受信ms | 本文B |
|---|---:|---:|---:|
| status（新規HTTP/2接続） | 1 | 942.86 | 18,479 |
| status（同一接続再利用） | 1 | 228.04 | 18,467 |
| 5分足 `interval=5m&limit=1000` | 1 | 297.80 | 54,670 |
| 15分足 `interval=15m&limit=1000` | 1 | 256.89 | 37,054 |
| 1時間足 `interval=1h&limit=1000` | 1 | 250.82 | 9,441 |

HTTPは全て200。OHLCV値は通信＋本文bufferであり、parse・検証・再構築・APIキュー待ちは含まない。
足別p50/p95/p99は**未測定**。n=1から分布を推定しない。
statusの再利用観測は約715ms短縮だが、要求順序・DNSキャッシュ・上流変動を統制していないため、因果効果量とは扱わない。

別のHTTP/2 status 1回で取得した段階時間（同一ホスト、Node http2、累積イベントから差分算出）：

| 段階 | ms |
|---|---:|
| DNSイベント到達まで（初期処理含む） | 4,122.09 |
| DNS→TCP接続 | 401.79 |
| TCP→HTTP/2 connect（TLS等含む） | 2,197.17 |
| HTTP/2 connect→レスポンスヘッダー | 約649 |
| ヘッダー→本文終了 | 10.43 |
| 全体 | 7,379.22 |

正常200でも接続段階の大きな変動があった。DNSイベント前の時間を純粋な権威DNSサーバー応答時間と解釈しない。
この補助プローブの2要求目は共有8秒期限に到達し、statusなし／0 Bで終了したため成功標本から除外。
約630msの中断時間を再利用時の応答時間には採用しない。アプリ側の障害や429とは判断できない。
段階別p50/p95/p99、DNS障害注入、ホスト対コンテナの経路比較は**未測定**。

#### 現在の稼働プロセス起動後の既存ログ集計

DBのvalidation_eventsから `timestamp >= operation_state.processStartedAt` に限定。
窓：`1792682490120`〜`1792704131871` epoch ms、採取 `2026-10-22T21:22:12.011Z`。
統計はnearest-rank、1 attempt単位。成功と失敗を分離し、新規通信は発生させていない。

| API / 成否 | n | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|
| DeepBook成功 | 4,407 | 261 | 413 | 1,237 | 6,444 |
| DeepBook失敗 | 8 | 8,002 | 8,006 | 8,006 | 8,006 |
| Sui gRPC成功 | 242 | 387 | 1,318 | 3,129 | 6,489 |
| Sui gRPC失敗 | 2 | 8,007 | 10,002 | 10,002 | 10,002 |

失敗側は少数なのでp99の信頼性は低い。成功分類はAPI通信成功であり、正常鮮度・戦略実行許可を意味しない。
API名での集計であり、エンドポイント・足別の分布ではない。ログのAPI latencyとSDK処理を含むgRPCメソッド全体も別指標。
現在イメージは最新mainと一致しないため、最新の復旧改修そのものの実測は**未測定**。

参考として全保存期間（旧プロセス・旧実装を含む、現行性能には採用しない）では、
DeepBook成功n=16,943のp95/p99は882/1,957ms、失敗n=175は8,008/8,132ms。
gRPC成功n=922は2,368/8,670ms、失敗n=72は10,003/10,004ms。
プロセス窓とのデータ数差を改善効果とは扱わない。

06:15の現在プロセスAPIスナップショットではDeepBook requests=4,329、retries=6、rateLimits=0、
Sui requests=238、retries=0、rateLimits=0。後のログ集計とは採取時刻が異なる。
3100側GeckoTerminalにはrateLimits=3があり、系統を混ぜない。
レート上限の実値・上限到達時性能は**未測定**。上流へ429を起こす試験は行っていない。

### 2.4 Worker

上記と同じ起動後ログ窓。cycleイベントのdurationMsを集計。

| 周期 | n | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|
| errorなし | 358 | 3,648 | 7,526 | 18,795 | 32,461 |
| errorあり | 4 | 10,821 | 36,264 | 36,264 | 36,264 |

errorなしでもWAIT・停止中の監視を含み得るため、PAPER約定処理成功周期の性能とは解釈しない。
market取得・戦略計算・RiskEngine・Profit Guard・PAPER・監査記録の独立spanは**未測定**。
既存のlastFetchDurationMsは単一の最新値であり、周期ごとの分布の代用にはしない。

5分足qualityの `reconstructionMs` をcycleから取り出した参考分布はn=362、p50=1,725、p95=3,039、p99=12,473、max=23,651ms。
ただしqualityは再利用されたスナップショットを含み得る。独立した再構築実行362回の分布ではない。
再構築時間には1分足・trade proof取得の待ちも含み、純粋なCPU時間ではない。

06:17頃の `docker stats --no-stream` 瞬間値：3101 CPU 0.16%、501.8MiB / 15.49GiB、
3100 CPU 0.05%、122.9MiB / 15.49GiB。CPUピーク・メモリ推移・heap/RSS内訳・GC・イベントループ遅延は**未測定**。
平時の低い瞬間CPUから、300ms級のAPI計算スパイクがないとは判断できない。

## 3. 遅い処理TOP10

実測の異なる範囲を混ぜた厳密な時間ランキングは作れない。以下は観測された長い待ちと、
ソース／EXPLAINで確認した増大リスクを合わせた**調査・改善優先順**。未測定の処理を実測順位と偽らない。

| 順 | 処理・根拠 | 分類 | 次の対処 |
|---:|---|---|---|
| 1 | 通信失敗を含む周期、現在窓max 36.264秒 | 実測ログ、失敗n=4 | attempt・キュー・backoff・全体期限を分離計測。安全期限は維持 |
| 2 | gRPC失敗、約8〜10秒。成功p99も3.129秒 | 実測ログ | メソッド別span、接続経路とAPIキューの分離 |
| 3 | DeepBook失敗、約8秒 | 実測ログ | 接続フェーズ別の成功／失敗ヒストグラム |
| 4 | 起動後の成功周期p99 18.795秒。3足を逐次取得 | 実測ログ＋ソース | 取得・再構築・保存の内訳を先に測る |
| 5 | 5分足再構築のsnapshot p99 12.473秒 | 参考観測 | 同じ穴・proof・1分足ページの再取得を識別、CPUとI/Oを分離 |
| 6 | 運用検証API、標本最大322.56ms。validationの全セッション再集計 | API実測＋ソース、寄与未確定 | 表示用集計の重複除去とキャッシュ失効計測 |
| 7 | 台帳全期間読込＋verifiedごとのchecks.find | ソース、増大時未測定 | Map化の等価性検証。安全判定は省略しない |
| 8 | summaryが3足とrecordsを毎回DB読込・canonical化・hash化 | ソース、API実測p50 17.43ms | 更新versionに連動する表示専用キャッシュ |
| 9 | paper_orders / risk_eventsの全走査＋一時ソート、rangeの無件数上限 | EXPLAIN実測、将来負荷未測定 | 隔離DBで複合index・cursor paginationを評価 |
| 10 | 初期JS単一bundle 476.84kB、稼働JS無圧縮466,313B。チャートRSI prefix再計算 | ビルド・転送実測＋CPU未測定 | 静的圧縮、ページ分割、Profilerで必要箇所だけメモ化 |

## 4. 原因となるコード・SQL・通信経路

以下はすべて最終固定SHAのプロジェクト相対パス。最新作業ツリーの行番号には依存しない。

### API・SQLite

- `apps/worker/src/index.ts`：GET operations→monitor.snapshot＋validation.report→JSON.stringify→必要時gzip。同期DB・集計はHTTPとworkerの同一イベントループに載る。
- `apps/worker/src/operations.ts`：snapshotは全期間operationCounts、totals、ledger、24h/168h reportを生成。report内で同一期間のoperationCountsをprofitRejected/riskRejected用に2回実行。snapshot全体では全期間1回＋期間別4回の計5回（各メソッド内2 SQL）となる。
- 同ledgerはpaper_checksとpaper_tradesを全期間取得し、verified各件にchecks.findを実行するため、件数増大時O(checks×trades)になり得る。会計安全判定と表示計算の境界を守る必要がある。
- `apps/worker/src/validation.ts`：reportの10秒cache miss時にaggregateValidationがセッション範囲のvalidation_events等を全件JSON.parseし、多段filter・統計・sortを実行。GET validation明示出力はfresh=trueで再集計する。
- `apps/worker/src/dashboard-feed.ts`：summaryはlight snapshotを使う一方、3足のdb.candles、canonicalFrame、SHA-256、およびrecords読込／JSON.stringify／SHA-256を毎回実施。candles/records要求時にも再計算する。
- `packages/database/src/index.ts`：DatabaseSync、WAL、synchronous=FULL、busy_timeout=5000。WALは別接続の読み書き共存に有効だが、同期JS処理や長いreaderの負荷を除去しない。ロック待ち・SQL実行時間・checkpoint影響は未測定。
- historyは通常200件、候補・イベント表示は50件、candlesは最大1000件。一方rangeは期間条件のみで件数上限なし。画面の50件表示でも集計側の読込量は小さくならない。

06:18頃の3101 DB件数：validation_events=25,163、operation_events=549、risk_events=107、market_candles=2,446。
operation_candidates / paper_orders / paper_checks / paper_tradesは0件。
以下は同一DB実装が稼働していることをハッシュ確認した上で採取したEXPLAIN。SQL時間は未測定。

| SQL要旨 | 実際のplan | 評価 |
|---|---|---|
| paper_orders ORDER BY timestamp DESC,id DESC LIMIT 200 | SCAN paper_orders; USE TEMP B-TREE FOR ORDER BY | LIMITがあっても索引順取得にはならない。現在0件なので実害未評価 |
| risk_eventsの同履歴 | SCAN risk_events; USE TEMP B-TREE FOR ORDER BY | 現在107件。大量履歴時の優先候補 |
| operation_candidatesの同履歴LIMIT 50 | timestamp index SCAN; TEMP B-TREE FOR LAST TERM | timestamp索引はあるがidタイブレークのsortあり |
| operation_events WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp,id | SEARCH timestamp index; TEMP B-TREE FOR LAST TERM | 範囲絞込は効く。idを含む索引の効果を隔離評価 |
| operation_candidatesのJSON集計 | SEARCH timestamp index | indexは期間絞込だけ。対象行のjson_extractと全期間集計は残る |
| candlesの最新source subquery＋足別1000件 | PK indexでtimeframe SEARCH、subqueryはcovering index＋TEMP B-TREE LAST TERM | 複数source・同timestampのrowid順選択が残る。source選択規則の変更は禁止 |

候補DDLは隔離環境でのみ検証する：`paper_orders(timestamp,id)`、`risk_events(timestamp,id)`、
必要なevent tableの既存timestamp indexを置き換える複合index。
単列indexを無条件で残して追加すると書込量・WAL・容量を増やす。JSON全期間集計はindex追加だけでは解消しない。
本調査ではDDL未実行。

### フロントエンド

- `apps/dashboard/src/main.tsx`：全ページを静的import。Appは10秒ごとにsummaryを取得し、tab/timeframe変更でもrefreshする。serialで古い結果適用を防ぐが、進行中要求の全面的なsingle-flightではない。
- `apps/dashboard/src/dashboardClient.ts`：状態を先に表示し、chart/history channelはtailで直列化、version比較で転送を省略。これは既存の有効な最適化。遅いときの連続pollでchannel jobが滞留する可能性は隔離試験で検証する。
- `apps/dashboard/src/OperationsPanel.tsx`：マウント中に別の10秒operationsポーリング。Appのsummaryと合わせて定常2 GET/10秒がソースから予想される（1クライアント、通常時）。異なる情報なので直ちに重複要求とは断定しない。operations側は8秒タイムアウト対象外で、遅延時のsetInterval再入とunmount後の通信継続が候補。
- API callbackはuseCallback(token)なので、親renderだけを理由にoperations effectが毎回再登録されるわけではない。cleanupはintervalを解除する。不要renderの実回数は未測定。
- `apps/dashboard/src/PriceChart.tsx` は既にuseMemoとseriesKeyを使用。`chartIndicators.ts` はRSI用に各prefixをsliceして再計算するため長い連続系列では二次的な仕事量が候補。`main.tsx` の小チャートもprefix計算あり。計算同値性を保つUI専用改善として検証する。
- orders/events/candidatesはmapで描画し、閉じたdetails内のJSON.stringifyもrender時に評価する。まず開くまで詳細生成を遅延。現在の50〜200件だけを理由に仮想スクロールを必須にはしない。Profiler・DOM数・操作遅延で判断する。
- 今回Long Tasksは未観測だが、取引履歴0件の短い観測であり巨大テーブル時の証拠にはならない。

### 通信・Worker

経路：MarketScheduler→BotEngine.tick→monitor.acquisition→Sui health→DeepBook prepare/status/book→
5m→15m→1h→finalize→検証・DB保存→戦略→見積り→Profit Guard/RiskEngine→PAPER／監査。
分岐・キャッシュ・WAITにより各周期の実行経路は異なる。

- `packages/shared/src/api.ts`：API名ごとのtailで直列化、同一keyのflights共有、TTLキャッシュ、backoff、Retry-After、rate limit状態、安全停止・復旧通知。足をPromise.allにするだけでは同じAPIのtailで直列化されるため、単純並列化の効果を約束しない。
- `packages/market-data/src/deepbook-transport.ts`：HTTP/2 session再利用、idle 120秒、8秒期限、4MiB本文上限、GOAWAY/abort処理、失敗時phase/timing記録。失敗だけでなく成功のDNS/TCP/TLS/header/body統計を取得できるようにする計画が必要。
- `packages/market-data/src/deepbook.ts`：pool TTL 300秒、status TTL 5秒、OHLCV TTL 20秒。finalizeは短周期のbook重複取得を既に抑制するが、長周期・復旧・注文前のfresh取得は必要。5分足の穴を1分足最大8ページとtrade proofで再構築する。proof cacheもあるため同種cacheを別に新設しない。
- DeepBookは1要求8秒・最大transient retry 2回。通常backoffの式は1,000〜1,250ms、次が2,000〜2,500msなので、3回とも期限到達なら約27〜27.75秒＋キュー／処理が理論候補。ただし共有read budgetや失敗種別で打切られる。これは実測の分解値でも全周期上限でもない。Retry-Afterの待ちと全体budgetも別に扱う。
- `packages/sui-client/src/index.ts`：SuiGrpcClient再利用、healthは通常120秒cache、復旧時force。2 coin metadataはPromise.allSettledでも、API層のtailで直列化され得る。実際のmethod別時間は未測定。
- `apps/worker/src/scheduler.ts`：awaitした単一cycle、遅れたslotをskip。`engine.ts`もbusy guardあり。Worker周期の二重実行防止は既存機能なので再実装しない。
- chart履歴は`chart-history-client.ts`の別worker・single pending・35秒期限、`chart-history.ts`の別SQLite cache、期間制限とgateを既に持つ。取引用取得と表示用履歴を無造作に統合しない。

## 5. 改善計画・優先順位・期待効果と副作用

P0は計測と安全境界の確立、P1は根拠のある低リスク改善、P2は測定で必要性を確認してから。
効果欄の数値は実装後の保証値ではない。

| 優先度 | 提案 | 期待効果・根拠 | 副作用／安全条件 |
|---|---|---|---|
| P0 | SHA/image/依存versionを計測結果へ紐付け、API route＋成否のhistogram、cycle内span、event-loop delay/GC/RSSを追加する設計 | 本監査の版不一致と原因分解不足を解消。高速化率は未推定 | メトリクス自体の負荷・秘密の記録を制限。高cardinalityなURL/tokenをlabelにしない |
| P0 | 既存の復旧・安全停止・read budget・429・鮮度・会計整合の不変条件を性能回帰の前提に固定 | 速度改善で安全判定が欠けることを防ぐ | timeout・cooldown・鮮度条件を緩めない。最新mainそのものの実行測定を隔離環境で行う |
| P1 | report内でoperationCountsを1回取得して共有 | 期間別4呼出→2、snapshot全体5→3。対象集計SQL呼出を10→6に減らせるというソース上の根拠 | 同じnow・read snapshotを使う。会計・Risk/Profit判定を省略しない |
| P1 | 表示レポートの同一DB更新versionに対する計算共有。validation既存10秒cacheを活用し、必要ならread-only集計workerを評価 | operationsの17〜323ms変動と25k events再読込への対策。時間削減率は未確定 | runtime・停止・鮮度をcacheしない。display generatedAtを表示。cache hitで安全許可を出さない。別readerのWAL保持と整合snapshotに注意 |
| P1 | ledgerのchecks.findをorderId Map化する等価変換 | O(checks×trades)候補をO(checks＋trades)へ。現データ0件でms効果は未推定 | 重複orderIdの最初の一致、順序、欠損・不正値の拒否を保持。ledger呼出の削除や検査件数制限は禁止 |
| P1 | summaryのframe/records versionをDB変更時だけ再生成 | 不変データの3足読込・canonical化・hashを毎10秒繰り返す仕事を削減 | transaction commit後のversion無効化、source変更・再起動・repair更新を取りこぼさない。失敗時は全量resetに戻す |
| P1 | 履歴用(timestamp,id) indexを隔離DBで比較し、UI履歴はcursor pagination | EXPLAIN上の全sort除去候補。大規模データほど効果を期待 | 実DB移行は別作業。書込・WAL増加を測る。安全監査・全期間集計の範囲をUI件数制限と混ぜない |
| P1 | hashed静的JS/CSSを事前gzip/br配信、適切なimmutable cache。HTML/APIは独立した方針 | 最新参考JS gzip比で約68%（476.84→151.84kB）本文削減の余地。稼働版は無圧縮実測 | MIME/CSP/Vary/encodingを維持。HTMLは旧bundleを指さない更新手順。認証APIや安全状態をHTTP cacheしない |
| P1 | 既存10秒pollのままpending共有・要求中断・不要channel job抑制を評価 | 遅いoperationsやタブ移動時の多重要求・古い処理を減らす | 停止・復旧・エラー表示の即時性を維持。summaryの先行表示を遅くしない。間隔延長による鮮度低下は採用しない |
| P2 | ページ単位lazy import、詳細JSONの展開時生成、実測に基づくReact.memo | 初回parseと再renderを削減する可能性。単一JS約477kBが根拠 | 初タブ切替時のchunk取得待ち・エラー表示を検証。比較関数のコストとstale propsに注意 |
| P2 | UIチャートのRSIなどを同値な計算へ変更、必要なら表示worker、巨大履歴だけ仮想化 | prefix再計算・巨大DOMの抑制。現状のms効果は未測定 | 売買用indicatorは対象外。gap/reset/source変更・表示順・キーボード操作を維持 |
| P2 | 同じ閉足・穴・proofの取得共有を既存cacheに統合して評価 | 再構築のI/O重複減少候補。独立spanで確認後に着手 | 新鮮さの証拠、完全性、provenance、注文前fresh、recovery generationを保つ。API tail解除や無制限並列化は採用しない |

## 6. 実装順序

1. 本書の固定SHAを隔離環境でNode24.22.1＋frozen lockfileからビルドし、稼働イメージ差を解消した比較基準を作る。本番の再起動・PAPER操作とは分離する。
2. P0のroute/span/イベントループ計測を設計・追加し、正常／接続障害／本文遅延／429のbaselineを別々に保存。
3. 純粋な表示計算の重複除去、ledger同値Map化、既存cacheの計算共有を小さく分割して検証。
4. 隔離DBでindexと履歴paginationを評価。次にsummaryのversion無効化設計を検証。
5. 静的圧縮・キャッシュ、poll再入抑止、必要なページ分割を適用。
6. Profilerと大規模fixtureで裏付けが得られた箇所だけチャート／テーブルを最適化。
7. 後述の安全・性能回帰試験を全て通し、同条件で改善前後を比較。採用・展開は別途実施する。

## 7. 性能回帰テスト設計

### 比較条件の固定

- SHA、image digest、Node、OS/CPU/メモリ制限、依存lock hash、ブラウザversionを保存。
- syntheticまたは整合した匿名化copyを隔離DBに用意。表別件数、JSON平均／最大サイズ、source数、timestamp重複率、WAL状態・DB容量も保存。コピーは本番の単純なsqliteファイルコピーではなく、承認された整合snapshot手順を使う。
- APIはまず同時1、cache cold/warm別。負荷試験は隔離環境でのみ同時5/20等を段階設定。外部通信はfixtureへ置換し、実APIに負荷を転送しない。
- 代表データは候補・注文・checks・tradesの0/1万/10万件、validationイベント1日／7日、ローソク足3足×1000、重複timestampと複数sourceを含める。
- endpointごとにwarmupを除いて1,000以上の標本を目安にp50/p95/p99、最大、エラー率、n、測定窓を保存。p99の信頼区間・run間ばらつきも比較。生産環境では追加アクセスで集めず通常trafficを受動集計。

### 計測と合格条件

| テスト | 計測 | 判定案（導入時にbaselineと合意） |
|---|---|---|
| API | route別queue/SQL/集計/serialize/gzip/TTFB/全受信、転送量 | 隔離warm summary p95<100ms、operations p95<200msを初期目標。p99悪化>10%は調査対象。今回のn=3を基準に合否を決めない |
| SQL | 実schemaのEXPLAIN、取得件数、DB→JSON.parse時間、write latency/WAL/容量 | 対象ORDER BYの不要sort解消、同じ結果。追加indexでwrite p99が悪化しないことを確認 |
| 集計cache | 同じ入力versionのquery回数、cold/warm、障害・復旧・source変更 | 安全状態は常に最新。期限切れ・破損・再起動は安全に再計算／reset。会計結果は完全一致 |
| ブラウザ | production build、desktop＋mobile viewport、CPU4倍slowdown・固定回線、cold/warm各30回以上 | FCP/LCP/CLS、tab ready p50/p95、API回数／B、Profiler commit、Long Tasks、scroll latencyを比較。実機検証も追加 |
| ポーリング | 12秒遅延、タイムアウト、タブ連打、logout/unmount、StrictMode | 同じchannelの不要重複と無制限queueなし。古い結果が新しい停止状態を上書きしない。10秒周期と先行summary表示を維持 |
| チャート | 100/1000本、gap、reconstructed、source切替、zoom/resize | 計算／React commit／SVG描画を分離。最適化前後で値・gap・表示期間・説明が一致 |
| 通信 | mock DNS/TCP/TLS/header/body遅延、GOAWAY、reset、429 Retry-After、空・巨大本文 | 各attemptとretry総時間、queue/backoffを別々に記録。既存deadline内で打切り、孤立socketなし、429前後の取引禁止が維持 |
| Worker | fetch/parse/repair/save/strategy/quote/Profit/Risk/PAPER/auditのspan、event-loop delay、CPU/RSS/GC | 周期重複なし。安全期限到達・取引記録失敗で安全側へ停止。表示アクセス時にも安全監視のdeadlineを満たす |

安全の同値性は速度より優先する。既存のdeepbook-transport、read-budget、market-scheduler、paper-recovery、
paper-recovery-engine、connectivity-ui、dashboard差分系とE2Eを、変更対象に合わせて実行する。
残高・PnL・手数料・guard判断・runtime遷移・audit順序を同じfixtureで比較し、
改修前が拒否した入力で新たに許可しない。TTL境界、復旧中の世代変更、注文直前のfresh取得も含める。

## 8. 再現方法と未測定項目

本調査の補助スクリプト・展開物はリポジトリ外の一時監査領域で実行した。本コミットには本書だけを含める。
再現時の操作要旨は以下。認証値・設定全文を端末ログへ出さない。

1. `git ls-remote origin refs/heads/main`、`git log -1 --format="%H %cI"`、`git status --short` で版と既存作業を記録。固定SHAをarchiveし、別ディレクトリでビルドする。
2. `docker ps`、`docker inspect --format '{{.Image}} {{.Created}} {{.State.StartedAt}}' <name>`。inspect全文は環境秘密を含み得るため出さない。
3. コンテナ内で対象ファイルをSHA-256化してarchiveの同ファイルと比較。`.env`やsecretは比較・出力対象にしない。
4. GET APIはgzip要求し、request開始→headers→本文受信→JSON.parseをmonotonic clockで分離。最初のround後に10秒間隔。response content-lengthと展開後byte数を区別。
5. DBはreadOnly:true接続。上記SQLに `EXPLAIN QUERY PLAN` を前置し、既存index定義をsqlite_schemaから読む。性能監査のためにアプリDB constructorを呼ばない。
6. 既存記録の分布は以下の形で抽出し、API名・成否別にlatencyMsを集計する。

```sql
SELECT timestamp, json
FROM validation_events
WHERE timestamp >= ?
  AND json_extract(json, '$.kind') IN ('api', 'cycle');
-- ? = bot_runtime_state.operation_state.processStartedAt
-- api: data.api / data.success / data.latencyMs
-- cycle: error / durationMs / market.quality.300.reconstructionMs
```

read-only集計は複数の短いSELECTで行い、長いtransactionを保持していないため、件数と別採取の統計は同一時点のsnapshotではない。
検証イベントには旧プロセスの記録も残るため、必ず起動後windowと全保存期間を分ける。

**未測定・未確定**：最新mainと同一イメージの実行性能、稼働版のGit SHA、全APIの十分な標本数、
足別・通信段階別のp95/p99、retry/backoff/queueの実時間分解、gRPCメソッド別E2E、
SQL時間ランキング・実際のSQLite lock待ち、重い取引履歴下の挙動、独立再構築CPU時間、
戦略／Risk／Profit／PAPER／audit各span、イベントループ遅延・CPU/メモリ時系列、
チャート描画／React再render実回数、LCP/INP/CLS、実機モバイル、障害注入・負荷試験、
全改善の実装後効果。これらを推測値で埋めず、P0と隔離環境の回帰試験で解消する。
