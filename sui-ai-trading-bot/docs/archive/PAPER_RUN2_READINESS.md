# 第2回24時間PAPER運用テスト P0改善・開始判定

作成日：2026-10-23 JST。対象：tajumaru/SuiBa / sui-ai-trading-bot / main。
前提：[第1回終了監査](PAPER_24H_RUN1_FINAL_REPORT.md)。実装・検証基準SHA：`b09beb3b4a60b183e673573318e0c8c46e0bcbd7`（本書の追加前、最終実装コミット）。

## 1. 開始判定：NO-GO

**アプリ内の再現可能なP0不具合を修正し、隔離テストは合格。第2回24時間テストはまだ開始しない。**

Windows/Dockerから外部DeepBook/Suiへ接続する実経路の安定性と、固定Dockerイメージでの事前確認が未完了である。第1回の成功率（DeepBook98.9876%、Sui92.8994%）を今回のモック/ローカル通信試験で改善済みと判定しない。今回Dockerイメージのビルド・コンテナ作成/起動・PAPER開始・運用環境の再起動は実施していない。

| 領域                 | 判定                       | 根拠・限界                                                                                                                           |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 通信実装             | PASS（隔離）               | 期限、429待機、fresh読取、接続再利用/GOAWAY、DNS/TCP/TLS/本文エラー分類を回帰検証                                                    |
| 外部通信の運用安定性 | 未検証 → NO-GO要因         | Windows/Docker/外部DNS・経路・上流の断続障害は原因未確定。新イメージからの継続観測なし                                               |
| 安全復旧             | PASS（隔離）               | DNS/CONNECT/TLS/BODY/gRPC失敗、正常確認、再障害、期限/回数超過、古い足/板、台帳異常、手動/緊急停止、再起動で注文禁止と復旧可否を検証 |
| データ品質           | PASS（隔離）               | 現在欠損と累積履歴を分離。失敗/範囲外/再発/再構築/原足backfillを検証。最終証拠読取の45秒超過を拒否                                   |
| 戦略評価・証跡       | PASS（隔離）               | BUY/SELL/WAIT条件と入力、稼働/停止/復旧確認中の分析、未評価周期、注文ゲートを永続化                                                  |
| PAPER約定・会計      | PASS（隔離）               | BUY→保護SELLの残高/手数料/損益を独立期待値で照合。PG/Risk拒否、部分売却、破損、重複、保存失敗の既存回帰も合格                        |
| 固定版の実運用準備   | 準備済み・起動前確認未実施 | 専用Composeと版記録・版変更検出を追加。実image IDは未作成のため未確定                                                                |

PAPER専用、停止・鮮度・timeout・リトライ上限・会計許容誤差を維持した。第1回のDB/ログ/セッションには接続・書込みを行っていない。作業はmainから分離したチェックアウトと、メモリ/一時DB、ローカル通信、5177のテストUIで実施した。

## 2. 修正した根本原因と該当コード

### 2.1 通信・read budget

| 再現した不具合                                                                                                | 修正                                                                                                                    | コード・検証                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| HTTP429の待機だけが全体budgetを無視し、45秒後もAPIキューを占有し得る                                          | 一時障害と429で同じbudget対応待機を使用。abort原因を待機開始時のscopeから保持する。Retry-After/cooldown自体は解除しない | `packages/shared/src/api.ts` の `wait/run`、`tests/read-budget.test.ts`          |
| fresh復旧読取が、復旧周期開始前から進行していた同一要求の結果を共有する                                       | 古いflightの終了をbudget内で待ってから、このscopeで新たに取得。キャッシュと古い成功を復旧証拠にしない                   | 同 `run`、fresh-flight回帰                                                       |
| 通信関数が遅れて返った場合、期限切れでも成功計数/キャッシュ更新できる                                         | await後、成功処理の前にattemptSignalを再確認                                                                            | 同 `run`、late-success回帰                                                       |
| DeepBook transportが本文をbufferしてからResponseを返すため、本文timeout時の受信済みHTTP200がAPI層でnullになる | transportの例外に数値statusを添付し、whitelist検証して診断に保存                                                        | `deepbook-transport.ts`、`shared/http-errors.ts`、`apiFetch`、ローカルHTTP/2回帰 |

1要求8秒（DeepBook）/10秒（Sui）、DeepBook追加retry最大2回、従来の待機・cooldownは変更していない。Sui gRPCに無条件retryを追加していない。HTTP/2接続の再利用、失敗/中断時の破棄、GOAWAY、120秒idle終了は既存仕様を維持する。

DNS/TCP/TLS/本文timeoutの全てを「接続再利用のバグ」と断定しない。再利用・abort・GOAWAYはローカルHTTP/2、DNS/CONNECT/TLSは制御したセッションイベント、gRPC/HTTP分類はfixtureで検証した。WindowsのDNSスタック、セキュリティ製品、プロキシ、ISP、上流側などのどこが断続遅延を起こしたかは今回未特定。

