# 3101 PAPER売買0件の原因調査

## 結論

3101は **異常停止中**。最新の停止理由は `UPSTREAM_BODY_TIMEOUT`、緊急停止フラグは false。通信と市場データはその後復旧しているが、停止解除・手動開始をしていないため注文は実行できない。これは既存の自動再開禁止仕様に沿う。

ただし「停止だけが売買0件の原因」ではない。保存済みの戦略分析を全件走査した結果、BUY・SELLは一度もなく、すべてWAIT。候補・注文・約定テーブルもすべて0件であり、Profit GuardやRiskEngineによる拒否、残高不足、最小注文数量、手数料が今回の直接原因である証拠はない。これらの実行段階には到達していない。

断続的な外部通信障害と、それによる停止時間の長さは確認できる。一方、障害がなければBUYが出たはず、という反実仮想は証明できない。欠落した分析を正常なWAITと数えてはいけない。

## 調査方法と範囲

- 対象は3101に対応する専用コンテナ。3100は調査・更新対象外。
- ホストの main: `1bc04dc309501c8325053687a995296713fe59f2`。
- SQLiteを `DatabaseSync(...,{readOnly:true})` と `PRAGMA query_only=ON` で読み取り、履歴の表示上限200件を使わず全行を集計した。
- 認証済みGET `/api/operations` と照合。トークンはコンテナ内だけで使用し、出力していない。
- DeepBookに追加した外部HTTPリクエストは診断用の公開status GET 1件。DNS確認も実施した。
- 取得はライブ環境のため、後述する二つの観測時刻の間にも定期分析・計測が継続している。異なる時刻の件数を同一スナップショットとは扱わない。
- Bot開始・停止解除・設定変更・コンテナ再起動/再作成・DB初期化・実注文は実施していない。
- 詳細な選択項目のみのローカル診断結果は、Git管理外の `data/zero-trades/investigation.json` に保存。報告書以外はコミットしない。

## 1. 現在状態と最後の停止

観測A: **2026-10-23 00:28:44.274 JST**。

| 項目 | 確認値 |
|---|---|
| 稼働 | running=false / ABNORMAL_STOP |
| 緊急停止 | emergency=false |
| 保持中のエラー | UPSTREAM_BODY_TIMEOUT |
| 最終手動開始 | 2026-10-23 00:23:51.469 JST |
| 最新の停止 | 2026-10-23 00:24:26.278 JST、UPSTREAM_BODY_TIMEOUT |
| 直前の停止 | 2026-10-23 00:23:26.897 JST、同じ本文タイムアウト |
| 最終取得試行 | 2026-10-23 00:28:09.992 JST |
| 最終取得成功 | 2026-10-23 00:28:13.381 JST |
| 最終分析成功 | 2026-10-23 00:28:13.568 JST |
| 最終取得所要時間 | 3,395ms |
| 最新確定足の終了時刻 | 2026-10-23 00:25:00 JST |
| 残高 | USDC=100、SUI=0、実現損益=0 |
| 累積PAPER稼働時間 | 4,546,847ms（約75分47秒、検証前も含む） |

観測B（00:29:29 JST）では、取得成功00:29:14.613、分析成功00:29:14.697、取得4,640ms、通信recent=true、dataStatus=FRESH。**データ正常とBot停止が同時に成立**している。

`OperationMonitor.stop()` は最初のエラーを保持し、通信復旧はエラーを消さない。最新のAPI失敗は00:24:45.598のCONNECTタイムアウトだが、画面の停止理由がBODYのままでも矛盾ではない。停止を発動した原因と、その後の最終通信エラーは別の情報である。

根拠: `apps/worker/src/operations.ts:329`、`apps/worker/src/index.ts:401`。startはerror/emergencyがあれば `RESET_REQUIRED`、APIバックオフ中も拒否する。reset後もrunning=falseで、開始は別操作。

## 2. 運用停止理由の全履歴

以下は保存済み7日窓（このDBで観測された全期間）にあるSTOP/BOOT全21記録。すべて日本時間。STOP/BOOTはすべて「稼働中から障害で落ちた」ことを意味しない。停止済み状態への操作や、停止中に初めてエラーを保持した場合も記録される。

