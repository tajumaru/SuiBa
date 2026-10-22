# PAPER 24時間運用テスト 第1回 終了監査

監査日：2026-10-23 JST。対象：tajumaru/SuiBa、sui-ai-trading-bot、127.0.0.1:3101。

## 1. 総合判定：FAIL

**24時間計測は完了。24時間PAPER正常稼働は不合格。** 連続計測・物理DB整合性は確認できたが、実稼働約30分、API成功率・取得周期正常率・累積データ品質が要件未達。売買0件自体を不合格理由にはしていない。約定経路は未行使であり、安全な約定・会計を検証済みとは判定しない。

試験終盤にコンテナ更新があり、複数実装を含む試験である。最新mainの24時間耐久性・通信復旧効果を実証した試験とは言えない。監査時点ではruntime.running=trueだが、これは過去24時間の正常完走を意味しない。

### 調査方法・証拠範囲

- 初回DB観測：2026-10-23 06:49:26.723 JST。確定APIレポート生成：2026-10-23 06:49:27.547 JST。
- 対象コンテナ内部のDATABASE_PATHをNode DatabaseSyncのreadOnly:trueで直接開き、PRAGMA query_only=ON、BEGIN/ROLLBACK内のSELECTとintegrity_checkで確認。アプリのDB初期化クラスは使用していない。既存SQLite・ログの更新、checkpoint、VACUUM、DDLなし。
- GET /api/operations と /api/validation を照合。制御POSTなし。認証値はコンテナ内のみで使用し、出力・コミットしていない。
- validation_events、strategy_decisions等を固定セッションの開始〜終了で全件集計。画面の履歴件数上限を使っていない。APIレポートは終了境界確認のため終了後45秒までのsampleを参照するため、終了内のsample件数とは区別する。
- ローカルdata/run1-{initial,records,hashes,all-hashes}.json、run1-api.jsonlに選択した読取結果を保存（Git管理外、コミット対象外）。DB集計とAPI読取は別時刻だが、評価対象窓は終了済み。
- 現コンテナログ末尾は「PAPER dashboard/API ready」。旧コンテナのstdoutログ全体は今回取得できていない。停止・障害の過去履歴は永続SQLiteを主証拠にする。
- 作業ツリーはperf/display-aggregationで別作業の未コミット変更あり。変更を取り消さず、監査基準はGitHub mainの固定SHA。レポートのみmainにコミットし、既存作業ブランチ・indexは維持する。

## 2. 重要指標一覧

| 指標 | 確認値・判定 |
|---|---|
| セッションID | 5f1608fe-24e3-48fd-a287-2ef8ac28a389 |
| 開始 | 2026-10-22 06:45:57.881 JST |
| 評価終了 | 2026-10-23 06:45:57.881 JST |
| 評価時間 | 86,400,000ms＝24時間 |
| 終了内のsample実測範囲 | 開始〜2026-10-23 06:45:56.847、23:59:58.966 |
| 終了確認sample | 06:46:11.842（終了13.961秒後、許容45秒内） |
| 計測sample / 最大空白 | 終了内5,768・境界確認後を含むAPI集計5,771 / 19,862ms（45秒以内） |
| セッションintegrityFault | null（計測保存異常の未検出） |
| SQLite integrity_check | ok（物理整合性。全業務証拠の正当性保証とは別） |
| PAPER実稼働 | 1,813,591ms＝00:30:13.591、評価時間の2.099% |
| 非稼働時間 | 84,586,409ms＝23:29:46.409（24h−記録稼働時間） |
| 市場取得周期 | 1,443、正常1,351、異常92、正常率93.6244% |
| 戦略判断 | BUY 0 / SELL 0 / WAIT 1,351 |
| WAIT理由 | 条件未成立1,167 / 出来高異常184 |
| 安全STOP記録 | 6（UPSTREAM_TIMEOUT 3、BODY_TIMEOUT 2、終了時API_CANCELLED 1） |
| 稼働→通信異常STOP | 4（停止中の初回エラー保持、shutdown後のcancelを除外） |
| 最初の安全STOP | 10/22 09:48:20.987 UPSTREAM_TIMEOUT。開始時すでに手動停止中 |
| 最初の稼働→異常STOP | 10/22 18:36:26.330 UPSTREAM_TIMEOUT |
| 最後の安全STOPコード | 10/23 06:33:08.511 API_CANCELLED（shutdownの100ms後） |
| 最後の通信起因稼働停止 | 10/23 00:24:26.278 UPSTREAM_BODY_TIMEOUT |
| 最後のSTOP記録 | 10/23 06:40:10.071 MANUAL_STOP。その後RESET/STARTあり |
| 手動START / RESET / BOOT | 8 / 7 / 5（セッション内） |
| 注文候補 / PAPER注文 / 約定 / paper_checks | 0 / 0 / 0 / 0 |
| Profit Guard評価 / 拒否 | 0 / 0 |
| RiskEngine注文拒否 | 0。risk_events 92件は周期エラーであり注文拒否ではない |
| 不正約定 / 証拠欠落 / 無許可再開 | レポート上0 / 0 / 0。約定チェック未行使 |
| 通信復旧認可イベント | guardedRecoveries=0（復旧成功経路の実証なし） |
| 残高・会計 | USDC100、SUI0、fees0、realized0、PnL0 |

