# VPS 検証の失敗連鎖：独立調査

調査日：2026-11-07。対象：main **`78b1703`**。依頼：[CODEX_QUALITY_INVESTIGATION_JA.md](CODEX_QUALITY_INVESTIGATION_JA.md)。製品コード・停止条件・実機設定は変更していない。

## 結論と証拠の扱い

失敗が毎回別の場所に現れる主因は、個別部品の不足よりも、**配布→特権入口→起動前ポーリング→開始判定→停止→回復という境界を、同じ制約・状態遷移で通す検証が不足していること**と判断する。これは下記コードからの構造的な推論であり、障害頻度を統計的に推定した結論ではない。

- **コードで確認**：開始前も取得・検証が先に走り、その失敗は runtime.error に残る。readiness の確認と start の間は原子的でない。
- **依頼書の前提を補正**：health に専用予算はないが、worker の acquisition 経路には共有45秒予算と abortable がある。「45秒で呼び出し元が戻る保証がない」という一般化は、この経路について支持できない。ネットワーク成功を45秒以内に保証する仕組みではない。
- **コード＋境界再現**：5分足の鮮度許容は終値時刻から360秒。最新足未着時には境界後60秒を超えると前の足が失効する。monitor も360秒なので、片方だけ変えても解決しない。
- **追加のレビュー対象**：開始前リセットは古いエラーだけを識別せず、共通 reset API は emergency も解除する。新規429や手動緊急停止まで既存の retry 承認で消してよいか、明示的な契約が必要。当日の発生を実証したものではない。

「当日観測」は依頼書と既存運用記録による二次資料。「コード確認」は対象 SHA の静的精査。「ローカル再現」は後述のオフライン実験。VPS 生ログ、run ごとの完全な停止レシート、Indexer 遅延の時系列を新たに取得していない。したがって当日の health 遅延原因や遅延分布は未確定とする。

## A. 起動ウィンドウ

### 証拠

- `apps/worker/src/worker-factories.ts` の `createScheduler` は `engine.tick()` を実行する。
- `apps/worker/src/engine.ts` の `tick` は deployment/busy 判定後、`acquireFrames`、検証、分析へ進む。`running`・session の判定は後段の `gateStopsCycle`。失敗時は `monitor.failCycle` と `error: runtime.error ?? code` で保存する。
- `apps/worker/src/operations.ts` の `stop` は停止中でも初回エラーを保存し、既存エラーを維持する。良好な取得だけではそのエラーは消えない。
- `apps/worker/src/http-routes.ts` の `/api/deployment` は `runtimeClear` を startReady に含め、start は `RESET_REQUIRED` 等の409を返す。
- `deploy/paper-check/controller.py` の `wait_ready` → `wait_market_fresh` → arm → `recheck_start_blockers`（retry 時のみ）→ start は別リクエスト。最後の再確認から start の間にもサイクルが進める。

### 結論

開始前の取得はウォームアップ・表示・開始判断に必要。ただし「過去の開始前市場エラー」と「現在の開始可否」が同じ永続ラッチになると、市場が回復しても開始できない。PR #96 の再確認は窓を縮める対策であり、競合の除去ではない。初回開始には retry 専用リセットも効かない。

### 推奨アクション

| 選択肢 | 判断材料 | 推奨 |
|---|---|---|
| 現行＋controller リセット | 小変更だが競合・解除範囲・複数の待機予算が残る | 暫定維持。対象エラーと承認の対応を先に限定 |
| arm 前は全エラーを永続化しない | 単純だが429、DB、整合性異常まで消す危険 | 採らない |
| 開始前の市場準備状態と安全ラッチを分離 | 市場の不足・遅延を準備未完として記録し、現在の検証証拠で開始可否を決められる | **設計の第一候補**。分類・状態遷移を承認してから実装 |