| 日時 JST | 種別 | コード |
|---|---|---|
| 2026-10-21 20:19:30.227 | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-21 20:38:40.394 | STOP | UPSTREAM_TIMEOUT |
| 2026-10-21 21:41:00.786 | STOP | MARKET_DATA_STALLED |
| 2026-10-22 05:00:06.924 | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 05:01:05.257 | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-22 06:45:43.090 | STOP | MANUAL_STOP |
| 2026-10-22 09:48:20.987 | STOP | UPSTREAM_TIMEOUT |
| 2026-10-22 18:36:26.330 | STOP | UPSTREAM_TIMEOUT |
| 2026-10-22 18:54:18.500 | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 18:54:20.865 | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-22 19:27:52.632 | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 19:27:55.203 | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-22 19:40:54.061 | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 19:40:57.056 | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-23 00:11:34.357 | STOP | MANUAL_STOP |
| 2026-10-23 00:14:18.388 | STOP | UPSTREAM_TIMEOUT |
| 2026-10-23 00:16:17.749 | STOP | MANUAL_STOP |
| 2026-10-23 00:21:24.919 | STOP | PROCESS_SHUTDOWN |
| 2026-10-23 00:21:27.533 | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-23 00:23:26.897 | STOP | UPSTREAM_BODY_TIMEOUT |
| 2026-10-23 00:24:26.278 | STOP | UPSTREAM_BODY_TIMEOUT |

内訳は、再起動時BOOT 6件、終了STOP 5件、手動停止3件、UPSTREAM_TIMEOUT 4件、BODY_TIMEOUT 2件、MARKET_DATA_STALLED 1件。再作成の終了と起動を両方数えるため、単一の保守操作でも2件となる。

解除・開始の全記録:

| 日時 JST | 操作 |
|---|---|
| 2026-10-21 20:41:27.270 | MANUAL_RESET |
| 2026-10-21 20:41:41.673 | MANUAL_START |
| 2026-10-22 06:43:42.073 | MANUAL_RESET |
| 2026-10-22 06:43:55.168 | MANUAL_START |
| 2026-10-22 18:29:19.907 | MANUAL_RESET |
| 2026-10-22 18:30:30.260 | MANUAL_START |
| 2026-10-23 00:10:32.774 | MANUAL_RESET |
| 2026-10-23 00:10:37.888 | MANUAL_START |
| 2026-10-23 00:12:11.917 | MANUAL_START |
| 2026-10-23 00:16:25.173 | MANUAL_RESET |
| 2026-10-23 00:16:34.323 | MANUAL_START |
| 2026-10-23 00:23:11.500 | MANUAL_START |
| 2026-10-23 00:23:50.242 | MANUAL_RESET |
| 2026-10-23 00:23:51.469 | MANUAL_START |

## 3. エラー・異常件数の読み方

観測B（2026-10-23 00:29:29 JST）のAPIとUIで同じ集計結果:

| 窓 | ERROR | ANOMALY | 停止理由(STOP+BOOT) | 約定 | Profit Guard見送り | RiskEngine見送り |
|---|---:|---:|---:|---:|---:|---:|
| 24時間 | 102 | 121 | 18 | 0 | 0 | 0 |
| 7日間 | 106 | 125 | 21 | 0 | 0 | 0 |

ユーザー提示値（100/119、104/123、14/17）より増えている。今回の取得時点までに追加された停止・障害記録を含むためで、過去の画面の厳密な取得時刻は不明。件数の増加そのものを記録不具合とは断定しない。

`OperationMonitor.report()` (`apps/worker/src/operations.ts:501-541`) は ERRORとANOMALYを別々に単純計数する。API種別イベントやrisk_eventsをそのまま数えた値ではない。

7日窓の内訳（観測C、下記時刻）:

