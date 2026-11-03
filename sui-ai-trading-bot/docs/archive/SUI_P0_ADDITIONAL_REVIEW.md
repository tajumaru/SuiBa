# Sui P0追加レビュー・安全性検証

対象: tajumaru/SuiBa / main / `3eed3d409cf97d93ba111eea13993cc7bfa35a65`。
実施日: 2026-10-24 JST。対象SHAのcleanな既存main worktreeで作業。親作業ツリーの別ブランチ・未追跡ファイルには変更なし。

## 1. コードレビュー結果

- `packages/sui-client/src/index.ts`: `status`は完全なhealth cohortのみが正常へ更新し、通常readは`readStatus`のみ更新。通常readの成功はhealthの障害・120秒TTLを解除/更新しない。SUI/USDCの両方のmetadata検証、epoch一致、未abort、証拠保存正常が必要。
- 並列healthは共有し、fresh要求はbudgetとepochを照合。古いcohortの完了を待って自身のfresh確認を実施する。read失敗がepochを進めるため、先に開始した成功応答が新しい障害を解除しない。保守的な無効化で一時的に正常readも失敗するが、安全側の動作。
- SDK `@mysten/sui` 2.37.0のインストール済みソース`src/grpc/core.ts`と照合。`getCoinMetadata`はRPC例外をnullへ変換するため、transport unaryの`response`と`status`を観測して区別する実装は必要。`signal`→`abort`の伝達も確認。SDK更新時はこの境界を再検証する。
- HTTP成功は本文受信完了まで。HTTP 200でもgRPC失敗、gRPC OKでもmetadata decimals不正となり得る。各レイヤーは独立した結果であり、全レイヤー合算で成功率を算出してはいけない。
- `diagnostics.ts`: diagnostics_channel/socketイベントの受動観測だけ。DNS解決・RPC・retry・PING・sleep・dispatcher置換は追加しない。既存ApiAccessのtimeout/retryは維持。gRPC状態待ちはSDKが既存要求から解決するPromiseで、診断用通信ではない。
- DNS/TCP/TLSは新規接続と確定した場合のみ付与。再利用時は未取得時間をundefinedのまま保持し、tcpAttempts=0。未計測を0msや成功へ置換しない。availableはobserverの利用可否であり、全phaseの測定完了を意味しない。
- protocolはALPN/undiciの証拠に従う。h1/h2 fixtureを確認したが、実TLS/h2でのイベント網羅性は未検証。接続証拠がないtraceのprotocolは不明のまま。
- AsyncLocalStorageとrequest WeakMapにより、現在のscopeと異なるrequestの遅延イベントも関連付け可能。socket WeakMap、同時64接続のlistener上限、socket close/client close時解除、200回接続/解除を検証。長時間のRSS/GC安定性までは証明しない。
- worker初期化は同期`db.append`。`operations` APIはhealth/readを分離し観測直近50件を追加。認証経路・停止条件を変更していない。周期IDはengine→acquisition→read budget→各観測へ伝達。
- 保存障害はstickyなVALIDATION_RECORD_FAILEDとして停止。通信が直ってもそのclientは自動解除しない。手動停止・緊急停止・台帳/板/足/鮮度/世代/複数正常周期などの既存復旧条件を維持。

## 2. 発見した不具合

| 重要度 | 内容 | 影響/対応 |
| --- | --- | --- |
| P0 | 今回の対象範囲では新規発見なし | 実環境の可用性合格を意味しない |
| P1 | 保存失敗後も後続レイヤーのemitが同じwriterを再呼出し | SQLITE_BUSYなら同期5秒待ちを繰り返し、安全停止処理到達を遅らせ得る。sticky fault後は追加I/Oを抑止 |
| P1（潜在） | void callbackにasync関数を渡せるためPromise拒否がcatchを抜ける | 現workerは同期で直接は該当しないが、将来のembeddingで保存未完了を正常扱い/未処理拒否の余地。thenableを検出し即座にfail closed、拒否をconsume |
| P2 | 同一HTTP flight共有時、各callerにHTTP観測が発行され実通信数と一致しない | transportAttemptedを追加し共有/ローカル拒否を除外可能に。共有結果へ架空のnetwork時間を付与しない |
| P2（運用残存） | 同期FULL書込・5秒busy timeout・無期限保持 | 最初のロック待ちは残る。容量・I/O監視と承認済み保存方針が必要 |