分離案でも429は直ちにハードストップし、手動緊急停止・DB/台帳異常・開始後の停止を弱めない。開始前市場エラーを無視して start するのではなく、同じ世代の最新検証証拠とエラー状態を start 側で確認する。証拠が古い／失敗世代が変わった場合は未開始のまま拒否する。自動再開は加えない。

受入テスト：未armの STALE_CANDLES→良好データ、readiness直後の新規失敗、arm後/start前の失敗、429、手動emergency、再起動して残った旧エラー。各ケースで注文ゼロと開始可否を別々に検証する。

## B. health と45秒予算

### 証拠

- `engine.ts:acquireFrames` は `monitor.acquisition` 内で health を待ってから frames を取得する。足取得の所要時間だけでは acquisition 全体の時間にならない。
- `operations.ts:acquisition` は `fetchDeadlineMs + 1` のタイマーで abortし、`withReadBudget(..., () => abortable(fn(), signal))` を実行する。`operations-report.ts` の予算は45,000ms。
- `packages/sui-client/src/index.ts:health` は `currentReadBudget()` を取得し、既存 pending を待つ場合も `abortable(pending.promise, budget.signal)` を使う。fresh かつ別予算なら古い cohort の終了後、自分の health を再実行する。
- 同ファイルの `read` も親signalで待機を中断する。Sui SDK への signal 渡しと、`shared/src/api.ts` の試行ごとの時間制限もある。
- `tests/sui-health.test.ts` に既に親予算abort・遅着応答・古いcohort待ち中のabortテストがある。関連3ファイル107件を実行して成功した。

### 結論

**呼び出し元の無期限停止という仮説は、worker の取得経路では裏づけられない。** ただし JS のタイマーはイベントループ停止中まで厳密な実時間上限を保証せず、abortable は基礎処理の物理的終了も保証しない。

health が共有45秒の大部分を消費して frames を始められない可能性はある。予算なしの呼び出しも許されるAPIで、未終了の旧pendingがあると新しいfresh呼び出しは自分の予算を待機に使う。ただし「本番で永久pendingが成立する」ことや、その呼び出し元・下位通信の実測時間は未確認。

オフライン補助実験では対象 SHA の health メソッドを抽出し、metadata を手動解放Promiseに置換。旧cohort待機中の後続fresh呼び出し2回はそれぞれabortし、旧pendingは解放まで残った。これは**待機の合流動作の再現**であり、実SDK・通信・`read`を通す再現ではない。親予算で作られたcohort全体が永久に残るという証明にもならない。

当日の `reasonDetail=CANDLE_STALE` は足の古さを支持し、health deadline超過を証明しない。`stallDetails` は CANDLE_STALE を FETCH_DEADLINE_EXCEEDED より先に判定するため、両方が成立した可能性も単一reasonからは排除できない。

### 推奨アクション

1. 先に health開始/終了、pending待機時間、cohortの親予算有無、frames開始/終了、両方のstall条件を同じcycleIdで記録する。既存のSui観測を活用する。
2. health専用の子予算を設ける案を検討。例として10秒なら市場取得に残余を残せるが、**10秒は測定値に基づく確定値ではない**。親deadlineとの短い方を使い、下位signalまで伝播させる。
3. 期限切れcohortを世代で失効させ、遅着がhealthyを再付与しない設計を検証。単にpendingを消すだけで並行RPCを増やす変更は避ける。
4. 親あり/なしの旧cohort、別予算のfresh待機、abort無視SDK、遅着成功、観測永続化遅延を実クライアント境界でテストする。

healthを飛ばす、失敗をhealthyにする、停止条件を緩める案は採らない。

## C. STALE_CANDLES の閾値

### 証拠

`packages/market-data/src/validation.ts` の式は次の通り。

```text
now秒 - (最新足.timestamp + timeframe) > timeframe + 60 → STALE_CANDLES
```

5分足の境界をBとすると、最新足が未着の間、前の足のcloseはB−300秒。B+60秒ではage=360秒で通り、B+60.001秒では落ちる。対象関数そのものを抽出して61本の整合する足で両境界を再現した。