| イベント種別/コード | 件数 |
|---|---:|
| ANOMALY/MARKET_DATA_STALLED | 11 |
| ERROR/MARKET_DATA_STALLED | 6 |
| ERROR/MARKET_UPSTREAM_TIMEOUT | 32 |
| ANOMALY/UPSTREAM_TIMEOUT | 32 |
| ERROR/HEALTH_SUI_READ_FAILED | 53 |
| ANOMALY/SUI_READ_FAILED | 53 |
| ERROR/MARKET_SPREAD_TOO_WIDE | 1 |
| ANOMALY/SPREAD_TOO_WIDE | 1 |
| ANOMALY/CONSECUTIVE_API_ERRORS | 14 |
| ERROR/MARKET_API_CANCELLED | 1 |
| ANOMALY/API_CANCELLED | 1 |
| ERROR/MARKET_CANDLE_GAP | 1 |
| ANOMALY/CANDLE_GAP | 1 |
| ERROR/MARKET_UPSTREAM_CONNECT_TIMEOUT | 10 |
| ANOMALY/UPSTREAM_CONNECT_TIMEOUT | 10 |
| ERROR/MARKET_UPSTREAM_DNS_FAILED | 2 |
| ANOMALY/UPSTREAM_DNS_FAILED | 2 |

### 重複の扱い

- `request()` が失敗すると `ERROR: HEALTH_SUI_READ_FAILED` などを記録し、engineのcatchが `failCycle()` を呼ぶと同じ失敗に `ANOMALY:SUI_READ_FAILED` を追加する（operations.ts:277付近、344、engine.ts:527-537）。ERRORとANOMALYを足して独立障害件数としてはいけない。
- 53件のHEALTH_SUI_READ_FAILEDと53件のSUI_READ_FAILED、32件のMARKET_UPSTREAM_TIMEOUTと32件のUPSTREAM_TIMEOUT、10件のMARKET_UPSTREAM_CONNECT_TIMEOUTと10件の同ANOMALYなどは対応する層別記録。
- MARKET_DATA_STALLEDはERROR 6件に対しANOMALY 11件。同一取得の期限超過とcatchの二重経路で異常記録が追加される。CONSECUTIVE_API_ERRORS 14件も個々の失敗に上乗せされる派生アラート。
- APIイベント256件は試行単位。初回失敗・再試行を含み、成功した再試行もある。これを256回のBot停止とは読めない。
- 全層を束ねる永続requestId/cycleIdが不足するため、時間近接だけで推測した「独立障害総数」は出さない。今回の正確な値は記録種別別の件数とSTOP/BOOT履歴である。

## 4. 売買判断・実行経路

全分析の状態別内訳は下表。RUNNING/STOPPEDは、分析の記録時刻（tick開始時刻）以前の最後のCONTROL/STOP/BOOTから復元した**開始時点の分類**。取得中に停止する場合もあるため、注文直前の許可を表す値ではない。

| 開始時の状態 / 判断 / 理由 | 件数 |
|---|---:|
| STOPPED/WAIT/条件未成立 | 1265 |
| STOPPED/WAIT/出来高異常 | 192 |
| RUNNING/WAIT/条件未成立 | 58 |
| RUNNING/WAIT/出来高異常 | 11 |

観測C（全件集計の固定時刻）: **2026-10-23 00:31:26.391 JST**。分析 1526 件、初回 2026-10-21 20:19:30.264、最終 2026-10-23 00:31:09.981 JST。

BUY/SELL候補の最後の発生時刻: **該当なし（保存された全分析で0件）**。候補、paper_orders、paper_tradesもすべて0件。履歴は約28時間の範囲で、実際に7日間の取引判断を完走した記録ではない。

観測Aの分析1,523件は、条件未成立1,320件、出来高異常203件。観測Cまでに正常WAIT分析3件が増えている。engine catchが書く現在のdecision=WAITと、成功時に保存するstrategy_decisionsを分離して集計したため、通信エラーを戦略WAITへ混入していない。

`RuleBasedStrategy.analyze()` (`packages/strategy-engine/src/index.ts:10-68`) のBUYには次の全条件が必要:

