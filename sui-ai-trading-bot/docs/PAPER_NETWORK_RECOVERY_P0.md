# PAPER通信障害・安全停止・復旧制御（P0）

実装日: 2026-10-23。PAPER限定。売買戦略、RiskEngine、Profit Guardの閾値は変更していない。既存Dockerの停止・再作成・再起動、既存SQLiteの変更、実注文は行っていない。

## 修正した原因

従来はApiAccessの初回一時失敗コールバックが停止理由を固定し、再試行成功後も再開できなかった。最終取得失敗時のengine側も同じ停止を確定していた。この両経路を、根拠のある通信劣化と重大停止に分離した。

調査で特定した36,182msの周期は、DeepBook 5分足のBODY→TLS→CONNECT各8秒と待機・先行通信が累積したもの。8秒の無条件延長や売買条件の緩和はしていない。

## 状態と注文ゲート

既存runtime.running/error/emergencyとoperations.statusは互換性のため維持。追加のsafetyで通信状態とBot状態を分離する。

| 状態           | 注文・復旧                                                                    |
| -------------- | ----------------------------------------------------------------------------- |
| HEALTHY        | 稼働意図・鮮度・バックオフ・実行直前検証を満たした場合のみ注文可能            |
| DEGRADED       | 初回の対象通信異常でruntime.running=false、注文禁止。重大停止理由は固定しない |
| RECOVERING     | 全市場データとgRPCの正常性を複数周期確認中。注文禁止                          |
| ABNORMAL_STOP  | 重大異常、復旧期限・失敗回数超過。自動解除しない                              |
| MANUAL_STOP    | 手動停止・開始待ち。通信が戻っても自動開始しない                              |
| EMERGENCY_STOP | 緊急停止。自動解除しない                                                      |

DEGRADEDになる直前にPAPERが稼働し、重大停止・緊急停止がなかった場合だけ再開意図を保持する。停止中の通信失敗から新しく再開意図を作らない。手動STOP/RESET/START、緊急停止、重大停止、プロセス再起動は再開意図を取り消す。

復旧順序は HEALTHY → DEGRADED → RECOVERING → HEALTHY。最終遷移で再開意図が残る場合だけPAPERを再開し、その遷移が起きた周期自体では注文しない。以後の周期で通常の戦略・見積もり・板・RiskEngine・Profit Guardを通す。

## 一時障害の認定

DeepBook IndexerとSui gRPCの読取だけを対象とする。コード単独では認定しない。実試行のAPI、ホスト（DeepBookは固定）、段階・timeoutType、causeCode、発生時刻を照合する。DNSはEAI_AGAIN/ENOTFOUND、接続切断は既知のcauseCodeに限定。TLS証明書不正、未知の通信例外、Cetus/Geckoの失敗、429、データ異常は従来の重大停止を維持する。

最新の実試行失敗情報がない例外や、別周期の古いエラーを使って自動復旧を認定しない。SuiのラッパーエラーSUI_READ_FAILEDは、同周期に認定したgRPC通信失敗がある場合だけ一時障害として扱う。gRPCヘルスは全応答が確定してから結果を決め、遅れて返った成功が失敗を上書きしないようにした。

## 復旧条件と上限

テスト可能な値は `packages/shared/src/paper-recovery.ts` の `paperRecoveryLimits` に集約した。

- 正常確認2周期以上、最初の正常確認から60秒以上、確認間隔30秒以上。同じ周期の再試行成功や重複呼出しを複数周期と数えない。
- 初回失敗から180秒以上、または対象失敗9試行以上で `PAPER_RECOVERY_EXHAUSTED`。再障害は正常確認数を0に戻すが、初回からの期限を延ばさない。
- 5分・15分・1時間足が連続・確定・鮮度内で、今回取得した品質情報の未解決欠損0。DeepBook選択、fallbackなし、Indexer遅延60秒以内、板の鮮度・深さ・スプレッドが既存検証を通過すること。
- 復旧確認時の市場読取はキャッシュを回避し、Sui healthも120秒の再利用をせず取得し直す。
- 全APIのバックオフ終了、PAPER台帳正常、手動停止・緊急停止・重大停止なし、確認周期内の新たな通信異常なし。
- 取得45秒超、足の鮮度360秒超などのMARKET_DATA_STALLEDは維持。注文ゲートは取得中、直近検証データ180秒超、確定足360秒超でも閉じる。

手動操作と通信異常で世代番号を更新する。非同期見積もり検証中に停止→開始された場合も、古い世代の注文は実行しない。実行直前は板・見積もり期限・台帳を再確認し、RiskEngineとProfit Guardを再評価する。設定・残高が途中で変わった候補は見送る。最後の非同期処理後から約定保存までにawaitを置かない。

## 通信時間と重複取得