`operations-report.ts` の `marketStaleMs` も360,000ms。`operations.ts:timing` の UPDATING 判定は境界後60秒まで。`controller.py:wait_market_fresh` はソースと lastSuccessAt の90秒鮮度を見るため、足closeそのものの鮮度とは契約が異なる。DeepBook側の検証済み足品質・book・indexer lag の判定も別途存在する。

### 結論

依頼書の境界後60〜120秒の配信遅延を前提にすれば、現条件では60秒超の区間で拒否が起き得る。遅延分布・頻度を新たに測定していないため、120秒等への緩和を安全と断定できない。特に5分足以外は timeframe+60 となり、monitorの5分足360秒契約と一律ではない。

### 推奨アクション

| 案 | 利点 | 制約／判断 |
|---|---|---|
| 閾値を拡張 | 遅延による拒否を減らす | 古い指標を使う時間を伸ばす。validateだけ変えてもmonitorで止まる。現時点で数値変更は推奨しない |
| 取得側の有限リトライ | 更新待ちを吸収 | 45秒予算・API回数の上限が必要。429は即停止し再試行しない。60〜120秒の遅延を1取得内で待ち切る方針にはしない |
| 準備未完／鮮度ゲートで待つ | 古い足で注文せず開始前の永続停止を減らせる | 開始前と開始後の扱い、Aの分類設計が必要。第一候補 |

close時刻、境界から取得成功までの遅延、未着本数、取得時刻、book/indexer lagを継続測定し、p95/p99・最大値と注文時の鮮度要件で判断する。観測だけでは自動復旧しない。OHLC整合・欠損検査は緩めない。

## D. テストとCIの盲点

### 証拠と塞ぎ方

| 対象 | 現在の証拠／盲点 | 推奨テスト |
|---|---|---|
| `test_controller.py:FakeBroker.read_trusted` | `maximum` を受けるが全bytesを返す。本物 `broker.py:read_trusted` は上限+1を読み超過拒否。所有者・mode・symlink制約も本物にはある | fakeもサイズ契約を守らせる。上限−1/同値/+1。所有権等はLinux実brokerで検証 |
| self-read修正の回帰 | `test_controller_fits_its_program_read_maximum` はサイズと文字列を検査するが入口実行ではない | root所有の使い捨て環境で実CLI main→実broker読取→無害なstatusを実行し、上限超過は負例で拒否 |
| `verify_timer.py` | 実PID1・Dockerだがimport後に `object.__new__`。独自Brokerは上限なし、APIはTimeout、maintenance等を置換 | timer試験は残す。入口・権限制約の代替試験とは扱わない |
| `verify_run.py:fixture` / `verify_prod.py` | 実停止・DB/helper等を使うがAPIはfake。deploymentはstartReady=true、summaryは現在時刻。inspectはhealth/portsを補正 | 状態を持つHTTP fakeでreadiness→失敗→復帰、start直前409、reset失敗、遅着応答を再現。実workerのオフラインAPI試験も接続 |
| systemd検証 | workflowの `systemd-analyze verify` はunit定義検査。docker-systemdは実稼働するが上記fixture入口 | 定義検査、PID1動作、実CLI入口、worker API結合を別の保証として明示 |
| setup | `test_setup.py` はdigest/ユニットとpre-install guard等を検査。setup自身のBASE_URLは可変main | SHA固定の配布一式をオフラインHTTPで取得し、旧setup＋旧一式はdigest整合しても期待release不一致で拒否する試験 |
| guardの4xx | 現在は全4xxを「操作未実施」としてpending解除 | 対象arm/start APIが副作用前に拒否する契約を結合テスト。副作用後の切断・5xxはpending維持。将来の別APIまで全4xxで一般化しない |

CIにsystemd試験が無いわけではない。**実際のsystemdの上で、製品の入口や準備状態をfixtureに差し替えている範囲がある**。テスト数の増加だけでなく、この置換境界の契約を明示する必要がある。