1. 現在EMA20 > EMA50。
2. 一つ前の確定足RSI <= oversold=30、現在RSI > 30という**回復クロス**。
3. MACD histogramが前足より改善。
4. 最新2本の出来高が正で、出来高変化の絶対値がmaxVolumeChange=4以内。

SELLにもEMA/RSI/MACDの同時条件、または保有建玉の損切り・利確条件が必要。現在SUI=0で建玉がない。単に価格が動いたことや、データ取得が成功したことはBUY条件ではない。現設定strategyはrule-basedで、外部AIが別途注文候補を生成している構成ではない。

追加の指標読取（2026-10-23 00:36:09.964 JSTの分析）では、EMA20=0.97982023、EMA50=0.98254017、RSI=43.87088、MACD histogram=-0.00060021、出来高変化=-0.81588。EMA20 > EMA50というBUY必須条件が不成立である。これは当該分析の例であり、過去全件のWAITをこの一条件だけで説明するものではない。

具体的な実行順序:

| 段階 | コード | 実測 |
|---|---|---|
| Sui health | engine.ts:85 | 失敗すると市場取得・分析前に中断 |
| 市場取得・全時間足/鮮度/同一市場検証 | engine.ts:86-120 | 成功も失敗もある |
| 指標計算・戦略分析・保存 | engine.ts:134-148 | 継続、すべてWAIT |
| runtime/emergency/error/同一足ゲート | engine.ts:194-200 | 停止中はここでreturn |
| WAITゲート | engine.ts:201-205 | 稼働中でもWAITならreturn |
| 候補生成 | engine.ts:206以降 | 0件 |
| 見積もり・資金/数量・Profit Guard | engine.ts:235以降、385 | 未到達 |
| RiskEngine・見積もり有効期限・最終稼働状態 | engine.ts:398-443 | 未到達 |
| PAPER fill保存・照合 | database/index.ts:241以降 | 注文/約定0件 |

従って、PG/risk見送り0は「それらの安全チェックが不要」でも「緩和すれば取引できる」でもなく、候補が出ていないため。USDC100、maxOrder2の設定は確認したが、見積もり未取得なので最小数量や手数料が実注文を通過するかは未検証。

停止中も分析を保存するのは既存仕様。注文直前にもruntimeを再読込するゲートがある。今回、停止中の分析を実行に渡した証拠はなく、候補・注文・約定0が一致する。記録不具合で約定だけ消えたことを示す残高変動もない。ただし未発生の約定経路の正当性を実証したわけではない。

## 5. 通信障害の段階別証拠

公開ホストは `deepbook-indexer.mainnet.mystenlabs.com`。以下は保存されたAPIイベント全256件の分類。末尾の空欄は取得不能であり、成功やHTTP 0を意味しない。

| API / 処理 / コード / 段階 / causeCode / HTTP | 件数 |
|---|---:|
| Sui gRPC / SUI_GRPC_READ / UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT /  /  | 54 |
| DeepBook Indexer / MARKET_STATUS / UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT /  /  | 46 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT /  /  | 30 |
| DeepBook Indexer / ORDERBOOK_FETCH / UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT /  /  | 29 |
| Sui gRPC / SUI_GRPC_READ / UPSTREAM_DNS_FAILED / DNS / EAI_AGAIN /  | 16 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_BODY_TIMEOUT / BODY /  / 200 | 2 |
| DeepBook Indexer / PROVIDER_HEALTH / UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT /  /  | 8 |
| Sui gRPC / SUI_GRPC_READ / UPSTREAM_DNS_FAILED / DNS / ENOTFOUND /  | 4 |
| DeepBook Indexer / OHLCV_FETCH / API_CANCELLED / HEADERS_OR_CONNECT /  /  | 1 |
| DeepBook Indexer / MARKET_STATUS / UPSTREAM_TIMEOUT / CONNECT /  /  | 2 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_TIMEOUT / CONNECT /  /  | 4 |
| DeepBook Indexer / MARKET_STATUS / UPSTREAM_TIMEOUT / TLS /  /  | 8 |
| DeepBook Indexer / MARKET_STATUS / UPSTREAM_TIMEOUT / DNS /  /  | 7 |
| DeepBook Indexer / PROVIDER_HEALTH / UPSTREAM_TIMEOUT / CONNECT /  /  | 1 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_BODY_TIMEOUT / BODY /  /  | 10 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_TIMEOUT / DNS /  /  | 4 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_CONNECT_TIMEOUT / CONNECT /  /  | 13 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_DNS_FAILED / DNS / ERR_HTTP2_STREAM_CANCEL /  | 2 |
| DeepBook Indexer / MARKET_STATUS / UPSTREAM_CONNECT_TIMEOUT / CONNECT /  /  | 5 |
| DeepBook Indexer / ORDERBOOK_FETCH / UPSTREAM_CONNECT_TIMEOUT / CONNECT /  /  | 3 |
| DeepBook Indexer / ORDERBOOK_FETCH / UPSTREAM_TIMEOUT / TLS /  /  | 1 |
| DeepBook Indexer / PROVIDER_HEALTH / UPSTREAM_TIMEOUT / TLS /  /  | 2 |
| DeepBook Indexer / OHLCV_FETCH / UPSTREAM_TIMEOUT / TLS /  /  | 4 |

