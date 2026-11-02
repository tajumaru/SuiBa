# 30分独立実通信検証：Docker事前確認と承認後手順

**本書のbuild/run/compose/実通信の手順は未実行。ユーザーの明示承認後だけ実施する。PAPER運転開始は含まない。**

## 今回の事前確認

- Dockerfileは単一stage。buildとruntimeが同じNode 24.22.1 baseで、OCI index digestを公式Registryで確認して固定。`node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`。
- Registry応答のlinux/amd64 manifestは`sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae`。これはbaseのmanifestであり、将来buildするSuiBa image IDではない。
- scriptsをimageへCOPYし、依存install/build前とruntime開始前の両方で実Nodeをguard。tagの表示だけを変更したものではない。実image buildとコンテナ内のNode確認はまだ行っていない。
- `compose.preflight-30m.yaml`を新設。固定image IDのみ、pull_policy=never、build定義なし、127.0.0.1:3105、restart=no、read_only、/tmpだけtmpfs。親compose/envを継承しない。
- 新規project配下の`preflight-data`と`preflight-reports`だけをmount。DBは新volume内`/app/validation/deepbook-paper.sqlite`。既存DBコピー、external volume、既存secret、既存.envは使わない。
- project / immutable image ID / SHA / 新secretファイル指定がなければcompose変数展開が失敗する。ただしComposeの構文解析・変数解決・mount生成はDocker CLIで未実行。Prettier YAML構文確認と静的回帰テストまで。
- 新DBのruntime初期値running=false、既存monitor.bootも停止状態へ戻す。MODE=PAPERは起動許可モードであり、Bot開始を意味しない。control start/validation beginを呼ばない。停止中にも既存市場取得が動くため、起動自体が実通信承認を必要とする。
- 待受メタデータ確認時3100/3101は使用中、3104/3105は待受なし。稼働サービスへ接続していない。既存container/image/volume/secretのinspectもしておらず、それらの実ID/版は未確認。
- WSL UbuntuはStoppedのため未起動・Node未確認。docker-desktopはRunningだが内部を調査/変更していない。WSL、Windows、Codex、Docker内のNodeは別環境として扱う。

## 承認後の順序（今回実行しない）

1. protected port 3100/3101/過去3104に対応するcontainerのID/image/StartedAt/restart count/port/mountを、許可済みの読み取り専用inspectで固定する。envやsecretの内容を出力しない。既存DBには接続しない。
2. `suiba-node-p1-preflight-<UTC日時>-<testedSHA先頭>`という未使用project、新規tag、新規volume名を選択する。project名は既存`docker`/`suiba-deepbook-24h`/旧preflight等と一致禁止。既存project/volume/tagが同名なら再利用/上書きせず中止。
3. Windowsの`Get-NetTCPConnection -State Listen`等で3105競合を再確認。WSL/Docker側のport公開一覧もread-onlyで照合する。競合なら起動せず計画修正、3100/3101/3104への自動fallback禁止。
4. 新規secretをGit対象外`docker/secrets/<unique-run>/admin.txt`へ暗号学的乱数で生成（32byte以上）、既存ファイルなら失敗。NTFSアクセスを当ユーザーに限定。内容は表示/ログ/コミットしない。Dockerにはそのファイルだけをread-only secret mountする。
5. 対象mainのcleanなSHAを固定し、要求Nodeでoffline/type/buildを再確認する。新規tagのみでDocker buildを実施する。既存image/tagは上書き・削除しない。初回はキャッシュ依存を除く`--pull --no-cache`を提案するが、実行はbuild承認後。baseはdigest固定であり、古いローカルtagの誤使用を避ける。
6. 新imageをinspectし、実image ID/OCI revision/lock hashを保存。`docker run --rm --network none --entrypoint node <new-image-id> scripts/verify-node-version.mjs`でimage内の実Nodeを確認する。これは承認後の新規offlineコンテナだけであり、既存containerをexec/再作成しない。
7. SUIBA_PREFLIGHT_PROJECT/IMAGE/SHA/SECRET_FILEを専用プロセスの環境に設定し、新compose単独でconfigを解決。image IDが`sha256:<64hex>`で一致すること、mountが全て新projectの新volumeであること、secretが新run専用であることを確認。configのsecret内容や全envを共有しない。
8. image offline確認と静的構成レビューが通ってから、**独立環境起動・30分実通信の承認範囲内でだけ**新composeを起動する。`up --no-build --pull never`相当を使い、変更不能image IDを使用する。通常compose/24h helperは起動しない。
9. コンテナ内NODE_VERSION_VERIFIED、runtime_build.node、image ID/SHA/hashを独立照合。初回sampleでrunning=false、paper_orders=paper_trades=0、validationSession=null、databaseHealth正常を確認。manual start・24h計測beginは実行しない。

PowerShellからの構成例（以下も未実行）:

```powershell
# 値は承認済みの新規リソースを確認して設定する。secret内容は変数やログへ表示しない。
$env:SUIBA_PREFLIGHT_PROJECT = '<new-unique-project>'
$env:SUIBA_PREFLIGHT_IMAGE = 'sha256:<independently-inspected-new-image-id>'
$env:SUIBA_PREFLIGHT_SHA = '<tested-full-commit-sha>'
$env:SUIBA_PREFLIGHT_SECRET_FILE = '<new-per-run-secret-file>'
# 承認後の構成検証。その後の起動は実通信承認の対象。
docker compose -f docker/compose.preflight-30m.yaml config --quiet
# 起動は計画上のみ。今回実行しない。
docker compose -f docker/compose.preflight-30m.yaml up -d --no-build --pull never
```