稼働時間はmonitor累積値から開始時3,667,035msを控除した値。終了前最後の累積5,480,626msを使用し、終了までの約1.034秒を稼働として外挿しない。非稼働時間もこの記録値に基づく。HTTPサービスがrunning/healthyであることとBot稼働は別。

## 3. 時系列の停止・復旧履歴

開始13.791秒前の10/22 06:45:43.090にMANUAL_STOP。したがって試験開始からBotが24時間稼働していたわけではない。以下はセッション内のCONTROL/STOP/BOOT全件。CONTROLは人の認証済み操作記録であり、今回の監査操作ではない。

| 日時 JST | 種類 | コード |
|---|---|---|
| 2026-10-22 09:48:20.987 JST | STOP | UPSTREAM_TIMEOUT |
| 2026-10-22 18:29:19.907 JST | CONTROL | MANUAL_RESET |
| 2026-10-22 18:30:30.260 JST | CONTROL | MANUAL_START |
| 2026-10-22 18:36:26.330 JST | STOP | UPSTREAM_TIMEOUT |
| 2026-10-22 18:54:18.500 JST | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 18:54:20.865 JST | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-22 19:27:52.632 JST | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 19:27:55.203 JST | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-22 19:40:54.061 JST | STOP | PROCESS_SHUTDOWN |
| 2026-10-22 19:40:57.056 JST | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-23 00:10:32.774 JST | CONTROL | MANUAL_RESET |
| 2026-10-23 00:10:37.888 JST | CONTROL | MANUAL_START |
| 2026-10-23 00:11:34.357 JST | STOP | MANUAL_STOP |
| 2026-10-23 00:12:11.917 JST | CONTROL | MANUAL_START |
| 2026-10-23 00:14:18.388 JST | STOP | UPSTREAM_TIMEOUT |
| 2026-10-23 00:16:17.749 JST | STOP | MANUAL_STOP |
| 2026-10-23 00:16:25.173 JST | CONTROL | MANUAL_RESET |
| 2026-10-23 00:16:34.323 JST | CONTROL | MANUAL_START |
| 2026-10-23 00:21:24.919 JST | STOP | PROCESS_SHUTDOWN |
| 2026-10-23 00:21:27.533 JST | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-23 00:23:11.500 JST | CONTROL | MANUAL_START |
| 2026-10-23 00:23:26.897 JST | STOP | UPSTREAM_BODY_TIMEOUT |
| 2026-10-23 00:23:50.242 JST | CONTROL | MANUAL_RESET |
| 2026-10-23 00:23:51.469 JST | CONTROL | MANUAL_START |
| 2026-10-23 00:24:26.278 JST | STOP | UPSTREAM_BODY_TIMEOUT |
| 2026-10-23 06:23:15.158 JST | CONTROL | MANUAL_RESET |
| 2026-10-23 06:23:18.353 JST | CONTROL | MANUAL_START |
| 2026-10-23 06:33:08.411 JST | STOP | PROCESS_SHUTDOWN |
| 2026-10-23 06:33:08.511 JST | STOP | API_CANCELLED |
| 2026-10-23 06:33:11.458 JST | BOOT | PROCESS_RESTART_STOPPED |
| 2026-10-23 06:40:10.071 JST | STOP | MANUAL_STOP |
| 2026-10-23 06:40:12.081 JST | CONTROL | MANUAL_RESET |
| 2026-10-23 06:40:13.111 JST | CONTROL | MANUAL_START |

