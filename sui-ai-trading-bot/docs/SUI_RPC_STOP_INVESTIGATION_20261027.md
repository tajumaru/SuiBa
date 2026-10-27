# Sui取得失敗とBot停止：最新main重点調査

調査基点：`1d550fbc56f1be9f38cc0fd10a574b3849735857`（2026-10-27取得のorigin/main）。専用ブランチ：`investigation/sui-rpc-stop-analysis`。Node.js **24.22.1**、固定lockのSDK **@mysten/sui 2.37.0**。本PRは文書・オフライン抽出スクリプト・テストのみ。本番コード、安全条件、timeout、retry、依存、設定を変更していない。既存Docker/Bot/DBへの操作・接続なし。テスト用の新規メモリDB／一時DBのみ使用。

## 結論と確度

1. **売買指標をSui RPCから直接取得してはいない。** EMA20/50、RSI14、MACD12/26/9、histogram、ATR14、volumeChange、priceChangeは市場OHLCVからローカル計算する。Sui側の必須ゲートはSUI・Native USDCの**coin metadata（decimals）のhealth確認**。このhealthが市場取得より先にawaitされるため、失敗するとDeepBookの当該周期の取得・指標計算まで進まない（[engine.ts:103](../apps/worker/src/engine.ts#L103)、[indicators:33](../packages/indicators/src/index.ts#L33)）。
2. 過去生ログのSHA256を独立照合し、Sui **timeout 3件／DNS EAI_AGAIN 2件 → 4周期のSUI_READ_FAILED → DEGRADED**を確認した。ただし当該実測のBotは開始時から停止中。今回依頼の「稼働中の断続停止」の最新main実行ログそのものは未入手。失敗coin名も当時のログにない。**過去ログを最新mainの稼働停止証拠に読み替えない。**
3. 最新mainの実SDK＋模擬HTTP＋実Engine＋新規メモリDBで、health異常による停止と補助balance読取からの停止波及を再現した。通信に証拠のある一時障害は自動復旧対象だが、gRPC失敗・metadata欠損等は通常`SUI_READ_FAILED`の重大停止へ進む。HTTP成功と業務成功を区別する必要がある。
4. 旧調査の「balance成功がhealth cacheを回復する」問題は最新mainで**修正済み**。ただし補助balance失敗はhealthを無効化し、共通通信コールバックもBotを一時停止させる。失敗したAPIの用途別の分離は未実施。

## 1. 全Sui取得処理と必須度

アプリのSui直接呼出しは`packages/sui-client/src/index.ts`に集約。JSON-RPC fallbackはない。`SuiGrpcClient` + `GrpcWebFetchTransport` + `apiFetch("Sui gRPC")` + Node fetchを使う。DeepBookの専用native HTTP/2 transportとは別。

| データ／呼出し                        | 実エンドポイント（SUI_GRPC_URL基準のPOST） | 利用・必須度                                                       | 正常条件／周期・キャッシュ                                                                                 |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| SUI metadata / metadata(SUI)          | `/sui.rpc.v2.StateService/GetCoinInfo`     | healthの現行必須条件。売買シグナルではない                         | decimals=9。health非cache時に1回                                                                           |
| Native USDC metadata / metadata(USDC) | 同上                                       | healthの現行必須条件。別coin片成功では不十分                       | decimals=6。health非cache時に1回                                                                           |
| health(force)                         | 上記2呼出しのcohort。専用ping APIではない  | 全市場取得の前提、PAPER復旧・手動startにも必要                     | 両方成功・epoch一致・未abort・証拠保存正常。healthy cohortだけ120秒cache。復旧時fresh。実HTTP cache TTLは0 |
| SUI / USDC balance(owner,type)        | `/sui.rpc.v2.StateService/GetBalance`      | `/api/balances`のみ。現行PAPER戦略・残高・台帳には不使用、補助表示 | 有効address、coin一致、数字文字列。ユーザーGET時のみ、TTL0・定期pollなし                                   |
| transaction(digest)                   | `/sui.rpc.v2.LedgerService/GetTransaction` | wrapper実装あり、production呼出し元なし                            | digest一致、effects取得。周期なし、TTL0                                                                    |
| HTTP/gRPC/read/healthの受動観測       | 追加APIなし、`sui_observations`保存        | 通信診断用。ただし保存障害は安全上必須                             | 同期保存失敗は`VALIDATION_RECORD_FAILED`をラッチ                                                           |

既定originは`https://fullnode.mainnet.sui.io:443`、`SUI_GRPC_URL`で変更可能、HTTPS必須。実運用のenv値は今回読み取っていない。[worker生成](../apps/worker/src/index.ts#L63)、[Sui wrapper](../packages/sui-client/src/index.ts#L340)。APIの名称は[公式gRPC照会資料](https://www.docs.sui.io/develop/accessing-data/grpc/using-grpc)でも確認。挙動の判定には同梱2.37.0の`src/grpc/core.ts`を優先した。

metadataではAPIが返すname/symbol/id等も受領するが、healthが検証するのはmetadata存在とdecimals。gas価格、TPS、checkpoint、validator稼働率、Suiの市場価格、オシレーターをこのclientから取得するコードはない。SDKの通常型解決を通るが、許可coinは固定の完全修飾型SUI/USDCで、MVR名前解決を要する任意coinは受け付けない。

### 共通通信制御

根拠：[api.ts](../packages/shared/src/api.ts)、[read budget](../packages/shared/src/read-budget.ts)、[scheduler](../apps/worker/src/scheduler.ts)。

| 設定                | Sui                                                                                               | DeepBookとの関係                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1試行timeout        | **10,000ms**。本文受信も含む。キュー待機後開始                                                    | DeepBook 8,000ms                                                                             |
| 一時障害retry       | **追加0回**（policy未指定時0）                                                                    | DeepBookのみ追加最大2回                                                                      |
| HTTP429             | API単位cooldown、追加最大2回。Retry-After＋正ジッター、通常最大60秒。指定>60秒は短縮せずexhausted | 最初の429で既にstop。成功retryは停止解除ではない                                             |
| Breaker             | 同APIの一時障害3回でOPEN、30秒→最大60秒。HALF_OPENの成功probeまでblocked                          | Sui・DeepBookは別state。ただし`blocked()`は全APIを見て注文を禁止                             |
| 同時実行            | 同API tailで直列化、同要求flight共有                                                              | healthの2coinはallSettledだが実HTTPは同API queueを通る                                       |
| health cohort共有   | fresh/epoch/budgetを確認。古いflightをfresh証拠として使わない                                     | 全体復旧budgetに従う                                                                         |
| 取得全体期限        | health＋市場＋queue/retry待ちを**45秒**でabort                                                    | 上限超過は`MARKET_DATA_STALLED`。healthだけの遅延でもこの名称になる                          |
| 通常周期            | 設定intervalMs既定60秒（30秒〜1時間）、単調時計、重複tick禁止                                     | DeepBookは5分境界後10秒位相、健全時だけ限定再確認。TTL120秒との組合せで実RPCは毎tickではない |
| cache期限と使用条件 | health120秒、開始操作はcheckedAtから180秒以内を要求                                               | startの180秒はcache TTLではない。復旧は今回取得時刻を要求                                    |

`/api/balances`は市場45秒budgetの外で、API試行10秒・queue/cooldownの制御のみを受ける。healthと同じqueue・state・epochを共有する点が重要。SuiのHTTP観測はretryを含む最終結果であり、実試行数には`ApiAttempt`を使う。`transportAttempted=false`は共有flight／ローカル拒否で実通信の分母に入れない。

## 2. DeepBook依存と指標の鮮度

DeepBookMarketDataにはReadOnlySuiClient依存がない。依存はEngineの順番と共通注文ゲートで作られている。DeepBook読取先は固定`https://deepbook-indexer.mainnet.mystenlabs.com`、GET専用HTTP/2。

| DeepBookデータ         | パス／TTL                                                                                                                          | 用途と鮮度条件                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| pool定義               | `/get_pools` / 300秒                                                                                                               | SUI_USDC、asset ID、decimals検証。prepare時                                                                                                         |
| Indexer進捗            | `/status?max_checkpoint_lag=100&max_time_lag_seconds=60` / 5秒                                                                     | status OK、lag<=60秒、checkpoint lag<=100、server時計差<=10秒                                                                                       |
| 板bid/ask/spread/depth | `/orderbook/SUI_USDC?level=2&depth=10` / 0                                                                                         | 板年齢<=10秒、未来<=5秒、正値・整列・spread・必要depth。注文直前refresh                                                                             |
| 5分/15分/1時間OHLCV    | `/ohclv/SUI_USDC?interval=5m,15m,1h&limit=1000`（各別要求）/ 20秒                                                                  | 全3足必須。61本以上・確定・連続・非外れ値。終値時刻からtf+60秒以内                                                                                  |
| 欠損再構築             | `/ohclv/SUI_USDC?interval=1m&start_time=…&end_time=…&limit=1000` / 20秒、`/trades/SUI_USDC?start_time=…&end_time=…&limit=1000` / 0 | verified設定のみ。空trade証拠とindexedThroughを確認。証拠の再利用はvalidEmptyProofで検証、1時間超のproofは掃除。独立した1分足の取引シグナルではない |

根拠：[deepbook.ts:169](../packages/market-data/src/deepbook.ts#L169)、[validation.ts](../packages/market-data/src/validation.ts)、[reconstruction.ts](../packages/market-data/src/reconstruction.ts)。prepare/frames/finalizeは市場周期ごと。復旧時freshはHTTP TTLを使わず、全足のfetchedAt>=周期開始・欠損0・板10秒・lag60秒等を追加確認する。指標は5分足のcurrentと1本前で計算、RSI・EMA・MACD等の計算に独立した通信retry/cacheはない。PAPER残高・原価・損益はSQLiteから読む。

GeckoTerminal選択時は同じ3足をGeckoから取得し、Sui health前提は残る。autoは許可された一時障害だけfallbackし、429、TLS、不正／薄い／古い板、ペア不一致を迂回しない。Cetusは別途見積もり用、DeepBook SDKで発注する構成ではない。Cetus quote期限15秒、SDK全体20秒、共通HTTP制御を通るがSui healthの代替証拠にはならない。

## 3. エラーの分類と停止経路

```text
Engine.tick → acquisition(45秒) → request(HEALTH) → sui.health
  → metadata(SUI / USDC) → SDK GetCoinInfo → apiFetch → ApiAccess
  → HTTP失敗時: ApiFailure / onTransientFailure または onRateLimit
  → SDK/gRPC失敗: 非abortのgetCoinMetadata例外はSDKでnull化
  → metadata欠損/decimals不正: INVALID_METADATA（観測）
  → readが上位例外をSUI_READ_FAILEDへ統一 → health全体も失敗
  → request HEALTH、外側request MARKETの両方でERRORを記録
  → engine catch → transientCycleFailureで今回の通信証拠との対応を確認
     許可された一時障害: DEGRADED、running=false、resumePending保持
     それ以外: failCycle → stop → runtime.running=false + runtime.errorを保持
```

| 原因分類                         | 観測できる根拠                                        | 即時の経路／停止コード                                                                                                                 |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| DNS/connect/header/body/一般通信 | `ApiFailure` code/phase/causeCode/status/elapsedMs    | 許可API・新しい整合した証拠なら`PAPER_NETWORK_PAUSED`。上位周期は`SUI_READ_FAILED`でも一時障害扱い                                     |
| HTTP429                          | status=429、`UPSTREAM_HTTP_429`、cooldown             | `onRateLimit → stop(UPSTREAM_HTTP_429)`。exhaustedでもreadはSUI_READ_FAILEDへ変換。runtime.errorは最初の429を保持                      |
| TLS・認証拒否・非許可HTTP        | HTTP/通信証拠。TLSはrecoverable対象外                 | TLS失敗、403等はhealth上位でSUI_READ_FAILED → 重大停止（個別下位コードは観測参照）                                                     |
| HTTP200＋gRPC UNAVAILABLE等      | HTTP成功、GRPC失敗・grpcStatus                        | ApiAccessのHTTP成功と独立。通常は一時通信復旧許可の証拠にならずSUI_READ_FAILEDで重大停止                                               |
| protobuf decode失敗              | HTTP成功、GRPC失敗（UNKNOWNの場合あり）、METADATA失敗 | 同上。デコード障害とgRPC14をcodeだけで区別せずSDK statusも参照                                                                         |
| metadata欠損／decimals不正       | GRPC成功の場合でもMETADATA=INVALID_METADATA           | SUI_READ_FAILED。欠損と値不正は現行codeでは未分離                                                                                      |
| 不正balance/transaction          | READのINVALID_BALANCE/INVALID_TRANSACTION             | readStatus失敗、healthを無効化。直接wrapperはSUI_READ_FAILEDを返す。transactionは現行未使用                                            |
| OHLCV不足・欠損・古い足          | INSUFFICIENT_CANDLES / CANDLE_GAP / STALE_CANDLES等   | Sui失敗と別。Engine failCycleで該当コードの重大停止                                                                                    |
| 指標計算失敗                     | calculateは60本未満でINSUFFICIENT_DATA                | 通常は61本検証が先に防止。INSUFFICIENT_DATAはsafeFailure許可一覧外でDATA_OR_EXECUTION_FAILUREへ汎化される。これをSui RPC障害と呼ばない |
| 締切超過／長期障害               | 45秒取得期限、180秒／9失敗の復旧上限                  | MARKET_DATA_STALLED / PAPER_RECOVERY_EXHAUSTED                                                                                         |
| 証拠・DB障害                     | 同期onObservation/SQL healthのラッチ                  | VALIDATION_RECORD_FAILED等。自動回復対象に緩和しない                                                                                   |

根拠：[HTTP分類](../packages/shared/src/http-errors.ts#L60)、[復旧許可](../packages/shared/src/paper-recovery.ts#L56)、[一時障害処理](../apps/worker/src/operations.ts#L115)、[Engine catch](../apps/worker/src/engine.ts#L615)、[stop](../apps/worker/src/operations.ts#L702)。

注意：内側HEALTHと外側MARKETが同じ例外を数えるため、1回のhealth失敗でもconsecutiveErrorsが2増え得る。3に到達する順序によって`CONSECUTIVE_API_ERRORS`が先にstopされ、後続`SUI_READ_FAILED`と併存し得る（softFailureThisCycle時はこのstopを抑止）。`runtime.error`は最初の値を優先し、`safety.lastStopReason`は後続stopで更新される。ダッシュボード上の両値が違っても別API障害とは限らない。

## 4. healthとの混同・復旧後の状態

- `/healthz`はheartbeat45秒以内を見るliveness。Sui APIを実行せず、売買可能性を保証しない。静的ダッシュボードやAPIが表示できても注文ゲートは閉じ得る（[worker:230](../apps/worker/src/index.ts#L230)）。
- Sui healthはmetadata2件をまとめたreadiness。指標計算の成功ではない。read catchは**補助balanceを含む全readでstatus.healthy=false、epoch増加**。同じApiAccessの一時障害callbackはtick外でも稼働意図を一時停止する。補助失敗と必須データ失敗の影響範囲が結合している。
- 正常readはreadStatusを更新するが、health statusやTTLを更新しない。health cohort完全成功だけがstatusを回復。旧cohort／遅延した成功はepochで失効。保存異常はstickyで成功通信から消えない。これは既存sui-healthテストでも確認済み。
- 通信正常化だけではPAPER再開しない。今回の全足品質・Sui fresh・板・台帳・注文履歴・世代・API backoff終了を確認し、独立正常周期2回以上かつ60秒以上、最短間隔30秒。遷移周期は注文禁止。手動停止・緊急停止・runtime.errorは自動解除しない。
- `ApiAccess.lastFailure`、DB `latest_api_failure`、safety.latestFailureは後続成功後も履歴として残る。snapshot.latestApiErrorは過去失敗の最新を返すので**「いま失敗中」と同義ではない**。HTTP成功でもgRPC失敗ならAPI.failed=falseとhealth=falseが併存する。
- 実SDKのGetBalanceは`response.balance`欠損時もbalance=`"0"`、coinType=要求coinに補完する（同梱core.ts:307）。現行wrapperの数字・coin検証を通りREAD成功となることを新規再現。補助表示では「不明」と真の0を区別できない。将来必須データとして採用する前に低レベルpresence検証が必要。

## 5. 実ログの証拠と限界

読み取ったのは既存の**退避JSONLファイルのみ**。Docker/DBから新規回収はしていない。

- 元ファイル：`D:/Source/SuiBa/.worktrees/validation-ux/sui-ai-trading-bot/docker/artifacts/preflight-8b05f2a/evidence-final.jsonl`
- SHA256：`fd22a73695a3a4e9a707c87cc84049290513db28d6c574b9b0fb69bc156769a4`、1,508行。既存調査記録と一致。
- 実行版：`8b05f2a6864e2891259b8a934b0063be9ec337b3`。最新mainとは異なる。[既存報告](PAPER_RUN2_PREFLIGHT_REPORT.md#7-障害と原因分析)を照合。
- allowlistしたAPIコード・時間・cycle・次sampleだけを[historical-extract.json](evidence/sui-rpc-stop-20261027/historical-extract.json)へ保存。元の生ログ全文、URL、アドレス、要求本文、秘密情報はPRに追加しない。

全時刻2026-10-23 JST。API時刻はApiAttempt.occurredAt、latencyは同latencyMs。抽出には低レイヤーelapsedMsも別保存（観測オーバーヘッドで1〜2ms差がある）。

| 元行 | 失敗時刻／API／operation                | 原因／応答時間                                   | 対応する周期行／終了／所要時間           |
| ---: | --------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
|   81 | 19:28:20.026 / Sui gRPC / SUI_GRPC_READ | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT / 10,006ms | 83 / 19:28:22.967 / 12,965ms             |
|  407 | 19:55:19.892 / 同上                     | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT / 10,003ms | 410 / 19:55:20.863 / 10,985ms            |
|  926 | 20:36:17.670 / 同上                     | UPSTREAM_DNS_FAILED / DNS / EAI_AGAIN / 8,015ms  | 929 / 20:36:25.830 / 16,188ms            |
|  928 | 20:36:25.714 / 同上                     | UPSTREAM_DNS_FAILED / DNS / EAI_AGAIN / 8,009ms  | 同929（同cohortの別coin、retryではない） |
| 1504 | 21:24:19.378 / 同上                     | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT / 10,004ms | 1506 / 21:24:21.262 / 11,908ms           |

5件すべてattempt=0、HTTP status未取得。4周期ともerror=SUI_READ_FAILED、analysis=null、frames空。直後sample（84/411/930/1507行）はDEGRADED、running=false、runtime.error=null、resumePending=false。これは重大停止コードの実測ではなく、既に停止中の一時通信異常である。失敗coinは記録不足で不明。health呼出し構造から**SUI/USDC metadataのいずれか**までは絞れるが、個々のcoinを割り当てない。timeoutをDNS/TCP/TLSのいずれかに再分類しない。

過去の成功後もprovider.healthy=trueが残っている失敗周期がある。しかしlastSuccessAtは古く、今回framesは空。これをDeepBook新規取得成功と扱わない。最新mainもhealth前段失敗ではmarket.framesを呼ばず、provider状態を更新できない。

今回追加の再現は最新mainコード上で**稼働状態から停止すること**をassertする。一方、ユーザーが見た直近停止に対して「実際に失敗したcoin・API・停止コード」を確定するには、その時刻の`UPSTREAM_REQUEST_FAILED`、`sui_observations`（requestId/rpcId/healthId/cycleId/coin）、cycle_auditsとoperation_eventsの既存エクスポートが必要。今回の禁止範囲を守り、稼働DBやサービスへ読取要求は送っていない。

## 6. オフライン再現と検証

新規7ケース（本番変更なし）：

- 実SDKのHTTP200＋gRPC14、metadata欠損、wrong decimals、decode失敗、HTTP403を各Engineまで通す5ケース。市場frames未呼出し、HEALTH_SUI_READ_FAILED記録、runtime.error=SUI_READ_FAILED、通信成功後も停止エラー／注文ゲート維持、注文・約定0を検証。
- 補助balance EAI_AGAINだけで次tick前にrunning=false、DEGRADED、resumePending=true、注文禁止となるケース。
- 正常gRPCフレーム内のbalance欠損がSDKで0に変わり、READ成功として扱われるケース。

追加：[paper-recovery-engine.test.ts](../tests/paper-recovery-engine.test.ts)、[sui-observations.test.ts](../tests/sui-observations.test.ts)。共通ApiAccess breakerを成功probeで閉じる後処理を追加し、テスト間の合成障害漏れを防いだ。初回追加試験はその隔離不足で既存試験へOPENが漏れたため失敗したが、製品を変更せず後処理を修正して解消。

既存回帰も実行：sui-health（片coin失敗、TTL、古い成功、別balance成功、abort、証拠保存障害）、sui-observations（DNS/timeout/TLS/本文/gRPC/decode）、paper-recovery（連続障害180秒・9回、データ不完全、手動停止維持）、read-budget、circuit-breaker、http-errors等。ネットワーク禁止setupがSocket.connect/Server.listenを拒否。外部API・Botを起動せず実SDKのfixtureだけで実行する。メモリ／一時DBの模擬会計試験を含むが、稼働DBと実注文は使用しない。

再現コマンド（専用worktreeのsui-ai-trading-botから）：

```powershell
node --version # v24.22.1
New-Item -ItemType Directory -Force data/offline-tmp | Out-Null
$env:TEMP = (Resolve-Path data/offline-tmp).Path
$env:TMP = $env:TEMP
node scripts/run-project.mjs test:offline --reporter=json --outputFile=docs/evidence/sui-rpc-stop-20261027/offline-vitest.json
node scripts/run-project.mjs typecheck
node scripts/extract-sui-stop-evidence.mjs <退避JSONL> <新規出力JSON>
```

検証結果は[evidence README](evidence/sui-rpc-stop-20261027/README.md)を参照。最初の全体検証は964成功・1失敗・8skip、失敗はレポート出力テストのOS一時ディレクトリrename EPERM。専用worktreeにTEMP/TMPを固定して切り分けた。製品のファイル保存実装を変えて回避していない。

## 7. 修正案（未実装、注文ゲート維持）

### P0：停止の原因を表示・記録で分離

`SUI_READ_FAILED`を上位互換のまま残し、別の構造化reasonに`purpose=HEALTH_REQUIRED|AUXILIARY_BALANCE|TRANSACTION_LOOKUP`、operation、coin、HTTP/gRPC/validation分類、cycle/health/request ID、startedAt/endedAt/elapsedMs、cacheHit・fresh・取得時刻・有効期限を追加する。欠損と不正値は別分類。URLは認証情報を含まない設定名／許可originだけを表示し、bodyや生例外を保存しない。既存同期証拠保存の失敗を握り潰さない。

1health cohortを1失敗として数え、HTTP試行数・coin失敗数・周期失敗数は別集計にする案を検証する。HEALTHとMARKETの二重加算だけでCONSECUTIVE_API_ERRORSに近づく挙動を防ぐ場合も、データ不十分な周期では必ず注文ゲートを閉じる。SQLite/証拠/手動停止の条件は対象外。

### P1：必須取得を止めずに診断・補助表示を継続

Sui healthが不成功でも市場データ収集・分析用の読取処理を共通45秒budget内で独立に進める設計を候補とする。ただし**分析可能**と**注文可能**は別。Sui readinessが未確認なら新規注文不可、今回の全必須データと全安全条件を満たすまで解除不可。healthを無視してDeepBook正常だけで注文許可しない。取得を並列化するならAPI負荷・世代・abort・遅延応答の回帰試験を先に実施。

補助balanceは用途別readStatusと結果を持ち、balance失敗がmarket/Sui readiness全体の停止を直接要求する必要性を再評価する。単にclientを2個にしても共通ApiAccess callbackが残るため分離にはならない。同originの429/cooldown/Breakerを共有して上流負荷は抑え、必須healthを**新しく確認するまで注文ゲートは閉鎖**する。補助機能の欠損・認証エラーだけで重大エラーをラッチするかを別ポリシーにする。重大停止回避の採用は別PRで安全レビューする。

### P1：失敗の種類に応じた回復、cacheは証拠と分ける

HTTP200のgRPC UNAVAILABLE等を回復候補へ追加する場合、SDK境界の確定statusと今回cohortへの相関を必須にし、許可statusだけを限定する。PERMISSION_DENIED、型・decimals不一致、decode／欠損、DB障害を一律の通信一時障害へ変換しない。正常1件やcached healthで回復させず、既存の2周期/60秒・市場全足・板・台帳・注文履歴・generation・manual intent条件を維持する。

metadataが比較的静的でも、古い値を最新通信の証明に使わない。静的pair検証と通信readinessを分ける設計には、実際に必要なreadinessの定義と新しい証拠が要る。health削除、TTL延長、timeout/retry増加は本提案の既定手段にしない。

## 8. ダッシュボード改善仕様（未実装）

既存`GET /api/operations`は`suiHealth`、`suiReads`、直近50件`suiObservations`とsafety/stopReason/latestApiErrorを提供（[worker:337](../apps/worker/src/index.ts#L337)）。Engine snapshotの`connection`もhealth statusだが、Suiの層別結果との因果がUI上で追いにくい。

提案する表示：

| 常時見える項目   | 表示例・判定仕様                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| 現在の注文ゲート | 「新規注文禁止：Sui health未確認」＋現在の状態、最初のruntime.error、最新lastStopReasonを区別               |
| Sui必須health    | SUI・USDCを各行にし、HTTP/gRPC/metadata結果、取得時刻・年齢・期限、実通信／cacheを明示。未取得は「不明」    |
| 売買指標         | EMA/RSI等の入力source、確定足終了、今回算出時刻。health前段失敗は「今回未計算」。過去値は時刻付き「過去値」 |
| 補助balance      | 「残高取得失敗／不明」、healthへの影響の有無。欠損を0表示しない                                             |
| 回復確認         | 今回の全足・板・Sui・台帳・backoff、正常周期数／経過秒、手動停止の保持を文章で示す                          |
| 障害履歴         | 「過去の最終失敗：…」「その後の成功：…」を並べ、lastFailureが残るだけで現在異常の赤表示にしない             |

詳細展開で`API → coin → HTTP → gRPC → validation → health → cycle → pause/stop`をIDで追えるタイムラインを提供。相関のない旧ログは「対応不明」とし、時間近接だけでcoinを割り当てない。HTTP・gRPC・検証を足した件数を障害数として表示しない。既存50件でcohortが欠けた場合は「履歴範囲外」。UI表示更新のためにSuiへの追加pollはしない。

ui-ux-pro-maxに従い状態は色だけで伝えずテキスト併記、変化時のstatus通知は文脈込み、詳細はキーボード操作可能な展開にし、モバイルでは横長表を要点カードへ切替。過去エラーを消すためのRESETやSTARTを自動実行するボタンは設けない。UI刷新・API変更は今回実装していない。