## 追加RPCを使わない計測

既存`preflight-observer.mjs`で通常のApiAttempt/cycle/sampleをJSONLへ複写し、sui_observationsを新DBに保存する。追加のSui JSON-RPC endpoint、DNS診断、TCP疎通、PING、health強制再取得、retryは行わない。「Sui RPC」は既存Sui gRPC要求の集計名であり、新たなJSON-RPC通信を追加する意味ではない。

独立composeだけが追加ロードする`preflight-metrics-preload.mjs`は、既存DBのappend/set/transactionの実行時間と例外数、SQLITE_BUSY/LOCKEDの一次code、Node monitorEventLoopDelayを受動計測する。新SQL/RPC/DBファイルを作らず、戻り値/同期ACK/元例外を維持する。15秒ごとに累積histogramのcount/P50/P95/最大をstdoutへ出す。histogramは固定メモリ、エラー重複はWeakSetで除外しlistener/timerの解除手段も持つ。stdoutのbackpressure/保存例外は握りつぶさず異常終了側へ伝播させる。Dockerログの回収失敗・欠落もNO-GOとする。

累積histogramなので各15秒P95の平均から全体P95を作らない。append/setとそれらを含むtransactionは重複するspanであり、合算してSQL総時間としない。statement latency、transaction latency、event loop遅延、native SQLiteロック待ちの意味を区別する。

| 指標 | 証拠と分母 |
| --- | --- |
| Sui/DeepBook HTTP成功率・timeout・retry | ApiAttemptの実試行、失敗時間もlatency分布へ。cache/共有/管理GETは分母外 |
| Sui gRPC成功率 | SDK GRPCレイヤーをrpcIdで区別。HTTP200をgRPC成功としない |
| metadata/完全health | SUI/USDC別、両方検証したcohortとcacheを分ける |
| DNS/TCP/TLS/応答待ち/本文 | Sui passive networkの測定済み値のみ、新規/再利用/h1/h2/不明別。0埋め禁止 |
| DeepBook phase | 現transportは成功時の詳細phaseを公開しない。既存失敗時のtransportTimingsと全要求時間だけを使用し、成功phaseは未計測と明記。追加RPCや推測で補完しない |
| 市場取得 | cycle START/END/失敗/未完了、取得P50/P95/最大、開始間隔、3足品質・板/Indexer鮮度 |
| loop/SQLite | 累積delay histogram、append/set/transaction時間、失敗/Busy/Locked、DB health、row/bytes/WAL増分 |
| 安全停止/復旧 | running=false維持、保存障害はsticky、通信復旧でも自動開始なし。保存不能時はsupervisorの許可済みcodeと欠落を記録 |
| 注文/約定 | 新DBの0件を各sample/終了時照合。元台帳の整合性確認は専用環境だけ |

通常通信は60秒周期・Sui TTL120秒等の現設定を維持する。初回sampleから1800秒以上となる最初の所定sampleまでを固定窓にし、最後の失敗も含める。母数を増やす延長/追加要求はしない。shutdown分は別枠で保全。

比較用の過去2時間値: DeepBook797試行/99.8745%/P95 1185ms、Sui98試行/94.8980%/P95 8015ms、周期124中120正常/96.7742%/取得P95 14598ms。過去HTTP指標と今回gRPC/metadataを混ぜない。30分の各成功率は件数/不明/欠落も併記し、100試行未満でも初期観察として提出するが長期安定GOには使わない。

## 停止条件・証拠回収

予定時刻または以下で専用環境だけを終了: Node不一致、SHA/image不一致、意図しないrunning=true/LIVE/注文/約定、DB fault/SQLITE_BUSY/証拠保存失敗、既存環境差分、連続3周期失敗/5分正常周期なし、監視不能、disk80%以上。危険な誤起動は直ちに停止し、正常になった瞬間を選んで評価窓を切り直さない。

停止の前にproject/container IDを照合し、その新規projectだけへSIGTERM。既存3100/3101/3104へのstop/down/restart/execは禁止。JSONL・Docker stdout/終了code・DBのSQLite整合backup・WAL対応・hash・row数・実版を保存する。単純にWALを無視したDBコピーをしない。新volume/secret/証拠は保持し、down -v/prune/既存volumeの変更は行わない。既存のcontainer指紋をread-onlyで再比較する。終了操作も独立試験承認に含め、削除は別承認。

## 判定

要求Nodeでoffline/type/buildと静的構成確認を完了したことは、**Docker実行済み・実通信済みを意味しない**。次の承認対象は「新image build＋network noneで実Node確認＋隔離構成照合＋running=falseの30分観測＋専用環境停止/証拠保全」。この承認が来るまで実行しない。

30分の合格は初期通信/計測の確認に限定する。安全違反0、DB fault/証拠欠損0、既存環境差分0、版一致、取得deadline/品質条件維持が必要。可用性の長期判定には別承認の2時間以上・各API100試行以上/各成功率99%以上等が残る。24時間PAPERやLIVE開始はこの計画の承認に含まれない。