### 最新の停止を発動した一連の通信

- 00:23:26.896 JST: OHLCV_FETCH BODY timeout、8,002ms → 翌1msでSTOP。
- 00:23:35.987: 同取得のTLS待ち、8,004ms。
- 00:23:46.181: 同取得のCONNECT待ち、8,000ms。
- 00:23:50.242: 手動解除、00:23:51.469: 手動開始。
- 00:24:26.277: 次のOHLCV_FETCH BODY timeout、8,002ms → 翌1msで再STOP。
- 00:24:35.503: TLS待ち、8,001ms。
- 00:24:45.598: CONNECT待ち、8,002ms、retryCount=2。dnsMs=3、TCP/TLS完了時刻なし。

最後の例はDNS解決後、TCP接続が8秒内に完了しなかった証拠。TLS段階の記録はTCP以降TLS完了前、BODYは受信途中の時間切れを区別する。BODYの10件ではstatus=nullのためHTTPステータスの断定は不可。旧2件のみ200が保存されている。

`deepbook-transport.ts:40-65,88-137` の計測は段階・累積時間。`shared/api.ts:237-275` は初回一時障害でも**再試行前に安全停止**し、最大2回の再試行を行う。このため「リトライで最終成功したのにBotが止まる」ことは既存ポリシー通りである。今回はそのポリシーを変更しない。

DNSにはDeepBookの待ち時間超過、SuiのEAI_AGAIN/ENOTFOUNDも存在。DeepBookの `ERR_HTTP2_STREAM_CANCEL` をDNS失敗として記録した2件は、DNS段階でストリーム取消を観測したことまでしか証明しない。名前が存在しないという確定証拠ではない。

### 今回の読み取り専用接続検証

2026-10-23 00:31:55.308 JST開始、アプリと同じ公開status URLをNode HTTP/2で1回取得:

| 項目 | 実測 |
|---|---|
| Windows / コンテナ DNS A | 両方34.54.113.162 |
| コンテナDNS | 1,613ms |
| TCP完了 | 開始から1,721ms |
| TLS完了 | 開始から2,370ms、証明書検証true、ALPN=h2 |
| HTTPヘッダー | 3,057ms、200 |
| 全文受信 | 3,066ms、status=OK、Indexer遅延1秒 |

累積時間であり、各値を単純加算しない。診断の成功は長期安定の証明ではなく、履歴の断続障害を否定しない。直近の通常取得も成功しているため、URLが常に不正、常時DNS故障、常時TLS証明書不正という説明は合わない。

公開status GETは注文や秘密鍵を使用しない。常用の取引取得経路の設定は変更していない。保存APIイベントおよび検証セッションのコード別内訳では429/502/503/504は確認されない。現在の0件を429と断定する根拠はない。

ネットワークのどの機器・経路・製品がタイムアウトを起こしたかは未確定。ESET、Windows、DockerのDNS/仮想ネットワーク、回線、外部サービスを区別する同時パケット証拠はない。既存のESET調査だけで因果関係を断定しない。