STOPやBOOTをすべて「異常停止回数」と数えない。安全STOP 6件のうち09:48は停止中のエラー保持、06:33のAPI_CANCELLEDはPROCESS_SHUTDOWN後。稼働中の通信起因停止は18:36、00:14、00:23、00:24の4回。再起動5件は停止・起動双方が記録され、重複加算しない。手動再開の後も短時間で再停止した履歴がある。

## 4. 売買0件の根本原因と証拠

直接原因は**全保存戦略判断がWAITで、BUY/SELL候補生成に一度も達していないこと**。停止時間の長さも取引可能時間を制限したが、「停止しなければBUYが出た」とは証明できない。

保存分析1,351件は取得正常周期1,351件と一致。周期開始直前の最後のCONTROL/STOP/BOOTで分類すると稼働開始状態27件、停止開始状態1,324件。これは周期開始時の復元であり、取得途中の停止や注文直前の許可を保証しない。停止中も分析する実装なので、非稼働時間を全て「分析できなかった周期」に換算してはいけない。

分析前に中断した92周期：

| 周期エラー | 件数 |
|---|---:|
| SUI_READ_FAILED | 46 |
| MARKET_DATA_STALLED | 5 |
| UPSTREAM_TIMEOUT | 26 |
| API_CANCELLED | 2 |
| CANDLE_GAP | 1 |
| UPSTREAM_CONNECT_TIMEOUT | 10 |
| UPSTREAM_DNS_FAILED | 2 |

これは戦略未評価でありWAITに含めない。スケジューラーの欠落・skipした予定slotの厳密な総数は、周期イベント数からは確定できない。1443−1351＝92は記録済み周期の失敗数である。

経路はSui health→市場3足・板・鮮度検証→指標計算・戦略分析保存→稼働/停止ゲート→WAITゲート→候補→見積り/資金/数量→Profit Guard/RiskEngine→PAPER約定/会計検査。根拠はapps/worker/src/engine.tsとpackages/strategy-engine/src/index.ts、DB各表の全件集計。

rule-based BUYはEMA20>EMA50、前RSI<=oversoldかつ現RSI>oversold、MACD histogram改善、直近2足の正の出来高と出来高変化制限の同時成立が必要。SELLは反対側の条件または保有建玉の損切り/利確。保存理由は条件未成立1,167・出来高異常184で、各指標条件の寄与率は理由だけでは確定できない。SUI0で建玉なし。

候補0、profit_assessments0、orders/trades/checks0、残高不変が整合する。残高不足、最小注文数量、手数料、Profit Guard/RiskEngineが売買を阻止したという証拠はない。見積り以降の経路未到達なので、USDC100でも実際の最小数量・手数料・純利益条件を通過するかは未検証。制限緩和や売買強制を対処にしない。

## 5. 通信・データ品質

### 試行単位の通信成績

キャッシュhitを除く永続API計測。retryは新しい試行として分母に含む。周期成功率、独立障害数、STOP数とは異なる。

| API | 試行 | 成功 | 失敗 | 成功率 | 失敗率 | retry | 平均ms | P95ms | 最大ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| DeepBook Indexer | 17384 | 17208 | 176 | 98.9876% | 1.0124% | 136 | 536.0 | 900 | 8219 |
| Sui gRPC | 1014 | 942 | 72 | 92.8994% | 7.1006% | 0 | 1307.7 | 10000 | 10004 |

DeepBook失敗コード：TIMEOUT137、BODY14、CONNECT21、DNS2、CANCELLED2。Sui：TIMEOUT51、DNS21。全失敗248試行の段階別内訳：