### 推奨アクション

まずfakeの制約一致と実CLIの無害な入口スモーク、その次に起動前状態遷移を通す結合試験を追加する。通常CIに実外部サービスの成功を必須とせず、ネットワーク遅延・429・更新遅れを決定的に注入する。本番稼働中に検証runを回す案は採らない。

## E. preflightで弾ける失敗

| 当日の失敗 | 開始前に検出可能か | 現状と提案 |
|---|---|---|
| 1 self-read上限 | 可能。controller自身が起動できないため内側だけでは不可 | 配置時の実入口statusとサイズ契約。現在は明示256KiB上限を使用 |
| 2 古い整合スナップショット | 期待SHAを別に持てば可能 | 各ファイルdigestだけでなく期待releaseと配布manifestを照合。setupのmain URLコメント/BASE_URLは対象SHAでも残るため、コミット固定の運用変更がコード側の強制にはなっていない |
| 3 承認の片方不足 | 可能 | 変更なしのplanでrun/SHA、retry/deploy有無・消費・期限、次操作を返す。秘密値は出さない |
| 4 旧runtime error/cooldown | 検出可能 | 起動後readinessですでに確認。前run由来と現boot由来を識別し、解除許可の範囲を表示。検出とresetを分ける |
| 5 DeepBook env不足 | 可能、実装済み | provider_profile_okでverified必須。期待source/pair、配置env、composeを同一プロファイルで比較 |
| 6 health待機 | 起動時の遅延だけは測れる | 取得予算/残余の計測。後の通信成功はpreflightで保証できない |
| 7 cutoff競合 | 静的設定・経路は検査可能、競合自体は不可 | normal completion中のcutoff/ExecStopPost競合を決定的結合試験にする。PR #93相当を維持 |
| 8 開始直前再発/pending | 現在値は確認可能、確認後の再発は不可 | startの世代付き検証、4xx/未確認の区別、限定healの負例試験 |

preflightが成功したら必ず開始できるという保証は作らない。チェックは「静的配置」「起動後準備」「start時点の証拠」に分け、未開始の拒否を安全な通常結果として扱う。現preflightはstorage・ledger・container・admissionを検査済みであり、これを作り直す必要はない。

## F. 承認・回復フロー

### 証拠と結論

- `approve_retry` は同じrun、failed_requires_review、clean_stopped、診断上review不要を要求し、消費済み・二重承認を拒否する。
- `approve_deploy` は別のSHA付きpermitで、retry-approvedとの共存を拒否する。両方を重ねる仕組みではなく、**再試行か再配置かの排他的な選択**がある。
- `admit_session` は前runの停止証拠・fault・permit消費を確認する。承認なしに前進させない設計自体は妥当。
- `reconcile_preflight` は未起動かつPREFLIGHT_INCOMPLETEの限定回復。`heal_run` はarm/startの4xx拒否・mutation一致・クリーンな停止診断等を要求し、原本を退避して停止レシートを修復する。
- `release_cutoff` / `revoke_retry` による切替操作がある。PR #94でcycleの承認集約・観測経路の分離も既に実施されており、再提案しない。

### 推奨アクション

| 詰まり | 安全性を維持する改善 | 採らない案 |
|---|---|---|
| retryとdeployの取り違え | planで排他理由と必要なrevoke/releaseを表示。実操作は既存の承認下で実行 | permitの自動相互変換 |
| failed_state_unknown | 証拠収集→適用可能な限定reconcile/healを提示。run/receipt/mutation digestを束縛し、ロック内で再確認 | unknownを一律clean扱い |
| start直前409 | worker側で拒否理由と世代を返す。拒否は未開始として記録し、再開の可否を明示 | start/armの無条件再送 |
| reset範囲が広い | 前run由来の許可済みエラーだけを対象化し、新bootの429・手動emergencyは保持。競合は世代で拒否 | 共通resetを何度でも送り続ける |
| 回復中にクラッシュ | 原本退避・ラッチ移動・receipt更新の各中断点で再実行/拒否を試験。部分回復でも診断可能にする | 証拠なしのラッチ削除 |