### 2.2 欠損の状態遷移・再構築期限

`apps/worker/src/validation.ts` の集計は、以前は毎周期のraw gapを見ただけでresolvedから削除していた。Sui health失敗などでframesが空でもproviderの古いqualityが残るため、過去に再構築済みの足が未解決へ戻り、取得範囲外へ出ると残る不具合を再現した。

修正後は以下を区別する。

- `candles.unresolved/unresolvedTimestamps`：最後に実際に取得した現在窓の未解決。未取得はnull、観測時刻は`qualityObservedAt`。この時刻が古い場合、0件でも現在の通信正常を意味しない。
- `historicalUnresolved/historicalUnresolvedTimestamps`：履歴上、最後に未解決のまま残る足。現在窓から外れただけでは消さない。実際の再発を新しく観測した場合だけ未解決へ戻す。
- `originalMissing`、`reconstructed`、`evidence`、`reconstructionFailures`、`failedCandleObservations`：累積欠損・修復証拠・失敗履歴。最新成功で過去の失敗を消さない。

`quality.fetchedAt`が当該周期開始前なら新たな欠損状態の観測に数えない。部分再構築では`CandleQuality.unresolvedTimestamps`で未解決の足を明示する。失敗履歴がある試験の品質合格条件を、最新0件だけで合格へ変更していない。

`packages/market-data/src/deepbook.ts` の従来の45秒確認はループ前だけで、最後のtrade証拠を待つ間に期限を超えても結果を受理できた。`candles`全体に既存上限45秒のscopeを置き、親acquisitionの期限との早い方で中断する。全readの前後と結果受理前に確認し、遅れた応答をproofに格納しない。finallyは当該取得のqualityだけを更新する。既存worker全体の45秒期限、確定足360秒、板10秒等は維持する。

### 2.3 周期・戦略条件の証跡

`packages/shared/src/index.ts`、`packages/strategy-engine/src/index.ts`、`apps/worker/src/engine.ts`、`packages/database/src/index.ts`、`validation.ts`。

- 新規`cycle_audits`にSTART/ENDを共通`cycleId`で保存。STARTだけが残れば処理途中の終了を識別できる。開始時・分析時のrunning、connectivity、generation、分析到達、最終outcome、action/error、candidate/order IDを区別する。
- `strategy_decisions.analysisContext`と周期を同じIDで結合。停止中の分析を正常PAPER稼働と数えない。
- 集計に`runningAnalyses`（分析時の安全ゲートを通過）、`stoppedAnalyses`、`gatedAnalyses`、`unknownAnalysisState`（旧記録）、`unevaluatedCycles`を追加。旧記録の状態を推測で正常にしない。同一足の再分析は分析件数であり、固有足数や約定許可件数とは別。
- `TradingDecision.evidence`に現在/前足timestamp、EMA/RSI/MACD等の入力、出来高、entryPrice、閾値、条件ごとの真偽、選ばれたルールを保存。保護SELL→出来高→BUY→SELLの既存優先順と売買式は変更しない。
- 取得失敗時の画面用WAITと、戦略の正式なWAIT判断を分離。取得失敗ではstrategy_decisionsを増やさず、周期にanalysis=null/action=null/FAILEDを記録する。

### 2.4 実行版と検証セッション

`apps/worker/src/runtime-build.ts`、`index.ts`、`validation.ts`、`docker/Dockerfile`、`docker/compose.paper-run2.yaml`。

SHAとimage IDの申告値、Node版、lockfile SHA256、開始時の設定SHA256を新規セッションに固定する。環境変数全体・認証値・接続URLは保存しない。申告SHA/image IDはoperatorが`docker inspect`と別途照合する値であり、自己申告だけを真正性の証明にしない。

再起動後のSHA/image/Node/lock不一致は`EXECUTION_BUILD_CHANGED`としてintegrityFaultを設定する。異常発生時は表示cacheも失効させる（従来は同一recorderの10秒cacheに正常判定が残り得た）。既存セッションの識別情報・履歴を新しい版の値へ書き換えない。旧セッションの未記録buildはnullとして扱う。

## 3. 修正前後のテスト結果

実行環境：Windows、Node24.22.1、Vitest3.2.7、Vite7.3.7。既存node_modulesを隔離チェックアウトから参照した。frozen-lockfileからのクリーンDocker再ビルドは未実施であり、運用イメージの検証と区別する。