| API | 段階 | cause | HTTP | 件数 |
|---|---|---|---|---:|
| DeepBook Indexer | HEADERS_OR_CONNECT | なし | 未取得 | 106 |
| Sui gRPC | HEADERS_OR_CONNECT | なし | 未取得 | 51 |
| Sui gRPC | DNS | EAI_AGAIN | 未取得 | 17 |
| DeepBook Indexer | BODY | なし | 200 | 2 |
| Sui gRPC | DNS | ENOTFOUND | 未取得 | 4 |
| DeepBook Indexer | CONNECT | なし | 未取得 | 28 |
| DeepBook Indexer | TLS | なし | 未取得 | 15 |
| DeepBook Indexer | DNS | なし | 未取得 | 11 |
| DeepBook Indexer | BODY | なし | 未取得 | 12 |
| DeepBook Indexer | DNS | ERR_HTTP2_STREAM_CANCEL | 未取得 | 2 |

HEADERS_OR_CONNECTは旧版の区別不能段階。DNSのERR_HTTP2_STREAM_CANCELはDNS中の取消であり名前不在の証明ではない。HTTP未取得をHTTP0や429と読まない。失敗ログにHTTP429/API_RATE_LIMITEDはなく、この窓のレート制限発生証拠はない。上流の非公開制限や未記録の挙動まで不存在と保証しない。

### 失敗と停止の対応・遅延

- 10/22 09:48:20.986 OHLCV 1m timeout（8,004ms）→09:48:20.987 STOP。停止済みへのエラー保持。
- 10/23 00:23:26.896 BODY timeout（8,002ms）→翌1ms STOP。その後TLS 8,004ms、CONNECT 8,000msのretry。
- RESET/START後、00:24:26.277 BODY timeout（8,002ms）→翌1ms再STOP。00:24:35.503 TLS、00:24:45.598 CONNECTまでretryが継続。通信最終エラーと保持中の停止理由は別。
- 06:33:08.411 PROCESS_SHUTDOWN→100ms後API_CANCELLED。保守終了時の取消を新たなネットワーク起因の稼働停止に数えない。

旧経路は最初の一時失敗時に停止し、再試行成功でも停止保持。DeepBook1試行8秒・追加retry最大2回、待機は1〜1.25秒と2〜2.5秒。全試行timeoutなら通信だけで約24秒＋待機3〜3.75秒＋先行gRPC/キュー等。保存周期の最大は93,664msであり、現在版の45秒budgetを過去周期へ遡及適用しない。queue/backoffの全実時間は個別span不足で完全分解できない。最新mainはread budgetと根拠付き復旧を追加済みだが、本試験で復旧イベント0のため効果未実証。

ERRORとANOMALYは同じ失敗の層別記録がある。試行・retry・周期エラー・STOPを足して「障害総数」にしない。恒久requestId/cycleIdでの結合が不足する箇所は時刻対応までを証拠とする。

### 足品質と鮮度

| 項目 | 確認値 |
|---|---|
| 5分足累積unique | 1,298 |
| 重複除外した欠損 / 再構築 | 11 / 11 |
| 累積未解決 | 1、timestamp1792374900（10/19 10:55 JST） |
| 再構築失敗周期 / 失敗足観測 | 19 / 54（unique欠損数とは別） |
| 再構築時間P95 / 最大 | 5,492 / 46,376ms（45秒超過あり） |
| 周期snapshotの5分足最大missing / unresolved | 11 / 3 |
| 15分・1時間足 | 保存quality snapshotでmissing/unresolved最大0 / 0 |
| 終了直前5分足 | ORIGINAL999＋検証済み再構築2、未解決0 |
| 終了直前15分 / 1時間 | ORIGINAL672 / 168、欠損0 |
| 最終市場取得成功（評価窓） | 2026-10-23 06:45:12.551 JST |
| 最終戦略分析（評価窓） | 2026-10-23 06:45:12.651 JST |
| 5分・15分確定足終了 | 2026-10-23 06:45:00.000 JST |
| 1時間確定足終了 | 2026-10-23 06:00:00.000 JST |
| 終了時5分確定足年齢 | 57.881秒（360秒以内） |
| 最終観測Indexer遅延 | 1,000ms、累積最大8,000ms |
| 板年齢P95 / 最大 | 69,004 / 482,076ms（古いsnapshotを含む） |

