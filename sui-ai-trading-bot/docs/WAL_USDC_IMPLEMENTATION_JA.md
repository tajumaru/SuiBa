# WAL/USDC追加：調査・実装・PAPER検証計画

## 対象と方針

対象はtajumaru/SuiBa。最新main `e12548a`を基準とする専用ブランチ`feat/wal-usdc-paper`で、独立worktreeにより実装した。既存作業ディレクトリの未追跡ファイル（MemWal設計文書・Node導入ログ等）は変更していない。mainへの直接コミット・マージ、実資金取引は行わない。

1ペア選択式。SUIの既存DBと取得方式は維持する。WALはDeepBook専用。PAPERのみを許可し、署名・送信・LIVE実行は追加していない。AI APIは既存実装にも存在せず、売買分析はルール戦略である。管理トークン認証、Cookieの同一オリジン検証、Profit Guard、自動復旧後の手動開始条件を維持する。MemWal関連の保存処理は追加・変更しない。

## 調査結果と実装

| 領域 | 既存の固定・経路 | 対応 |
|---|---|---|
| ペア・数量 | sharedの許可CoinはSUI/USDC。9/6桁換算 | WALと型付きペア定義を追加。WALも9桁、USDCは6桁 |
| 市場データ | DeepBook公式Indexerのget_pools / status / orderbook / ohclv / trades。取引SDKは利用していない | URL、メタデータ、出所、再構築証拠をペア引数で束縛 |
| 見積もり | Cetus公式Aggregatorの読み取り専用findRouters | SUI経路を維持。WALはDeepBook板を安全確認し、Cetus見積もりに最小数量・lotを適用 |
| AI判断 | strategy-engineのルール戦略。workerが指標・判断を保存 | ペア別エンジンとDB。指標・判断・候補監査が独立 |
| RiskEngine | BUY/SELL方向をSUI/USDCに固定 | portfolio.baseCoinで方向を照合。注文上限、日次買付、日次損失、保有比率はペア別設定 |
| Profit Guard | SUI固定の売買方向検証。原価はatomic数量とUSDCで管理 | 期待する基軸Coinを明示。異なるペアの見積もりを拒否 |
| PAPER約定・損益 | portfolio.sui、quantityAtomic、costBasisUsdc。既存独立会計照合 | baseCoinを付与。内部suiフィールドは互換性のため基軸数量として維持。両基軸が9桁なので既存会計式は共用可能 |
| 状態・履歴 | 単一SQLiteに注文・約定・残高・リスク・分析・運用検証 | WALのDBファイルを分離。SUIの既存ファイルを変更・移動しない |
| チャート | SUI出所固定。別workerと別SQLite、SUIの過去修復証拠 | pairをworkerへ渡す。WALにはSUI監査済み修復を適用しない |
| バックテスト | SUI固定方向・初期残高 | WALの出所から基軸を識別し、WALの保存足で独立実行。過去板・実lot変更を復元する検証ではない |
| ダッシュボード | SUI名の固定表記、単一状態 | ペア選択、価格・チャート・残高の銘柄表示。一般的な会計ラベルは「基軸通貨」 |
| 運用検証 | 単一DB、24時間合格条件 | ペア別の記録とレポート。JSON/Markdownにペア識別。24時間基準は変更しない |

## 公式確認