`recheck_start_blockers` はretry時のみ呼ばれるが、内部は runtimeClear/apiAccess が揃わなければ共通resetを再送する。`http-routes.ts` のresetはAPI cooldown、runtime.error、**emergency**を解除する。新規429や人の緊急停止がその窓で発生した場合の扱いを、優先してレビューする。これは既存の「429即ハードストップ」を変更する提案ではなく、レビュー済み過去障害と新規障害を混同しないための提案。

## 実施順と検証結果

1. **優先レビュー**：reset対象と承認範囲、新規429/手動emergency保持の契約。
2. **先に実装候補**：fakeの制約一致、実mainの無害な入口スモーク、配布release照合、状態遷移HTTP結合テスト。停止条件を変えずに保証を増やせる。
3. **観測追加候補**：health/pending/framesの時間内訳、足到着遅延、start拒否世代。値と原因を収集してB/Cの判断を確定。
4. **設計承認後**：起動前準備状態の分離、世代付きstart、health子予算。鮮度の数値緩和は計測後の別判断。

ローカル確認（Windows、Node v24.22.1 / Python 3.13）：

- `pnpm exec vitest run tests/sui-health.test.ts tests/paper-recovery-engine.test.ts tests/paper-recovery.test.ts`：**3ファイル107件成功**。
- 対象ソース抽出による補助実験：health待機/abortとvalidateCandles境界のassert成功。上記B/Cに実験の置換範囲を記載した。[再現スクリプト](CODEX_QUALITY_REPRO_20261107.mjs) はプロジェクト直下で `node docs/CODEX_QUALITY_REPRO_20261107.mjs` を実行する（Node 24）。
- `python -X utf8 -I deploy/paper-check/test_setup.py`：6件中3件成功、Linux専用3件skip。
- `python -X utf8 -I deploy/paper-check/test_controller.py`：58件中35件成功、20件skip、3件error。2件はWindowsのFakeBroker.directoryがNoneを返しfsyncに渡る問題、1件はfcntl未提供。Linuxでの不具合と結論づけず、Windows対応のskip/fake契約も未整備と記録する。初回のTEMP権限・cp932問題はworkspace内TEMPとUTF-8指定で除外した。

- `pnpm run typecheck`：終了コード0。
- `pnpm run lint`：終了コード0、警告16件。AGENTS.mdの既知14件という記述とは件数が異なるが、エラーは0件。
- `pnpm exec vitest run --maxWorkers=4`：**127ファイル成功・2ファイルskip、1500件成功・12件skip**。sandbox内の試行ではloopback通信のEACCESやhardlink/rename拒否等があり、制限外の再実行で全成功した。製品コードは変更していない。
- `pnpm run build`：成功。500KiB超chunkの既存警告あり。画面変更はなく描画スモークは実施していない。

Linux systemd/Dockerの再実行、GitHub CIの成否、VPSでの再現はこのローカル確認に含めない。修正実装・実機操作はオーナーの指示後とし、CI確認・マージ判断は依頼書どおりシロが行う。

主な参照元（すべて対象SHAの版）：[worker取得・エラー保存](../apps/worker/src/engine.ts)、[取得予算・停止](../apps/worker/src/operations.ts)、[readiness・reset・start](../apps/worker/src/http-routes.ts)、[Sui health](../packages/sui-client/src/index.ts)、[足検証](../packages/market-data/src/validation.ts)、[controller](../deploy/paper-check/controller.py)、[controller試験](../deploy/paper-check/test_controller.py)、[systemd結合fixture](../deploy/paper-check/verify_run.py)、[setup](../deploy/paper-check/setup-paper-check.sh)、[運用記録](VPS_RECOVERY_AUTOMATION_JA.md)、[決定台帳](DECISIONS_JA.md)。