累積未解決1本は同じtimestampのNO_INDEXED_TRADES再構築証拠も存在し、現在入力の欠損と同一視できない。失敗cycleの空timestampsで過去のresolvedを落とし、取得範囲外の足が未解決に残る集計上の疑義がある。最新窓が健全だから過去失敗を消すことも、累積表示だけで現在足が壊れていると断定することもしない。15分/1時間のゼロは保存qualityの範囲であり、全期間を独立オンチェーン照合した結果ではない。

NO_INDEXED_TRADESはIndexerの空trade応答・indexedThroughに基づく証拠で、独立チェーン監査ではない。古い板を含むsnapshot統計は注文に使用した板の年齢ではない。約定0で古い板による約定も0だが、注文直前ゲートは未行使。

監査現在値は2026-10-23 06:49:26.723 JSTにrunning=true、emergency=false、error=null、通信HEALTHY。最終取得成功2026-10-23 06:49:11.606 JST、最終分析2026-10-23 06:49:11.691 JST。評価終了後もサービスは継続し、検証完了で自動停止する仕様ではない。今回こちらから停止・再開していない。

## 6. 実行バージョンの確認

- GitHub main：6ff13aea54d2ed4375505557d36e3e6162722ec5。GitHub APIとgit ls-remoteの両方で確認。
- 現3101コンテナ：b5284aef2a028539c83e87b353d66ea296ae76d168c5593d92fd505d00cc6d88。
- 実イメージID（inspect .Image）：sha256:93ce59436644885fabee8289bba83d5aeb41d43bcf2a8263b7342683845e24f6。
- 作成2026-10-23 06:33:08.126 JST、起動06:33:10.277 JST、Node v24.22.1。
- OCI revisionラベルはmainと一致。一方compose.imageラベルはsha256:eb77792a63d70e4972fb6bc7f9140f5a86f8cee2f6becedf1d63c26eac37602aで、実.Imageと異なる。識別には実.Imageを採用し、ラベルだけで同一性を断定しない。
- ソース・package/lock等87ファイルをmainのgit blobとSHA256比較：64完全一致、22はmainをCRLF化すると一致、style.cssは末尾改行を正規化すると一致。対象範囲で意味的な実装差は未検出。ビルド済みdist・依存パッケージ全バイト・Dockerレイヤー全体の再現性までは検証していない。
- worker index/engine/operations/validation、shared api/paper-recovery、transportはバイト一致。strategy-engineは改行差だけで内容一致。
- 現イメージが試験内で観測されたのは終了約12分48秒前から。旧調査PAPER_ZERO_TRADES_INVESTIGATION.mdとPERFORMANCE_AUDIT.mdでは、以前のコンテナ5a3c6580…とイメージb7ddf531…、旧停止保持実装が確認されている。過去5回のBOOTそれぞれのimage/SHA対応をDBから完全復元することはできない。

したがって第1回が検証したのは**旧実装を主体に、最後にmain相当を含む混在バージョン**。終盤の短い正常観測は、最新mainの24時間成功や安全復旧・実約定の効果検証ではない。開始・再起動ごとのSHA/image/設定hash永続化が次回必須。

## 7. 次回テスト前のP0項目

1. **実行版の固定と記録**：SHA・実image digest・Node・lock hash・安全閾値・専用DB・開始状態を固定し、セッションへ保存。24時間中のデプロイ/再作成は別試験として扱う。既存RUN1履歴は保存する。
2. **通信障害の原因と復旧の検証**：Sui DNS/EAI_AGAIN/ENOTFOUND、DeepBook TCP/TLS/BODY遅延を同時刻・request/cycle IDで区別する。外部経路そのものの根本原因は今回未確定。最新mainのbudget・復旧上限を隔離環境で検証し、単発GET成功やRESET反復だけで次試験へ進めない。タイムアウト・鮮度・停止条件を緩めない。
3. **欠損集計の状態遷移**：空timestamps/失敗周期/範囲外移動/再構築済み証拠の再観測をfixtureで再現し、現在品質と累積障害を分離して正確に報告する。既存結果を上書きしない。46,376ms再構築超過も解消または安全中断を実証。
4. **評価到達と注文ゲート証跡**：予定slot、開始/完了cycle ID、戦略未到達理由、条件別WAIT、停止中分析、注文ゲート閉鎖を区別して記録。ゼロ件でも理由を全件説明できる状態にする。
5. **PAPER約定・会計の独立検証**：本番戦略を緩めず隔離fixtureでBUY/SELL、最小数量・残高・手数料・PG/Risk拒否、停止競合、冪等保存、残高/PnL/checks整合を確認。0約定の本試験を会計試験の代替にしない。