| 検証                     | 修正前・途中                                                                                                  | 最終結果                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 既存重点安全テスト       | 初期6ファイル108件成功                                                                                        | 全回帰に含めて成功                                                            |
| 新規通信4回帰            | 429待機/fresh-flight/late-success/statusの4件すべて失敗を再現                                                 | 全件成功                                                                      |
| 欠損/再構築3回帰         | stale quality/範囲外gap/最終証拠45秒超の3件失敗を再現                                                         | 全件成功。真の再発→解消も追加検証                                             |
| 型検査・production build | 変更後の診断戻り値の型不足を補正                                                                              | 成功                                                                          |
| 全ユニット・統合         | 初回無制限並列ではsettings-apiのテストworker起動待ちだけ失敗（438成功）。単独では成功                         | `--maxWorkers=2`：33ファイル443件成功                                         |
| 全E2E                    | 初回164成功/20失敗。settingsテストの全域role=statusが、通信状態表示と設定保存状態の2要素を拾うstrict-mode違反 | 4画面幅（375/390/430/1280px）、全184件成功（2.6分）                           |
| Compose                  | 起動/作成なし                                                                                                 | ダミーの固定SHA/image IDを用いた`config --quiet`成功。実image存在検証ではない |

E2Eの修正は`.easy-settings`内のstatusにテストlocatorを限定したもの。製品UIの状態表示や期待する保存・再確認・停止・手動開始の挙動を弱めていない。Windowsのテスト並列数制限もアプリのtimeout緩和ではない。

### PAPER会計の独立確認

メモリDBで注文額2USDCを明示したfixture（運用設定の変更ではない）。本番の戦略を緩めず、fixture内でBUYと保護SELLを選択して通常のengine/PG/Risk/約定/台帳経路を実行した。

| 値                              | BUY直後 | 全量保護SELL後 |
| ------------------------------- | ------: | -------------: |
| USDC                            |  97.964 |      99.916053 |
| SUI                             |   0.997 |              0 |
| 原価                            |   2.036 |              0 |
| 累積手数料＋gas                 |   0.036 |       0.071965 |
| 実現損益                        |       0 |      -0.083947 |
| orders/trades/checks/candidates |     各1 |            各2 |

独立期待値と原子的保存・ledger.okを照合。同一足の再実行では約定を増やさない。既存のPG拒否、RiskEngineの日次損失/残高不足拒否、部分売却、原価・損益・gas・残高の改ざん検出、重複防止、監査保存失敗のrollbackも全回帰に含む。実市場での自然なBUY/SELL発生や利益を保証するものではない。

### 再実行

```powershell
pnpm build
pnpm exec vitest run --maxWorkers=2
pnpm exec playwright test --config playwright.safety.config.ts
```

検証ログは隔離チェックアウトの`data/run2-readiness/`（build.log、vitest-final.log/json、playwright-final.log）。大きなログや認証値はコミットしない。テストコード・fixture・本書で再現できるようにした。

## 4. 未解決リスク・GOへの条件

1. 外部DNS/TCP/TLS/本文遅延の実経路原因は未確定。アプリ内のdeadlineと診断の修正は、上流ネットワークの修理ではない。
2. 新しい固定imageでの依存関係の再現性、コンテナ内からのgRPC/全足/板/再構築の継続正常性は未確認。
3. 実環境の安全復旧イベントと自然な約定は未行使。mockの復旧合格を、24時間の復旧率や稼働率の証明としない。
4. HTTP/2の段階計測はDeepBook transport中心。Suiのfetch経路では保存されたcause等で分類できても、DNS/TCP/TLSの独立所要時間を全要求で測定できるわけではない。API試行とcycleの全層で共通request IDがそろう保証も未実装。
5. NO_INDEXED_TRADESの証拠はIndexer由来。独立オンチェーン監査ではない。
6. `cycle_audits`は周期当たりSTART/END各1行と条件証跡を追加する。長期DB増大の監視が必要。既存監査履歴を削除・短縮する最適化はしていない。

GOへ更新する前に、下記の固定imageを別プロジェクト・別DBで停止状態のまま起動する承認を得て事前観測する。目安は2時間以上かつDeepBook/Sui各100試行以上、各成功率99%以上、P95が基本周期未満、全3足の連続/確定/鮮度・板・台帳・再構築期限が既存条件を満たすこと。母数・時刻・エラー内訳を保存し、失敗時は継続時間だけで合格扱いしない。診断のために上流へ負荷試験を行わない。

実経路で未達/不明が残ればNO-GOを維持する。GOは第2回を開始できる準備判定であり、24時間運用の事前合格ではない。

## 5. 新規DB・固定SHA・固定イメージでの開始手順（未実行）

**以下の起動・PAPER開始は、本書のNO-GOを解消し、別途承認を得てから実施する。既存3101を再作成する手順ではない。**

### 5.1 固定ソースからのビルド準備