## 3. 実施した修正

実装変更はsui-client内のみ。上記の追加I/O抑止、async callback防御、transportAttemptedの追加。DB schema/index、health TTL、timeout、retry、復旧条件、Native gRPC、戦略、売買経路は変更なし。

transportAttempted=falseのHTTP観測は共有結果またはローカル拒否で、HTTP実試行の分母から除外する。従来レコードにフィールドがない場合は不明として扱い、trueへ補完しない。rpcId単位のSDK呼出しと実HTTP試行は1対1と仮定しない。429など既存retryではHTTP観測が最終結果を表すため、試行別の分母・retry数には従来のApiAttemptを使用する。この変更は全HTTP観測を試行ログへ再定義するものではない。

## 4. テスト結果・未実施項目

実行環境はローカルNode **v24.14.0**、pnpm 9.12.3、SDK 2.37.0。package.jsonの要求Node >=24.22.1 <25を満たさないため、要求版での再検証が残る。インストール/更新や依存取得は行っていない。

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit` 成功。
- 本番build: 同型検査 + `node node_modules/vite/bin/vite.js build apps/dashboard` 成功。Zodコメント注釈に関する既存Rollup警告のみ。
- 全オフライン回帰: `node node_modules/vitest/vitest.mjs run --config vitest.offline.config.ts`。最終実行: **36ファイル、475件成功、7件skip、失敗0**。
- 最終実装修正後の対象3ファイル: health 14 / observation 12 / engine recovery 23、計49件成功。
- オフラインconfigはsocket connect/listenを拒否するsetupを導入。実通信7件を名前でskipし、settings-api/deepbook-transportの2ファイルを除外。Playwright E2E、実loopback HTTP/TLS/h2、Docker build/runtime/smoke、実Sui/DeepBook、PAPER運転は未実施。
- SUIのみ/USDCのみmetadata失敗、HTTP200+gRPC失敗、decode/metadata不正、EAI_AGAIN、TCP接続timeout、証明書失敗、本文timeout、既存10秒timeout、SDK途中キャンセル、旧応答到着、保存失敗、複数正常周期、手動停止維持をmock/fixtureで確認。
- 安全性fixture・DB計測のpaper_orders/paper_tradesは0。全回帰の既存会計テストには一時DB上の模擬fill検証も含む。実注文・実約定・送金・LIVE有効化は0、稼働Botへのアクセスなし。
- 初回sandbox内テストはrealpath EPERMで未実行。ネットワーク除外を確認したテストのみsandbox外で再実行し成功。自動承認審査による拒否はなし。

## 5. DB負荷・長時間運用リスク

市場周期のhealthだけならcache hit=1件、実metadata cohort=HTTP2+GRPC2+METADATA2+HEALTH1=7件。失敗/キャンセル/共有/記録障害では件数は減り得る。別のbalance/transaction/metadata利用は通常各3件を加算。したがって7件は全API利用を含めた絶対上限ではない。

通常60秒周期、TTL120秒、正常通信で1時間に20〜30回cohortを取得する想定（境界/取得時間に依存）では、`60 + 6 × cohort数`。

| 想定 | 1時間 | 24時間 | 7日間 |
| --- | ---: | ---: | ---: |
| 正常時の概算 | 180〜240 | 4,320〜5,760 | 30,240〜40,320 |
| 毎周期fresh・7件/周期 | 420 | 10,080 | 70,560 |

過去124周期/49cohortに同じ式を適用すると418件相当（当時の保存実数ではなく換算）。周期数が変われば時間比例の概算も変わる。

`node --import tsx scripts/sui-observation-db-bench.ts`で**新規一時DBだけ**を測定。既存DB/volumeは未参照・未変更。生成DBとresult.jsonは一時ディレクトリに証拠として保持。全行を587BのHTTP JSONで合成したため、実際のレイヤー混在分布とは異なる。

| 測定 | 結果 |
| --- | --- |
| 70,560行、checkpoint後DB（他テーブルの初期値含む） | 53,202,944B、約50.74MiB、約754B/行 |
| 最初の1,000件、同期FULL自動commit書込 | P50 3.16ms / P95 6.08ms / 最大92.29ms |
| 70,560行で直近50件取得100回 | P50 0.203ms / P95 0.354ms / 最大2.36ms |
| 別connectionでwrite lock、既存busy_timeout=5000 | 約5,432.53ms後に失敗、正常扱いなし |
| 注文/約定 | 0 / 0 |

残り69,560行は容量測定用transactionで投入しており、これを自動commitの速度として報告しない。ディスク/アンチウイルス/同時負荷/Node版に依存し、Docker性能の保証ではない。

実データを0.75〜1.5kB/行（index込み、WAL一時増分除外）で見積もると、正常時約3.2〜8.6MB/日、22.7〜60.5MB/週。毎周期freshなら約7.6〜15.1MB/日、53〜106MB/週。30日では正常約97〜259MB、fresh約227〜454MB。他のイベント・WAL・backupは別加算。

7同期書込が市場取得の直列経路に加わる。各行のP50を単純加算すると約22ms相当だが、周期全体のP50/P95を測定した値ではない。最初のlock待ちはJSイベントループを止め、AbortSignal timerと安全監視の実行も遅れる。修正で故障後の反復書込は止めたが最初の約5秒待ちは残る。DB全体の故障では停止状態の永続化も失敗し得るため、プロセス/DB監視が必要。busy timeoutの無断変更は行わない。

直近50件はtimestamp indexを利用。ただしORDER BYのid部分に一時B-treeを使用する。通常の同時刻群は小さく今回低負荷だったが、巨大な同timestamp群や他のoperations集計の負荷まで保証しない。API全体の実HTTP負荷測定は未実施。

提案: 全量証拠をまず30日保持、80%ディスク使用率で警告、日次容量/WAL/append P95/最大/SQLITE_BUSY監視。保存期限を設ける場合は明示承認後にバックアップhash・件数・期間を検証し、調査対象セッションを保全してからアーカイブ方針を確定する。今回はDELETE/VACUUM/保存上限実装/既存DB migrationを行っていない。

## 6. 次の実通信検証計画（未実行）

### 隔離と保護

実通信・Docker操作の**明示承認後**にだけ実施。対象修正SHAを固定し、Node24.22.1の固定base/lock/image/設定hashを記録。新規project `suiba-p0-review-<date>-<sha>`、restart=no、127.0.0.1:3105→container3100（競合時は承認済み別ポート）、新規data/report volume、新規secret。既存3100/3101/3104のenv・secret・DB・volumeを再利用しない。ホストbindは当検証用のread-only設定だけに限定。MODE=PAPERだがrunning=false、鍵なし、取引開始操作なし。

承認後に既存3100/3101のcontainer ID/image/StartedAt/restart count/mount/portをread-only採取し終了時比較。既存環境にcompose up/down/restart、exec、DB読取、設定書込は行わない。project名/volume/port衝突なら開始せず計画を修正する。過去検証projectも再利用しない。

### 時間・記録・分母

- 30分の診断確認を提案。短時間の結果は安定性GOの根拠にしない。別途承認された比較窓は2時間以上、各API100実試行以上。通常TTLでは2時間でSui100件に届かない場合があり、母数不足はINCONCLUSIVE。無断延長/追加RPC/キャッシュ解除で母数を増やさない。
- 固定したobserver/preloadのhashとI/O負荷を記録。通常取得60秒、timeout/retry/TTLは現状維持。24時間sessionは開始しない。追加診断RPC/PING/DNS照会はしない。
- DeepBook/SuiのApiAttemptを実試行の分母、retryを別試行として保存。cache/flight共有/管理GETは分母外。Suiは加えてHTTP取得（transportAttempted=true、retryはApiAttempt参照）、SDK gRPC、SUI/USDC metadata、完全health cohortを別集計。中断未完了は成功扱いしない。レイヤー間件数差と不明数も提出。
- 各API成功/失敗/成功率、連続失敗最大、retry、分類別件数、HTTP200+gRPC失敗件数、P50/P95/P99/最大latencyを保存。成功だけでなくtimeoutも分位点に含む。分位点は過去と同じnearest-rank。
- DNS/TCP/TLS/応答待ち/本文は新規・再利用別の件数/測定率/不明数/P50/P95/P99。h1/h2/不明を区別。未測定を0に置換しない。比較可能な全要求時間と、過去未取得だったphase時間を区別する。
- 全市場周期のSTART/END/未完了、成功率、開始間隔、遅延/skip、取得時間、3足の品質/確定/連続性/再構築期限、板年齢、Indexer lag、cache health数を記録。cycleId→healthId→requestId/rpcIdで照合。
- DB行増分/周期・bytes/WAL増分・appendとhistory50のP95/最大・SQLITE_BUSY・記録欠損・RSS/GC/active listener数を監視。operations取得は低頻度の既存管理GETだけにし追加市場RPCを生じさせない。

比較基準: 過去2:01:31.689、DeepBook797試行/99.8745%/P95 1185ms、Sui98試行/94.8980%/P95 8015ms、周期124/正常120/96.7742%/取得P95 14598ms。過去HTTP中心のAPI成功率と新gRPC/metadata成功率を同一指標に混ぜない。過去のphase詳細は欠測として残す。

### 安全停止・復旧と判定

実環境ではBot停止状態を維持し、自然発生した通信障害/復旧でrunning=false・注文0・約定0を確認。手動停止を解除しない。障害注入の別フェーズは実upstreamへ負荷を与えず、承認済み専用fixture/proxyでのみ行う。二つの正常周期でも手動停止/緊急停止/台帳不正/古い板・足/バックオフ/世代不一致がある限り再開禁止。稼働中からの自動安全停止→条件付き復旧は今回のモック統合テストを根拠とし、実Bot開始をこの計画に暗黙に含めない。

即終了条件: 意図しないrunning/LIVE/注文/約定、既存環境変更、証拠保存障害、未知の連続未完了、周期deadline超過と監視不能、ディスク80%以上、停止後の追加要求が収束しない、秘密情報の出力。個別の通常通信失敗は打切りで除外せず全件記録し、連続3周期失敗または5分正常周期なしで打切りNO-GO（診断用の運用停止基準でありコード条件の変更ではない）。

GO条件: 要求Node版のoffline/build成功、2時間以上かつDeepBook/Sui各100試行以上、各HTTP/API成功率>=99%、gRPC/metadata/完全healthも>=99%、周期正常率>=99%、API/周期P95<基本60秒、既存45秒取得deadline/鮮度/品質/台帳条件を満たす、安全条件違反0、保存欠損/重複集計/無許可再開/注文/約定0、証拠整合、既存環境差分0。既知の未測定phaseは不明として定量報告し、要求phaseが全面欠測なら診断目的は未達。30分/母数不足/Node不一致はINCONCLUSIVE、数値未達や安全違反はNO-GO。合格しても24時間PAPER開始は別承認。

終了時は評価窓を時刻で固定して末尾の失敗も含める。専用projectのIDを照合してSIGTERM正常停止、timeout時は対象だけの終了を検討。停止権限も実通信試験の承認範囲に含める。専用DBはSQLite整合backup（WALを無視した単純コピーは禁止）、report/JSONL/hash/件数/実行SHA/設定hashを保存し、container/volume/secretを証拠保全。既存環境の指紋を再比較。volume削除・prune・既存環境の操作は行わない。削除は後日の別承認。

## 7. GO / NO-GO

コードの主要安全条件はオフライン検証で維持。**実運用・24時間PAPERはNO-GOを維持**。本番要求Node版での再検証、実TLS/h2/長時間RSS/実ネットワーク品質とDocker上I/Oの検証が残る。実通信・Docker・24時間PAPERの承認は未取得であり開始しない。

## 8. コミットとpush

修正と回帰、オフライン検証支援、調査報告を小さい単位でmainにコミット。最終応答にSHAとpushの実結果を記載。GitHub pushのみ依頼で許可された操作として実行し、Sui/DeepBook接続とは分離する。