## 8. 修正後のテスト手順と合格条件

本節は提案であり今回実行していない。既存3101・既存DBの再起動や新セッション作成を監査作業に含めない。

1. 固定mainを別のPAPER専用環境・別ポート・新規専用DBに準備する。RUN1 DB/ログ/セッションを共有せず保管。LIVE設定拒否、起動時停止、認証、停止理由保持を確認。
2. モック/ローカル通信でDNS/TCP/TLS/本文timeout、429、取消、取得deadline、古い足/板、台帳異常、手動/緊急停止、再起動、注文直前の世代変更を検証する。既存safety/read-budget/recovery/PAPER会計テストを通す。
3. 取得成功2周期以上・60秒以上等の既存復旧条件と180秒/9失敗上限、手動停止後の自動再開禁止、DEGRADED/RECOVERING中の注文禁止を実証する。実施環境に応じた承認後に人が手動開始する。
4. 健全な全足・板・gRPC・台帳を確認して新規24hセッションを開始。途中の更新は行わず、開始から24時間のログを保存。異常時は既存安全条件で停止し、原因確認を優先する。
5. 終了後、終了境界sample、全周期、全試行、注文と会計を読取専用で独立再集計し、以下の領域別判定を提出する。

| 領域 | 合格条件 | 不合格・未検証の区別 |
|---|---|---|
| 安全監視・通信 | integrityFaultなし、24h計測空白<=45秒、PAPER稼働>=24h−45秒、DeepBook/Sui各成功率>=99%、周期正常率>=99%、安全停止/復旧証拠一致、無許可再開0 | 計測完了でも稼働不足/通信未達なら運用FAIL。正しく安全停止できたことは安全機能の合格として別記 |
| データ品質 | 全3足の確定・連続・鮮度、未解決0または検証済み再構築、再構築<=45秒、既存板/Indexer条件を満たす | 欠損を空足で無根拠補完、古い入力使用、累積/現在品質の説明不能はFAIL |
| 戦略評価 | 正常周期ごとの分析記録一致、BUY/SELL/WAITと条件証拠、未到達/skipの説明、稼働中評価が予定通り継続 | 停止中WAITだけで評価合格にしない。注文候補0でも正常なWAITなら評価合格可能 |
| PAPER売買・会計 | 候補→注文→約定→checksが対応、数量/手数料/残高/PnL整合、PG/Risk承認と注文直前安全証拠、不正/重複約定0 | 約定0はこの領域を未行使とする。別の隔離BUY/SELL会計試験が必要 |
| 売買0件時 | 通信/稼働/品質/評価が合格し、全WAITの理由が追跡でき、隔離PAPER約定会計試験が別途合格なら「24h無取引運用PASS、自然約定経路未行使」と明記可能 | 停止で評価不能、BUY/SELLが不明理由で消失、監査欠落、通信/品質未達ならFAIL。会計別試験なしで全経路PASSとはしない |

既存自動レポートが「約定証拠一致=true」を返しても、fillChecksExercised=falseなら約定時承認・会計実動作を合格扱いしない。合格条件変更は試験前に明記し、取引を発生させるための戦略・安全条件緩和は行わない。

## 9. 実施範囲

今回の変更は本報告書のみ。Botの自動/手動再開・停止・reset、Dockerの再起動/再作成、LIVE取引、設定/安全閾値変更、本番DB/既存ログ変更なし。外部DeepBook/Suiへの追加診断リクエストや障害注入も実施していない。文書のみのためビルド・売買テストは実行せず、DB全件件数・終了境界・API集計・実行版ハッシュと文書差分を照合した。