1. 本改善を含む承認済みmain SHAを固定した、未変更の専用checkoutを用意する。運用用.env/秘密をコピーしない。最終実装基準は冒頭のSHAであり、本書だけを追加したコミットからビルドしても実装は同じ。変更が加われば再テストする。
2. そのcheckoutの`sui-ai-trading-bot`で以下を準備する。これは手順例で、今回ビルドはしていない。

```powershell
$run2Sha = git rev-parse HEAD
if (git status --porcelain --untracked-files=no) { throw 'Use a clean fixed checkout' }
docker build --build-arg "SUIBA_BUILD_SHA=$run2Sha" `
  --label "org.opencontainers.image.revision=$run2Sha" `
  -f docker/Dockerfile -t "suiba-paper-run2:$run2Sha" .
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$run2Image = docker image inspect --format '{{.Id}}' "suiba-paper-run2:$run2Sha"
$revision = docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' $run2Image
if ($revision -ne $run2Sha) { throw 'Image revision mismatch' }
$env:PAPER_RUN2_SHA = $run2Sha
$env:PAPER_RUN2_IMAGE = $run2Image
$env:PAPER_RUN2_PORT = '3103'
docker compose -p suiba-paper-run2 -f docker/compose.paper-run2.yaml config --quiet
```

image ID・SHA・Node・lock hash・テスト結果を保存する。起動時はmutable tagではなく`sha256:...`の実image IDを指定し、`--build`/`--pull`で差し替えない。Dockerfileのbase tagとlockfileが同じでも将来の完全再現性を自動保証するわけではないため、作成済み実image IDを維持する。

### 5.2 独立環境の事前確認（別途承認が必要）

- `docker/secrets/paper-run2-admin.txt`を新規ランダム値で作り、内容を画面・Git・報告書へ出さない。第1回のsecret/envを流用・変更しない。
- 事前観測は別project（例`suiba-paper-run2-preflight`、port3104）の新規volumeで行い、第2回のvolumeとも分ける。
- 事前観測を合格した後の本試験は`suiba-paper-run2`、port3103、`suiba-paper-run2_run2-data`と`suiba-paper-run2_run2-reports`。既存volumeがあれば削除して再利用せず、未使用のproject名を選ぶ。既存の`suiba-deepbook-24h_*`は一切指定しない。
- image/SHA・port・mount先を`docker compose config`と`docker inspect`の必要フィールドだけで照合する。inspect全文は環境情報を含むので出力しない。RUN1 DBファイルのコピー・mount・セッション継承は禁止。
- 新規コンテナ起動後もBot停止・緊急停止なし・過去エラーを勝手に解除していないこと、LIVE起動拒否、ledger整合を確認する。今回のprofileは`restart: "no"`であり、プロセス再起動で試験を継続したように見せない。

承認後の起動コマンドは次のとおり（今回未実行）。

```powershell
docker compose -p suiba-paper-run2 -f docker/compose.paper-run2.yaml up -d --no-build
```

### 5.3 GO後の検証開始（PAPER開始は別途承認）

1. 事前観測の結果を本書へ追記してGOを明示する。それまでは新規24hセッションもPAPER開始も行わない。
2. 新規本試験環境で、`runtime.running=false`、PAPER/deepbook/verified、Profit Guard有効、全足/板/gRPC/台帳・backoff正常を確認。
3. 認証済みの既存UIから24h検証を開始し、セッションID/build/開始時刻・設定hashを保存する。別の明示承認後、既存の手動開始操作でPAPERを開始する。初期遅延は45秒の許容差を消費するため迅速に行い、開始できなければ運用要件未達として扱う。
4. 24時間中はSHA/image/DB/設定を変更しない。重大停止・手動停止・再起動は無許可再開しない。許可された一時通信復旧だけを既存の証拠付き条件で判定する。
5. 終了後、終了境界sampleと固定窓を読取専用で監査し、通信・安全・品質・稼働中の戦略評価・PAPER会計を別々に判定する。全WAITでも正常稼働/評価/品質が合格なら無取引運用として評価できるが、自然約定未行使は明記する。

## 6. コミットと今回の非実施事項

- `60d6102`：read budget、fresh取得、期限後の成功拒否、本文HTTP status。
- `f34ac28`：現在/累積欠損と再構築期限。
- `a6014df`：周期・条件別証跡、PAPER会計fixture。
- `b09beb3`：実行版固定/混在検出、真の欠損再発、設定E2E locator、独立Compose。
- 本書：最終試験結果・NO-GO・開始手順。

未実施：LIVE取引、運用Botの開始/停止/reset、自動再開操作、Docker運用環境の再起動/再作成、RUN1 DB/ログ/セッションの変更、外部APIへの負荷/障害注入、DNS/OS/セキュリティ設定変更。承認前に運用環境へ反映しない。