## 6. 鮮度・欠損とMARKET_DATA_STALLED

MARKET_DATA_STALLEDはERROR 6記録、STOP 1記録あり。ERRORの発生時刻と診断は以下。通信が成功しても、確定足が古い、または取得全体が期限を超えると失敗する。

| 日時 JST | 詳細 | 確定足経過秒 | 取得経過ms |
|---|---|---:|---:|
| 2026-10-21 21:41:00.786 | 旧記録・詳細なし |  |  |
| 2026-10-22 12:44:08.493 | FETCH_DEADLINE_EXCEEDED | 248.493 | 60826.9454779997 |
| 2026-10-22 18:01:01.861 | CANDLE_STALE | 361.861 | 55774.7593519986 |
| 2026-10-22 18:06:08.325 | CANDLE_STALE | 368.325 | 62303.4073769972 |
| 2026-10-22 18:07:57.254 | CANDLE_STALE | 477.254 | 50630.9835779965 |
| 2026-10-22 22:45:03.321 | CANDLE_STALE | 603.321 | 54305.6598819997 |

旧記録は詳細なしのため、当時の正確な鮮度・取得中状態は復元できない。詳細付き5件には取得50～62秒、確定足361～603秒などがあり、単に直近HTTP成功時刻だけで正常とは扱えない（operations.ts:242-278）。うち5件は独立のSTOP追加を伴っていない。既に停止・エラー保持中にも取得側のfailCycleが記録されるためである。

CANDLE_GAPはERROR 1 / ANOMALY 1、SPREAD_TOO_WIDEも各1。これらも不正なデータを通さず分析前に中断する経路。

最新の300秒足品質は元データ999本、検証済み再構築2本、未解決0本。一方、セッション累積レポートは未解決1本（timestamp=1792374900、2026-10-19 10:55 JST）を保持している。現在の窓の品質と、過去に観測した欠損の累積評価は別である。

集計 (`validation.ts:335-357`) は各cycleのgapTimestampsを受けるたびresolvedから削除し、そのcycleの正常なtimestampsだけを再追加する。失敗cycleでframes/timestampsが空の場合、以前再構築証拠がある足でも未解決に戻り、後に取得範囲外へ出ると残り得る。実際、累積再構築証拠にも1792374900がある。**未解決1という表示だけをもって現在の取引入力に欠損があるとは判断できない。** 正確な最後の状態遷移・範囲外移動を追う追加テストが必要で、今回コード変更や過去レポートの書換えは行わない。

この点はレポート品質上のP1候補であり、取引0件の直接原因と断定しない。現在はエラー保持とWAITで先に止まり、最新の取引用品質自体は未解決0。

## 7. 24時間検証セッション

観測Bのセッション:

| 項目 | 値 |
|---|---|
| ID | 5f1608fe-24e3-48fd-a287-2ef8ac28a389 |
| 開始 | 2026-10-22 06:45:57.881 JST |
| 24時間目標 | 2026-10-23 06:45:57.881 JST |
| 経過 | 63,809,758ms（約17時間43分） |
| PAPER実稼働 | 879,812ms（約14分40秒） |
| 計測サンプル | 4,261 |
| 最大計測空白 | 19,862ms |
| 計測保存障害 | integrityFault=null |
| 分析 | 976件、BUY0 / SELL0 / WAIT976 |
| 手動開始 / 解除 / 再起動 | 6 / 5 / 4（セッション範囲） |
| 不正約定 / 証拠欠落 / 自動再開 | 0 / 0 / 0 |

DeepBookは12,852試行中12,679成功（98.6539%）、173失敗、再試行134、平均620.6ms/P95=939ms。Suiは760試行中690成功（90.7895%）、70失敗、平均1,552ms/P95=10,001ms。これは永続計測からのセッション値。プロセス再起動でリセットされる現在のAPIメモリカウンターと混同しない。