- DeepBookは1試行8秒、追加再試行最大2回。1〜1.25秒、2〜2.5秒の待機を維持。
- Sui gRPCの1試行10秒と既存再試行方針は維持。
- 市場取得全体は先行gRPC healthも含め45秒。接続・本文・APIキュー待ち・再試行待機へ中断を伝播し、期限後に追加試行を開始しない。
- 中断されたキュー項目が、前の進行中通信を追い越す競合も防止する。
- NodeのAsyncLocalStorageはWorker側だけに配置し、ブラウザーが使う共通APIにはNode依存を入れない。
- HTTP/2再利用・GOAWAY・中断時接続破棄・120秒アイドル終了は既存実装を維持し、回帰テストで確認。
- 有効な無約定証拠で全欠損を説明できる周期は、過去の1分足ページを取り直さない。証拠期限と検証条件は緩めない。
- 再構築中は不要な板取得を減らし、復旧・再構築・長時間周期の終端で板を更新する。注文候補でも板を再取得する。新たな並列化は追加していない。

## 表示と監査の互換性

現在の通信状態、Bot状態、注文可否、最後の重大安全停止理由、最新API失敗、復旧進捗、最終正常取得時刻を分ける。古い画面では状態不明・注文禁止として表示する。「PAPER検証を再開しました」は実際の復旧遷移後、注文ゲートが開いている場合だけ表示する。

既存KVにpaper_safetyとlatest_api_failureを追加し、既存DBスキーマや履歴は初期化しない。既存の異常停止理由はデプロイや起動で解除しない。

24時間検証は、根拠付きのPAPER_NETWORK_RECOVEREDイベントと世代・正常周期数・正常確認期間・市場/gRPC/台帳/バックオフの確認証拠を照合する。手動停止や重大停止、再起動後の無許可再開は引き続き違反。イベントコードだけでは認可しない。安全確認付き復旧件数を手動開始・再起動件数と区別する。劣化中の注文禁止もAPI異常時の安全措置として記録する。過去に保存済みの違反・失敗・品質記録は消さない。

## 変更ファイル

- Worker: `apps/worker/src/engine.ts`, `operations.ts`, `index.ts`, `validation.ts`
- 共通: `packages/shared/src/api.ts`, `paper-recovery.ts`, `read-budget.ts`, `read-budget-node.ts`, `operations.ts`, `validation-presentation.ts`
- 市場データ: `packages/market-data/src/deepbook.ts`, `provider.ts`, `selection.ts`
- Sui: `packages/sui-client/src/index.ts`
- UI: `apps/dashboard/src/ConnectivityPanel.tsx`, `OperationsPanel.tsx`, `OperationOverview.tsx`, `main.tsx`, `operationLabels.ts`, `validationView.ts`, `DeepBookValidation.tsx`
- テスト: `tests/paper-recovery.test.ts`, `paper-recovery-engine.test.ts`, `read-budget.test.ts`, `connectivity-ui.test.tsx`, `market-scheduler.test.ts`, `candle-reconstruction.test.ts`, `e2e/paper-recovery.pw.ts`, `e2e/deepbook-validation.pw.ts`, `e2e/validation-ux.pw.ts`
- ブラウザー隔離設定: `playwright.safety.config.ts`（ビルド済みUI、専用5177ポート、専用証跡保存先）
- この文書。並行作業のNode要件更新・運用画面再構成は別コミット。型の循環参照だけ互換性修正した。

## 検証と運用への反映

検証はモック、ローカルHTTP/2サーバー、一時/メモリDBで行う。実注文・運用SQLite・稼働中Dockerは使わない。ケース対応はpaper-recovery各テストの初回失敗/再試行成功/複数段階失敗/古い足・板/DNS/gRPC/複数周期/再障害/手動停止/緊急停止/台帳/バックオフ/注文直前障害/並行実行/再起動/LIVE禁止、および既存paper-only・architectureテストを参照。

Node 24.22.1でビルドと全31ファイル・419テストが成功した。テスト用Nodeは公式配布のSHA256を照合した一時配置を使用し、OSのNodeや稼働サービスは変更していない。ブラウザーは375/390/430/1280pxの4幅で復旧6状態、24時間検証と古い画面の扱いを含む80件が成功した。並行実行による開発サーバーの再読み込み・共通証跡削除の衝突を避けるため専用設定を用意した。詳細診断の折りたたみ後も、テストは実際に診断欄を開いて検証する。

再実行:

```powershell
pnpm build
pnpm exec vitest run
pnpm exec playwright test --config playwright.safety.config.ts tests/e2e/paper-recovery.pw.ts tests/e2e/validation-ux.pw.ts tests/e2e/deepbook-validation.pw.ts
```

反映は今回実施していない。既存セッションを維持して現在の検証終了を待ち、次の手順で行う。

1. Node要件を満たす別のPAPER環境と新規の専用DB/ボリューム・別ポートを用意する。既存の検証DBを共有しない。
2. 固定したコミット/イメージで起動し、起動時はBot停止・既存停止理由保持を確認する。LIVE指定は起動拒否する。
3. 隔離環境で障害注入、注文禁止、復旧2周期/60秒、再障害・手動停止・台帳異常を確認する。
4. 本番反映を別途計画する際、整合性のあるSQLiteバックアップ、固定イメージへのロールバック、監視・記録の継続を準備する。稼働中の検証を今回の作業で置き換えない。
5. 新環境のgRPC・全時間足・板・台帳が正常になってから手動でPAPER開始。初回起動/過去の重大停止から自動では開始しない。

外部ネットワークのDNS/TCP/TLS/BODY遅延そのものは未解決。180秒・9失敗または重大鮮度違反では引き続き停止する。約定機会や24時間検証合格を保証する変更ではない。