[公式TypeScript SDK定義](https://github.com/MystenLabs/ts-sdks/blob/main/packages/deepbook-v3/src/utils/constants.ts)のmainnetCoins/mainnetPoolsと、公式Indexerの実応答を照合した。アプリは従来からIndexerによる読み取り方式のため、取引SDKやBalanceManagerを追加せず、許可された2ペアのメタデータを管理する。

- WAL_USDCプール：`0x56a1c985c1f1123181d6b881714793689321ba24301b3585eec427436eb1c76d`
- WAL：`0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL`、9桁
- USDC：`0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`、6桁
- 実取得したWALの`min_size=1000000000`（1 WAL）、`lot_size=100000000`（0.1 WAL）、`tick_size=1`（価格刻み0.000001 USDC/WAL）
- 参考：SUIのmin_size/lot_sizeは同じ生値、tick_sizeは100

[公式Indexer仕様](https://docs.sui.io/onchain-finance/deepbook/deepbookv3/deepbookv3-indexer)と[プール作成時の価格刻み換算](https://docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information/permissionless-pool)に従う。数量・価格の設定は変更され得るため、WALでは実行時にpool ID・CoinType・桁数・正の注文パラメータを必須検証する。tickは取得・確認するが、本実装は成行相当のPAPER約定であり、指値注文を板に登録しない。

## 切替と隔離

- SUI：従来の`DATABASE_PATH`
- WAL：`DATABASE_PATH + ".WAL_USDC.sqlite"`
- 選択記録：`DATABASE_PATH + ".pairs.sqlite"`
- チャートキャッシュ：各ペアDBパスに`.chart-history.sqlite`を付与
- WALレポート出力：`VALIDATION_REPORT_DIR/WAL_USDC`。SUIの出力先は維持

`GET /api/pairs`で選択状態、`POST /api/pairs`の`{"pair":"WAL_USDC"}`で切替。認証と同一オリジンの既存ガードを通過する。売買稼働中、市場取得中、別API要求中、バックテスト中、レート制限待機中は409。切替後は新エンジン・検証記録・チャートworker・表示キャッシュを作成し、手動開始を要求する。切替元・切替先に未決済数量・残原価・未処理注文／候補があれば409で拒否する。自動決済・取消・残高削除は行わない。切替先はboot前に検査するため、bootによるPENDING候補の中断処理で未完了状態を隠さない。旧版で残った別ペアを確認する場合は停止後にTRADING_PAIRで対象ペアを明示して起動し、決済・会計確認を行う。切替処理自体が失敗した場合は停止してプロセスを終了し、部分的な文脈で継続しない。

UIは`X-SuiBa-Pair`を送り、別タブが古いペアのデータ要求・変更を送ると409 `PAIR_CHANGED`で再読込する。APIに直接接続する独自クライアントもこのヘッダーを指定すること。ヘッダーを省略する既存APIクライアントは現在選択中のペアを操作する互換動作を維持する。

WALのAPIキャッシュ・障害状態をSUIへ持ち越さず、ペア別に保存した状態を復元する。429等の待機中の切替は拒否し、切替によるレート制限回避を許可しない。同じ公式Indexerを利用するため、サービス全体の障害は両ペアに影響し得る。

## 市場データ実測と制約

公開APIでWALの板と5分足1,000本、および300本の取得を確認した。価格・取引量も返る。証跡は`docs/evidence/wal-pair-raw-20261029.json`と`wal-pair-probe-20261029.json`。

最初の1,000本取得ではWALに67区間の欠損があり、既存の最大64区間の再構築予算を超えて`CANDLE_GAP`で停止した。WALのみ直近300本を分析対象とした。5分足では約25時間で、最低61本・全欠損の証明付き再構築・未解決ゼロ・鮮度・最大45秒の取得予算は維持する。SUIは従来の1,000本。より長い履歴は表示専用経路で取得する。

同じ本番処理での再測定では、SUIはready=true、WALは`SPREAD_TOO_WIDE`でready=false。これは安全判定の正常な拒否であり、WALが常時稼働可能であるという実測結果ではない。WALの300本を使う本番経路の完全な成功と長時間安定性は、適正な板が返る時間帯で追加検証が必要。閾値を緩和して合格扱いしない。

既存のAPIタイムアウト8秒、最大2回の一時障害再試行、取得全体の予算、安全停止、板10秒、Indexer遅延60秒、確定5分足360秒、maxSlippage・両側板厚の検査を維持する。WAL通信失敗時にSUIの足や価格を代用しない。

WALの買いは保証出力数量をlot単位で切り捨て、売りも保有量と上限内のlot単位に丸める。買いの切捨て損失をpriceImpactへ加算し、リスク審査に渡す。最低数量未満は拒否する。買いの端数は保守的なPAPERモデル上の損失となり、実資金の残高移動を意味しない。Cetus見積もりはDeepBookへの指値注文を再現するものではない。下位lotの残数量は売却できない場合がある。

## 再現コマンド

プロジェクトディレクトリで実行する。全コマンドはNode 24.22.1以上・25未満を既存ランナーで強制する。

```powershell
node scripts/verify-node-version.mjs
pnpm typecheck
pnpm build
pnpm test
pnpm test:offline
pnpm test:e2e
node --import tsx scripts/probe-trading-pairs.ts
```

最後のprobeは公開市場データの読み取りのみで、注文・開始操作は行わない。`ready=false`を成功に読み替えない。fixtureのPAPER約定成功と、実市場での安全条件成立は別の検証である。

## 30分PAPER検証

1. 本番稼働と別の作業コピー・DB・ポートを使用する。Node確認後、`MODE=PAPER`、`MARKET_DATA_PROVIDER=deepbook`、`DEEPBOOK_RECONSTRUCT_CANDLES=verified`を指定する。専用の管理トークンは環境または秘密ファイルから読み、証跡に含めない。
2. 運用検証記録を有効にする場合は既存条件に従い、`DEEPBOOK_VALIDATION=1`、`DATABASE_PATH=data/validation/deepbook-paper.sqlite`、`VALIDATION_REPORT_DIR=data/validation/reports`とする。通常運用DBを使わない。`TRADING_PAIR`は未設定とし、UIで対象を選ぶ。
3. 停止状態でWAL/USDCを選択し、未解決欠損ゼロ、板・足の鮮度、Indexer遅延、両側5 USDC以上の流動性、スプレッド0.3%以下、Profit Guard有効を確認。条件未達なら開始せず「不成立」を記録する。
4. 「検証記録を開始」を実行し、接続と復旧条件が成立した後に手動でPAPER開始。開始時刻・SHA・ペア・Node版・設定を記録する。
5. 5分ごとに分析・候補・注文・約定・会計照合・API再試行・停止理由を確認する。売買の発生は必須とせず、条件不足時のWAIT/拒否も記録する。架空のシグナルを注入して実市場成功にしない。
6. 単調時計で30分経過後に停止。注文件数と約定件数の対応、負残高ゼロ、実現損益と費用、異なるペアのsource/quote/銘柄ゼロを確認。JSON/Markdownとペア別DBを保存する。
7. 別の期間としてSUIへ切替え、WALの履歴・損益が表示されないこと、SUIの既存状態が復元されることを確認する。SUIでも30分検証を行う。

## 2時間PAPER検証

30分検証で会計・混在・安全停止に問題がないことを前提に、同じペアを切替えず連続2時間実施する。開始から30/60/90/120分をチェックポイントとして、分析周期、API実試行数・失敗率、タイムアウト、安全停止、復旧後の手動開始、板・足・指数鮮度、残高・原価・実現損益を記録する。途中停止・通信不良は欠測を隠さず評価する。強制タイムアウト試験はfixture/隔離環境で行い、稼働中の共有ネットワークや本番サービスを遮断しない。

各ペアは別期間として2時間ずつ計測する。同時稼働は対象外。途中で切り替えた期間を合算しない。終了後にPAPER停止を確認し、レポート・設定・SHA・実測開始終了時刻を保存する。既存の24時間検証画面は30分/2時間時点で「検証途中」のままで正しく、これを24時間合格や長期安定性の証明としない。

今回30分・2時間の実市場PAPER稼働は実施していない。実行計画と自動fixture検証を提供する。

## 最終テスト結果

- Node：v24.22.1。型検査・production build成功。
- `pnpm test`：75ファイル、1,069件成功。別途Node組込みテスト45件成功。
- `pnpm test:offline`：73ファイル、1,039件成功・8件は既存のネットワーク禁止条件でskip。別途Node組込みテスト45件成功。
- WAL専用テスト15件：市場取得、メタデータ不一致、9/6桁換算、lot/最小量、PAPER原価・損益・Profit Guard、ペア別DB/リスク、タイムアウト時の注文停止、異ペア証拠の拒否。
- 実HTTP API：管理認証、SUI→WAL→プロセス再起動→SUI、設定・履歴保存、古いX-SuiBa-Pairを持つ変更要求の409を検証。
- WAL UI：375/390/430/1280pxで切替・再読込・WAL銘柄・残高・横幅を検証。関連画面（WAL選択・既存SUIの運用検証・チャート）76件が全件成功。
- 全E2E 264件の試行ではmainから存在する認証fixtureの不整合が判明したため途中で切り分けに移った。無変更mainの375pxでchart-sync、dashboard-feed、deepbook-validation、localizationの6件を再実行し、同じ5件失敗／1件成功を確認。認証session POSTを売買変更と数える、session APIを404にする、未知要求として拒否する等のfixture問題である。全E2E成功とは報告しない。
- 公開市場probe：SUI ready=true、WAL SPREAD_TOO_WIDEで停止。WAL生APIは板・価格・5分足300本を取得。PAPERの30分/2時間実市場連続検証は未実施。
- buildには既存依存のpure注釈と500kB超bundleの警告がある。ビルドは成功。
- 最新main e12548aへの追従後も型検査・build・全1,069件＋Node45件を再確認。WAL切替4幅とmainで変更された概要画面4幅も再検証した。
- 既存GitHub ActionsのNode 24.22.1固定、typecheck/build/offlineテストを変更していない。

## 変更ファイル一覧


- `.env.example`
- `README.md`
- `apps/dashboard/src/BacktestComparison.tsx`
- `apps/dashboard/src/OperationsPanel.tsx`
- `apps/dashboard/src/PriceChart.tsx`
- `apps/dashboard/src/PriceTicker.tsx`
- `apps/dashboard/src/ProfitGuardPanel.tsx`
- `apps/dashboard/src/SettingsPage.tsx`
- `apps/dashboard/src/StrategyPanel.tsx`
- `apps/dashboard/src/agentNarration.ts`
- `apps/dashboard/src/main.tsx`
- `apps/dashboard/src/style.css`
- `apps/worker/src/chart-history-client.ts`
- `apps/worker/src/chart-history-worker.ts`
- `apps/worker/src/chart-history.ts`
- `apps/worker/src/engine.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/validation.ts`
- `docs/WAL_USDC_IMPLEMENTATION_JA.md`
- `docs/evidence/wal-pair-probe-20261029.json`
- `docs/evidence/wal-pair-raw-20261029.json`
- `packages/backtest-engine/src/index.ts`
- `packages/dex-router/src/index.ts`
- `packages/dex-router/src/pair-router.ts`
- `packages/market-data/src/deepbook.ts`
- `packages/market-data/src/reconstruction.ts`
- `packages/paper-trading/src/index.ts`
- `packages/profit-guard/src/index.ts`
- `packages/risk-engine/src/index.ts`
- `packages/shared/src/api.ts`
- `packages/shared/src/http-errors.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/validation-presentation.ts`
- `scripts/probe-trading-pairs.ts`
- `tests/agent-narration.test.ts`
- `tests/dedup-pass.test.tsx`
- `tests/e2e/operations.pw.ts`
- `tests/e2e/wal-pair.pw.ts`
- `tests/header-avatar.test.tsx`
- `tests/settings-api.test.ts`
- `tests/wal-pair.test.ts`


PR #25の最終レビューと修正内容は[PR25_FINAL_REVIEW_JA.md](PR25_FINAL_REVIEW_JA.md)を参照。