セッションは同じIDで計測を継続し、履歴が保存されている。今回の読取で削除・初期化・セッション変更はしていない。ただしSQLite全体の物理integrity_checkや、全履歴の独立再計算まで実施したわけではない。画面のintegrityFault=nullは計測機能の保存障害フラグでありDB全体の完全性証明ではない。

24時間未満かつ実稼働不足、API99%未達、周期正常率不足、累積未解決欠損などで**合格ではない**。時計が24時間経過しても停止時間は実稼働にならない。約定0件なのでfillChecksExercised=falseであり、「不正約定0」を約定時の安全条件が実動作検証済みと誤認しない。

## 8. 改善優先度と安全な再開条件

### P0（売買・安全条件を緩めず、正常な判断経路を維持）

1. 8秒内にTCP/TLS/BODYを完了できない断続障害の切り分けを継続する。同一UTC時刻・request/cycle IDでホスト/コンテナのDNS、TCP、TLS、HTTP/2経路を突き合わせる。実行は停止中の少数リクエストに限定し、サービス・ESET停止やTLS検証無効化を修正案にしない。
2. DeepBookだけでなく、先行必須のSui health障害も対象にする。Sui障害はDeepBookが正常でもそのcycleの分析前に止める。Sui P95=10秒、DNS失敗20件（セッション）を見落とさない。
3. 復旧確認なしにreset/startを反復しない。今回も手動再開後、約15秒・約35秒で再停止している。上限・鮮度・即時停止を変えて見かけの稼働時間を増やさない。

### P1（可観測性・検証品質）

1. 「現在のBot停止」「最新通信成功」「最後に停止を起こした失敗」「最新失敗」を分離し、初回失敗がリトライ成功でも停止を保持する旨を画面に明示する。
2. ERROR/ANOMALY/試行/独立障害/実際の稼働→停止遷移の件数を区別する。共通requestId/cycleIdで重複とretryを関連付け、単に時刻近接で削除しない。
3. 戦略分析に条件ごとの成立/不成立、対象足、稼働中/停止中、注文ゲートの中断理由を監査可能にする。現時点でBUY0なのは事実だが、全分析の各条件の寄与率を保存済み理由だけから推測しない。
4. セッション累積欠損のresolved状態遷移を、失敗cycle・空timestamps・取得範囲外・既存provenanceの回帰テストで確認する。解消済みと最新未解決を混同せず、過去の失敗記録は保存する。

### 再開に必要な条件

- 原因切り分け後、Sui healthとDeepBook全処理（OHLCV全時間足、status、板）が既存上限内で継続成功すること。単発status成功だけで再開可能とはしない。
- 最新確定足の鮮度、欠損0または検証済み再構築、板の鮮度・深さ・スプレッド、Indexer遅延が既存条件を満たすこと。
- APIバックオフ解除、Profit Guard有効、PAPERプロファイル、ledger照合正常を確認する。
- 管理者が原因を確認してから、既存認証・確認付き操作で手動解除、続けて手動開始する。復旧による自動再開は禁止のまま。
- WAITが続くこと自体を異常として売買を強制しない。BUY候補が自然に発生したときだけ、既存の見積もり・Profit Guard・RiskEngine・最終稼働ゲートを通す。
- 現セッションを維持して障害証拠を保存する。現在の固定24時間窓では実稼働要件を満たせないため、安定化後の新たな24時間試験は別途ユーザー判断とする。今回新規セッションは開始していない。

## 9. 実施・未実施

実施: 読取専用SQLite全件集計、認証済み状態GET、コード経路照合、コンテナID/起動時刻の確認、ホスト/コンテナDNS、公開statusのHTTP/2 GET 1回、報告書の差分チェック。

未実施: Bot再開・解除、Docker更新/再起動、環境やコード修正、実注文、ESET設定変更、パケット採取、24時間追加運転、ユニット/E2E/ビルド（文書のみの変更のため）。

コンテナは調査前後ともID `5a3c6580b7ae7afd8a311a33f41f8bde72f2f850610b42cd7fd0858ae26d89c2`、起動 `2026-10-22T15:21:26.01139313Z`。healthyはHTTPサービスの正常性であり、PAPER稼働中を意味しない。
