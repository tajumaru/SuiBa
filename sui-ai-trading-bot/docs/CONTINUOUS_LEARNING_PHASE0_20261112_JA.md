# 継続学習AI Phase 0：既存監査と段階導入設計

監査日：2026-11-12。対象：tajumaru/SuiBa / sui-ai-trading-bot。
fetch後の開始時 main SHA：`ca59f553b70e4856580dd02b53ee4b43e64bbcfe`。
作業ブランチ：`docs/continuous-learning-phase0-20261112`。
本書のパスはアプリ直下からの相対パス、行番号はこのSHA時点。
元の作業ツリーのHEADは `de533b23a113a3d0da2c450451988946859c58c3`。
既存の未コミット変更を保持し、最新 origin/main の独立worktreeで監査した。

## 1. 結論と変更境界

現行はPAPER専用のルール売買と、表示専用の統計的相場予測である。
予測記録・答え合わせ・幅の自己校正は既にある。「AI未実装」を理由に
これらを新設し直さない。一方、サーバでの常時予測記録、時点情報を固定した
学習データセット、モデル台帳、定期学習、承認付き更新は未実装である。

推奨は、予測パラメータ・コーン形状のオフライン再推定から始め、売買は
既決方針の「既存BUY候補の採用／見送りを教師ありで選別」に限定する。
予測精度と売買収益を独立採点し、どちらかの改善を他方の改善と解釈しない。
LLM接続・深層学習・強化学習・新しい外部サービスは初期導入に不要。
MemWalは**今回の継続学習計画の対象外**とする。SQLiteと検証済みスナップショットを正本にする。
これは恒久的な採用却下ではない。明示承認された評価・失敗原因・改善要約の
ミラー先として将来検討する既存方針は維持する。

今回は設計書のみ。実行コード、DBスキーマ、Actions、Docker、通信、設定、
安全停止、RiskEngine、Profit Guardを変更しない。main変更・マージ・VPS接続／
デプロイ・実資金取引・学習実行・記憶サービスへの保存を行わない。
Phase 1以降も別PR・レビューで実装し、売買適用はオーナー承認を必須とする。

## 2. 既存機能監査表

状態は「既存実装」「部分実装」「設計のみ」「未実装」。部分実装は、目的の
一部を満たすが継続学習基盤としては不足するもの。未実装の判定範囲は
追跡対象の apps / packages / scripts / package.json / pnpm-lock.yaml。
配備済み環境や未追跡ファイルの有無は証明しない。

### 2.1 予測

| 項目 | 状態 | コード根拠と限界 |
|---|---|---|
| アルゴリズム／モデル | 既存実装 | `apps/dashboard/src/chartForecast.ts:103` FORECAST_PARAMS、`:184` forecastWith。EMA20傾きと直近20終値の最小二乗傾きを混合、RSI極端値で減衰、ATRと経験分位点で非対称コーン。ニューラルモデルではない |
| 外部AI SDK/API | 設計のみ | `docs/AI_SHADOW_MODE_DESIGN_JA.md` §5/11にLLM案。package.jsonとlockfile、Worker/packagesにAI SDK・LLM呼出しなし。Sui/Cetus SDKは市場・見積り用でAIではない |
| 市場特徴量 | 既存実装 | chartForecast.ts forecastWith：連続足の末尾最大80本、終値、EMA20、RSI、直近15本からの14区間ATR、任意の板imbalance。出来高はこの予測式に直接使わない。売買の特徴量とは別 |
| 予測時点の入力 | 部分実装 | `apps/dashboard/src/PriceChartModel.ts:130` chartForecast呼出し。ローソク列、板偏り、幅scaleを利用。入力全列・取得可能時刻・設定hashの不変保存はない |
| 対象期間 | 既存実装 | chartForecast.ts FORECAST_BARS=24、5分足なら2時間。任意timeframe/barsも関数引数に存在。継続評価初期は300秒×24に固定 |
| 保存 | 部分実装 | `apps/dashboard/src/forecastLog.ts` forecastRecordFrom / appendForecastRecord / saveForecastLog。origin、startClose、方向、上下／中心線、tilt、touchを端末localStorageへ最大288件。ペア別キー。閉じていた時間は欠測 |
| 実績照合 | 部分実装 | 同ファイル scoreForecasts / latestAnswerCheck / forecastVerdictOf / forecastTouchStateOf。実足closeとコーン、最終方向、high/lowタッチを照合。scoreForecastsは部分到着も件数に数える。方向verdictは後続足による閉鎖確認あり。常時自動採点台帳ではない |
| バージョン管理 | 部分実装 | Git上の定数とlocalStorageキーv1、旧recordへのoptional互換のみ。予測ごとのmodelId、datasetId、artifact hashなし |
| 再学習／更新 | 部分実装 | `apps/dashboard/src/forecastCalib.ts` calibrationStep：30件以降10件単位、目標80%、deadband±3点、scale 0.7〜1.5。表示幅だけを更新しドリフト／売買には不介入。定期オフライン再学習はない |
| 精度評価 | 部分実装 | forecastLog.ts scoreForecasts：収まり率、方向率、touch件数。chartForecast.ts:97〜136のMAE・coverage・過去walk-forward値はコードコメントの過去報告であり、現在データでの再現済み実測ではない |
| 相場パターン／類似検索 | 未実装 | apps/packagesに市場系列の近傍検索・embedding indexなし。market-weatherの局面分類は類似検索ではない。patternLock.tsは廃止ログイン鍵の削除処理で無関係 |

実際の5分足記録・校正の接続は `apps/dashboard/src/useForecastSuite.ts`
（useForecastSuite内のeffect、forecastRecordFrom / scoreForecasts / calibrationStep呼出し）。
PriceChartModelは表示側の接続であり、記録処理そのものとは分けて確認した。

### 2.2 判断・PAPER会計

| 項目 | 状態 | コード根拠と限界 |
|---|---|---|
| エントリー／見送り | 既存実装 | `packages/strategy-engine/src/index.ts:47` RuleBasedStrategy.analyze。EMA上昇／任意の差縮小、RSI回復、MACD histogram改善、出来高検査。NO_SIGNAL / VOLUME_REJECTのWAIT。confidenceはWAIT=0、それ以外0.7で確率ではない |
| 決済・利確・損切り | 既存実装 | 同analyze：STOP_LOSS / TAKE_PROFITを先に評価、SELL_SIGNALはSTRATEGY_EXIT。注文成立には後段gateがあるのでSELL判断＝決済ではない |
| RiskEngine | 既存実装 | `packages/risk-engine/src/index.ts:25` assessRisk。停止・緊急・エラー、残高、注文／日次買付／損失／保有比率、slippage/impact、鮮度、重複、同時注文等を検査 |
| Profit Guard | 既存実装 | `packages/profit-guard/src/index.ts:219` evaluateSell、`:316` evaluateBuy、allocateCost / strategyExitPrice。費用既知・quote有効性を検査。保護出口は既存仕様で最低利益検査をbypassするが、壊れたquoteや不明費用を許可する仕組みではない。モデルがpurpose/configを変更してbypassを作ることは禁止 |
| PAPER約定／損益 | 既存実装 | `packages/paper-trading/src/index.ts:45` PaperTrading.fill。minAmountOut使用、原価配賦、追加手数料＋gas、実現損益、ペア不一致／期限／流動性検査。`packages/database/src/index.ts` commitFillで会計検査と永続化 |
| コスト | 部分実装 | profit-guard paperCostsは追加fee/gasとdexFeeを区別。quoteのminAmountOutに不利な出力を反映し、Fill.slippage/priceImpactも保持。実際の板待ち・部分約定列を完全再現する保証はない。spreadを一律に追加控除すると内包費用と二重計上の恐れ |
| SUI/WAL分離 | 既存実装 | `apps/worker/src/index.ts:83〜92` pairPath：SUI既存DB、WALは.WAL_USDC.sqlite、選択は.pairs.sqlite。1ペア選択式。forecastLog/Calibもペア別。market_candlesのPKは(timeframe,timestamp,source)でpair列なし。DBを単純結合しない |
| 取引しなかった判断 | 既存実装 | `apps/worker/src/engine.ts:187` analyzeCycle、`:262` recordAnalysis。`packages/database/src/index.ts:589` recordAnalysisでstrategy_decisionsとtechnical_indicatorsをcycleId同一トランザクション保存。WAITも保存。停止中のanalysisContextと実行許可を分ける |
| 候補／拒否／実行の追跡 | 部分実装 | engine.ts:360以降の候補監査、:643/:712 assessRisk、:748 fill、:972 candidateId/orderId。operation_candidates / cycle_audits / paper_orders / paper_trades。通常WAITは注文候補にならない。期間端・中断時のID欠落は監査が必要 |
| 取引評価／改善 | 部分実装 | `packages/backtest-engine/src/index.ts:72` modelQuote、`:122` modelCosts、`:151` summarize、`:402` compareBacktests。確定足判断→次足openのモデル約定、コスト・guard/risk・DD評価。`docker/run-review.py` analyzeは+1h/4h/24h、手数料往復0.6%近似でslippage未控除。自動モデル改善・採用はない |
| 学習データ監査 | 既存実装 | `scripts/ml-data-audit.ts:49` auditDatabase。readOnly/query_only、件数・JSON・ID結合・重複・費用を検査、trainingReadyは常にfalse。学習器・ラベル生成器ではない |

補足：`packages/market-data/src/quote-book.ts` quoteBookReasonは新鮮なbid/askの
midに対する不利なquote乖離を検査する。spreadを完全な約定再現に使う機能とは異なる。
compareBacktestsは現状Guard off/on比較で、任意の学習policyを挿す一般的な比較器ではない。
再利用するのは純粋計算・quote/会計の契約であり、候補policyの注入と独立資産状態の
比較はPhase 3の新規実装に含む。HISTORY_LIMIT_5000もあり、長期評価は
ウォームアップと保有状態を保つ窓分割の検証が必要。trainEndの記録だけでは学習済みを意味しない。

**独立評価の判定：概念・実装経路は既に分離されており可能。ただし現在の
端末予測とサーバ判断を完全に同定する台帳は不足。** 予測は全予測時点の市場結果、
売買は保有・資金・約定と費用込み資産経路で測る。WAITに実現損益は無い。
予測的中率だけで売買成績を主張できず、run-reviewの将来リターンはPAPER会計そのものではない。

### 2.3 長期記憶・既存設計

追跡文書は [Walrusクラウド設計](WALRUS_SITES_CLOUD_ARCHITECTURE_20261030_JA.md)
§7（182〜188行）、[AI Shadow設計](AI_SHADOW_MODE_DESIGN_JA.md)、
[ML監査](ML_DATA_AUDIT_JA_20261107.md)、[決定台帳](DECISIONS_JA.md)を確認。
独立したMemWal実装／専用スキーマはmainに存在しない。

| 項目 | 状態 | 既存内容と本計画との差 |
|---|---|---|
| 記憶スキーマ／保存対象 | 設計のみ | SQLite正本、Walrusは暗号化hash付き監査bundle、MemWalは明示承認された戦略評価・失敗原因・改善要約。namespaceを環境／ペア／戦略版で分け、cycle/decision ID・source time・code/schema/hashで追跡。型の実装なし |
| 類似検索 | 設計のみ | remember/recall利用の検討。系列類似度・索引・as-ofフィルタ実装なし |
| Shadow評価 | 設計のみ | AI_SHADOW_MODE_DESIGN §4/7/8の凍結入力、専用shadow_decisions、run-review比較。MemWal接続を必要としない |
| 未来混入防止 | 部分実装 | 既存backtestは確定足のみ、ml-data-auditはevidence時点形式等を検査。記憶検索の当時アクセス可能時刻での制約は未実装。Shadow文書の凍結入力原則を継承する |
| 削除 | 設計のみ | 記憶削除・暗号鍵失効・blob期限は別という注意あり。削除実行・索引反映・派生データ追跡は未実装 |
| 障害分離 | 設計のみ | 記憶障害では記憶処理だけ停止、recallを命令／会計値にしない。実運用テストなし |
| Node.js 24 | 未実装 | アプリはpackage.jsonで >=24.22.1 <25、MemWal依存はlockfileにない。従ってSDK互換は未検証で「互換あり」とは判定しない |

重複するのは証拠ID・要約保存・候補判断記録・Shadow採点であり、学習用の
数値時系列を意味検索へ移す必要はない。MemWalを正本／唯一の保存先にしない。
今回の学習基盤には導入不要のため公式SDKや追加サービスの採用調査も行わない。
承認された要約のミラーは別目的・別計画であり、本計画の対象外という判断で妨げない。
将来必要になった場合だけ、所有者による保存対象の明示承認、時点フィルタ、
削除・保持契約、Node24インストール／暗号化／往復テストを別PRの前提とする。

## 3. 重複回避・不足と優先順位

| 優先 | 再利用するもの | 不足するもの／新設不要なもの |
|---|---|---|
| P0 | forecastWith、forecastRecordFrom、既存指標 | ブラウザ依存を外す純粋予測部の共有と同値検証、時点入力・版付きの常時記録。予測式を別に再実装しない |
| P0 | recordAnalysis、StrategyEvidence、cycleId、候補監査 | pair/run/build/config/source/availableAtを結ぶmanifestと欠落監査。第二の判断台帳を作らない |
| P0 | 保存済み足、検証・repair provenance、paper-backup | as-of履歴と確定ラベル台帳。過去のupsert足を当時利用可能だった足と扱わない |
| P0 | scoreForecasts / verdict / touch | 常時・完全期間の採点、欠測状態、冪等な再採点、予測と実績のversion管理 |
| P1 | ml-data-audit、compareBacktests、会計／Risk／Guard | 不変dataset、purged walk-forward、再現manifest、候補／現行同条件比較。新しい会計エンジンは不要 |
| P1 | AI Shadow設計の入力凍結・追記・無権限原則 | 複数model比較キーと独立Worker。LLM専用の第二Shadow基盤は作らない |
| P2 | 既存hash・backup検証、変更承認の運用 | model registry、署名検証、オーナー承認と原子的切替／rollback。学習Workerへ配置権限を渡さない |

保留中の `feature/backtest-candidates` を再開・pushしない。本書はmainにある
純粋計算を参照する設計であり、保留ブランチの機能採用を意味しない。
BTCの取引特徴量利用、注文上限拡張等の見送りは維持する。

## 4. 推奨アーキテクチャとデータフロー

```text
既存市場取得 → 既存Bot分析 → 既存Risk/Guard/安全gate → PAPER会計
                  │ 既存判断証拠 + 最小の時点記録（将来PR）
                  ▼
          ローカル耐久記録 → 整合スナップショット + manifest
                                    │ read-only
                                    ▼
                     独立Evaluator / Training Worker
                       ├─ 品質監査 → dataset固定
                       ├─ 予測採点／再推定
                       ├─ BUY選別のPAPER経路比較
                       └─ 候補artifact + report（採用権限なし）
                                    ▼
                    隔離Shadow Worker（注文接続なし）
                                    ▼
               オーナー承認 → 独立した適用経路 → 版付き選択
                                       └─ 旧版へrollback
```

学習・採点・Shadowはtickからawaitしない。Botの既存DBへ学習Workerは接続しない。
将来の追加記録だけはBotが観測時に行う必要があるため、最小化・計測する。
有界キューと容量上限でバックプレッシャーを限定し、追加記録に失敗した区間は
gapとして学習対象外にする。既存recordAnalysisの失敗意味論は変更しない。
記録不能時に安全チェックを飛ばす／注文を再送する経路は作らない。

予測の初期サーバ評価は「板tiltなし・固定幅scale=1」の識別済み基準も並記する。
表示予測と同じと主張するには、同時点の板tilt・端末scaleまで凍結できた場合に限る。
ブラウザ記録を履歴補完するための架空の予測生成はしない。

AI Shadow既存設計は1 cycle=1 LLM記録、Worker内非同期の案である。
本計画では学習候補のShadowを別プロセスへ分離し、
`(cycleId, modelId, snapshotId)` で複数候補を識別する拡張案とする。
既存文書の上書き実装はせず、実装前に契約を一つに統合する。
LLM provider・cadenceは既存の未決事項のまま。安定化後に着手する順序も維持する。

## 5. 学習データスキーマ案（DDLではない）

現行DBのschemaは今回変更しない。将来はBot側の観測記録だけを最小追加し、
結果・dataset・学習run・候補は別の研究用SQLite／ファイルに置く。
既存汎用イベント形式を使うか専用表にするかは、サイズと読み出し計測後に決定する。

| 論理エンティティ | 必須項目／一意性 |
|---|---|
| source_manifest | runId、PAPER、pair、provider/pool、codeSha、imageDigest、Node/lockfile hash、settingsHashと有効期間、schemaVersion、DB hash、取得時刻、run境界・停止証拠。秘密値は含めない |
| market_observation | observationId、pair/source/timeframe、candleOpenSec、closeTimeMs、firstAvailableAtMs、observedAtMs、sourceRevision、OHLCV、finality/quality/repair provenance、payloadHash。改訂は上書きせず別版 |
| feature_snapshot | snapshotId=正規化payload hash、run/pair/provider/cycleId、predictionAtMs、decisionCutoffMs、観測ID列、featureSchema、特徴量／欠測mask、設定・コードhash、板observedAt（使用時）。ラベルやfinalActionは含めない |
| prediction_event | predictionId、snapshotId、modelId、artifactHash、originSec、timeframeSec、horizonSteps、各mid/up/lo、direction、touch、scale/tilt、createdAtMs、status。UNIQUE(pair,modelId,snapshotId,horizonSpec) |
| outcome_label | predictionId/opportunityId、labelSpecVersion、labelStart/EndMs、確定時刻、使用した結果観測ID/hash、actualReturn/close/coverage/touch又は反実仮想netPnl、status/reason、revision。UNIQUE(subjectId,labelSpecVersion,resultRevision) |
| decision_link | run/pair/cycleId、opportunityId、strategyVersion、snapshotId、candidate/order/trade IDs、analysisContext、BUY/WAIT/SELL、risk/guard/finalAction。実行後項目は特徴量領域と物理／型境界で分離 |
| dataset_manifest | datasetId=内容hash、入力manifest/hash列、抽出code、feature/label版、as-of cutoff、除外理由別件数、重複group、train/validation/test期間、purge/gap、split hash。生データへの参照を含む不変版 |
| training_run/model_registry | trainingRunId、datasetId、parent/currentModelId、family/params/seed、runtime/lockfile/image、開始終了・資源量、status（SKIPPED含む）/reason、artifact hash/size/schema/signature、評価report hash、状態遷移 |
| evaluation/approval | current/candidate modelId、同一dataset/split/cost/初期portfolio、指標・信頼区間・サンプル数、Shadow入力一致率/遅延/失敗、approvedBy/at、承認対象hash、適用／旧版／rollback理由 |

共通に時刻の単位を名前で固定する。既存Candle.timestampはopenのepoch秒、
timeframeは秒、Fill.timestampと評価／取得時刻はepoch ms。
originだけでペア・モデルを跨いで結合しない。

## 6. 時点整合性・再現性

1. 使用可能条件は `closeTimeMs <= decisionCutoffMs` かつ
   `firstAvailableAtMs <= decisionCutoffMs`。predictionAtは実際の推論開始、cutoffは
   入力凍結時刻。後日取得した足で当時の特徴量を補完しない。
   取得可能時刻が不明な旧足は研究用の事後系列として分離し、本番as-of成績の根拠にしない。
2. 初期の予測対象は5分×24本。originは最初の予測足open。
   labelEndは最後の対象足close。後続足・供給元の確定証拠と全24本の品質確認後だけ
   COMPLETEにする。既存scoreForecastsの部分採点はprogress指標として区別する。
3. PENDING / COMPLETE / MISSING / LATE / INVALID / CENSOREDを区別し、
   欠損・遅延・改訂・鮮度違反・修復由来を理由付きで除外する。締切／遅延許容は
   provider実測から事前固定。結果改訂は旧labelを消さず新revisionで再採点する。
   タッチも確定high/lowで採点し、足内順序が不明なら先行TP/SLは不明とする。
4. 同足の再ポーリングはopportunity単位へまとめる。pair/provider/rule版/runを含む
   IDでgroup化し、保有を共有する判断も別foldへ分散させない。
5. カレンダー時間順のwalk-forwardを使う。学習、閾値選択用検証、最後の未使用testを
   分離。正規化・欠損処理・特徴量選択はtrainだけでfitし、検証で選んだ仕様をtest前に凍結。
   testを見て変更したら、そのtestは開発データへ降格し新たな未使用期間を待つ。
6. label期間が評価窓へ重なるtrain行をpurgeする。予測は最大2時間、売買は固定した
   ラベル上限に応じたgapを設ける。実際のlabelEndも検査し、固定gapだけに依存しない。
   不規則候補に行数だけの分割は使わない。重なる予測は時間blockで不確実性を推定する。
7. 現行と候補は同一snapshot集合・欠測mask・split・fee/spread/slippage・初期資産・
   出口／guard/risk版・評価時点で比較。片側失敗を黙って除外せず共通集合と全件失敗率を報告。
   候補だけ最新の修復足や板履歴を与えない。SUI/WALは別集計・別合否とする。
8. datasetId、modelId、seed、ハイパーパラメータ、code/lockfile/image hash、数値許容誤差、
   試行回数、不採用結果を残す。同一入力再実行で同じsplit/予測/採点を再現できることを検証。
   非決定的な外部LLM応答は保存応答のreplayと新規応答を分け、同一学習モデルと称さない。

データ不足は失敗ではなく `SKIPPED_INSUFFICIENT_DATA` とし、独立予測数・有効期間・
方向別件数・局面・正負ラベル・打切り率・pair別不足と必要な追加証拠を記録する。
旧ML監査の実測は2026-10-20の判断312件すべてWAIT、BUY/約定0件であり、
現在のVPS残高・件数ではない。本Phase 0では新しいDB／VPS実測を取得していない。
従って現時点のtrainingReadyは未確認であり、学習可と判定しない。

## 7. 予測評価・売買評価・学習方式

### 7.1 予測モデル

現行forecastWithと「変化なし（last close）」を基準に、MAE（価格正規化）、
方向正解率と方向を宣言した比率、区間coverageと幅／interval score、touch確率の
Brier score／信頼度曲線をhorizon別・pair別・局面別に出す。
幅を広げるだけのcoverage改善は採用理由にしない。flatを外した方向率は分母も出す。
板tiltなし／あり、端末校正なし／ありを別modelIdとし、オンライン幅更新履歴も
入力状態として保存する。保存が無ければ板ありの過去比較を行わない。

Phase 2は既存のdamping/slopeLookback/driftModeと経験誤差分位形状の
限定的なオフライン再推定を候補とする。探索範囲と試行数はtest前に固定する。
予測ごとの自動再校正は現行表示専用のまま、候補の自動本番適用には転用しない。
予測モデルの必要標本数に売買の300候補基準を流用せず、時間block有効数・
期間別誤差・coverageの不確実性をPhase 1で測り、許容幅と収集期間を事前登録する。

### 7.2 PAPER判断モデル

既存決定を維持し、最初はBUY候補の二値選別（単純なロジスティック回帰を候補）だけ。
目的変数は固定出口・コスト・安全条件の仮想PAPER経路が終了した純損益の正負。
取引しなかったことを負例としない。通常WAITは見送り母集団分析、
安全拒否は解除不能の別分類。fillPrice・finalAction・将来損益を入力にしない。
SELL・数量・risk上限・安全復旧の最適化は対象外。

既存compareBacktestsの純粋計算とPaperTrading/Guard/Riskを再利用し、
モデル無選別、候補選別、USDC待機の全ポートフォリオ経路を比較する。
候補を一つ見送ると以降の資金・保有・機会が変わるため、候補ごとの勝率平均だけでは不足。
OHLCモデル約定は次足openと固定した不利側コストを使い、板履歴がなければ
実約定再現とは呼ばない。実現／未実現、原価配賦後net PnL、最大DD、取引数／往復数、
資金拘束、失敗・拒否、観測間gap、コスト感応度を報告する。
既に費用込みのrealizedProfitへfeeを再控除しない。
run-reviewの0.6%近似は補助指標として維持し、会計成績と混ぜない。

### 7.3 採用ゲート

数値を新しく断定しない。既存ML監査の段階1は閉じた往復30件・結合欠落／
不正JSON／費用不明0、段階2はBUY候補300件・約定100件・往復80件が2局面以上。
これは既存の暫定的な試行開始条件で、性能保証／採用条件ではない。
Shadow文書のn≥30、正味+4h≥0.30%、プラス率≥50%も仮置きの研究フラグである。

採用前に実データ監査からpair別の有効標本数と基準分布を示し、改善最小幅・
最大DDの非劣化幅・失敗／遅延許容・Shadow期間と最低件数・劣化検知窓を
オーナーと事前登録する。数値未確定のままPROMOTABLEにしない。
複数の未学習期間、未使用の最終test、SUI/WAL別の安定性、費用増／遅延条件でも
改善が残り、誤差・net PnL・DD・取引数・不確実性を同時に確認する。
片方のpairだけ合格したモデルは、そのpair以外へ適用しない。

Shadowでは同じ入力で現行と候補を並走し、入力hash一致率、予測差、
BUY/WAIT一致／不一致、遅延・エラー・欠落、予測劣化とPAPER仮想経路劣化を監視。
トリガー抽出による偏りを明示し、非発火数を含む母集団カバレッジを報告する。
Shadowは約定を生まないので実取引サンプル数へ加算しない。

状態は GENERATED → OFFLINE_EVALUATED → SHADOW → REVIEWABLE → APPROVED → ACTIVE。
不足／不合格はSKIPPED／REJECTED。学習完了や定期job成功で承認へ進まない。
オーナーがreport/dataset/artifact hash、pair、用途、旧版を確認し承認したものだけ適用可能。
予測表示版の承認は売買判断利用の承認を兼ねない。

## 8. 安全性・Worker・VPS資源

初期推奨はVPS外の隔離実行（Actionsのhosted runner又は専用オフライン環境）。
VPSの実CPU/RAM/空きディスク、Bot peak RSS、tick遅延、DB/WAL増加率は未取得。
従って「同居可能」と判定しない。VPSを本調査から操作しない。

| 対象 | 将来実装の制約 |
|---|---|
| 独立コンテナ | Botとは別コンテナ、非root、read-only rootfs、capabilities削除、no-new-privileges、pids上限、network無効を初期値。Docker構成は別PR |
| 入力 | 整合した保存コピーだけread-only mount、query_only。稼働中DBを単純コピーしない。既存createPaperBackupの停止／maintenance要件を迂回せず、自然停止後の承認済みコピーを使う。オンラインsnapshotが必要なら別途設計・負荷検証 |
| 権限 | 本番ADMIN_TOKEN、署名秘密鍵、delegate key、Docker socket、SSH／broker／deploy権限、Bot管理APIを付与しない。公開検証鍵だけ利用可 |
| CPU/RAM | ハード上限とtimeoutを必須にする。上限値はBot peak＋OS予備と実測学習peakから決め、未計測時は同居しない。並列jobは1、スレッド数も固定 |
| ディスク | snapshot・dataset・artifact・ログに総quota、ファイル数・最大サイズ・保持世代を設定。volumeだけで容量制限できたと見なさず、専用領域quota又はhost側制限を検証。空き予約を侵食したら学習だけ停止 |
| 稼働中停止条件 | 安全エピソード／Botエラー／tick遅延悪化／RAM・ディスク予約割れ／I/O競合で学習を中断。外部監視からread-onlyの健全性信号を受ける。信号不明でも開始しない。Botの停止・復旧を学習から操作しない |
| OOM | worker cgroup内で終了、Botと共有プロセスにしない。host全体OOMを防ぐ余白も必要。部分artifactはtemp扱いで非公開、検証完了後だけatomic rename |
| 再試行 | 入力hash単位の冪等job。一時的I/Oのみ回数・総時間上限付きbackoff。OOM／schema不正／hash不一致は自動再試行せず隔離、次回も同じ失敗を無限反復しない |
| 成果物 | 非実行の厳格JSON数値パラメータを初期形式にする。pickle／任意JS／プラグイン読み込み禁止。family/schema/shape/有限値/範囲/サイズ/パスを検証しhash照合。hashだけを署名と呼ばない |
| 署名・承認 | 学習Workerはhashを生成するのみ。隔離した承認経路がreport検証後に署名。秘密鍵をWorkerへ配らない。loaderは許可した公開鍵の署名、承認対象hash、pair、feature版、期限／失効状態を確認。未署名・改竄・未知familyは拒否 |
| Actions | 将来、sanitized snapshotによる定期監査・採点・再学習は可能。contents:read、secretなし、timeout/concurrency/artifact保持上限。デプロイworkflow／self-hosted本番runnerと共有しない。private生DBを公開artifactにしない |

現在の `.github/workflows/suiba-offline.yml` はMarkdown変更をpathで除外するため、
本PRで通常のoffline CIが自動起動するとは限らない。Worker CIには別の明示承認条件がある。
本PRからworkflow_dispatchや配備を実行しない。

劣化時は候補Shadow／学習を停止し、現行を維持。適用後は事前承認済み旧artifactへ
原子的にpointerを戻し、設定・保有・注文・会計を巻き戻さない。起動時の検証失敗は
最後の承認済み版を使い、売買モデルの旧版も無ければモデル経由の新規BUYを拒否する。
出口・リスク／安全停止は従来経路で維持する。rollbackは承認時に範囲を事前登録し、
自動rollbackを許可しない場合はowner操作待ちの新規BUY停止とする。
モデルは助言出力のみで、risk設定／purpose／停止解除／数量を操作できない。

## 9. Phase 1〜5 導入計画

全Phaseに共通してPAPER限定、デプロイは別承認、依存追加は必要性とNode24検証を
別PRで判断する。学習不足時のSKIPPEDは正しい終了であり次Phaseへの自動通過ではない。

### Phase 1：予測・結果・特徴量保存と自動採点

- 目的：画面を閉じても、入力時点と版を固定した予測・確定結果を欠測付きで採点する。
- 再利用：forecastWith／record／verdict、指標、recordAnalysis、足品質、ml-data-audit、backup。
- 新規：純粋予測部の共有、観測availableAt、snapshot/prediction ID、headless記録、確定label状態機械、定期採点と品質report。
- 流れ：既存取得の観測記録→凍結入力→予測追記→確定足→別Evaluator→outcome/report。新たな市場ポーリングや注文経路は増やさない。
- DB：将来追加が必要。Bot側は時点入力／予測の最小記録、研究側はoutcome。既存判断／会計表を再利用。
- 依存：既存TypeScript/SQLite/zodで設計、新規外部サービスなし。
- 資源：推論CPU小、ただし同期DB書込み・履歴ディスク増加が主な懸念。1件サイズ×ペア別発生数×保持期間、snapshot重複率を実測しquotaを決める。採点はVPS外。
- Actions：将来のsanitized snapshot日次採点に利用可。収集は既存取得元のローカルで必要。
- 検証：現行予測との同値、秒/ms、未確定足、late/repair、重複・再起動、pair分離、保存満杯、既存tick遅延と安全系不変。
- 完了：ブラウザ非依存で収集でき、同じsnapshotから同じ予測／採点を再現。欠測／版／時点を追跡し、予測と売買reportを分離。データ量監査が完了。
- 停止復旧：追加collector/Evaluatorのみ無効化、gap記録。cursorから冪等再開、当時入力の架空補完なし。
- PR：P1a共有化・同値検証、P1b時点／版記録、P1c確定採点・品質監査。

### Phase 2：候補予測モデルのオフライン自動再学習

- 目的：固定データで予測パラメータ／誤差分位形状を再推定する。自動適用しない。
- 再利用：forecastWith、既存定数、Phase 1結果、ml-data-audit、hash。
- 新規：dataset manifest、purged walk-forward、限定探索、候補registryと再現report、不足SKIP。
- 流れ：read-only snapshot→品質gate→固定split→train/validate→一度だけtest→候補artifact/report。
- DB：Bot変更不要、研究DBにdataset/training/model/evaluationを追加。
- 依存：まず既存TSの数値計算。別MLライブラリは必要性確定まで追加しない。
- 資源：探索数×期間でCPU増、snapshot複製とartifact保持でディスク増。VPS外を推奨、peak RSS/時間を記録。
- Actions：定期job可能、データ更新なし・不足なら理由付きSKIP、権限read-only。
- 検証：時系列分割／重複ラベル排除、seed/hash再現、未知schema拒否、現行／last-close同条件。
- 完了：再実行可能な候補と不採用結果を保存、pair別評価、採用基準の事前登録案が実データに基づく。
- 停止復旧：job中断、部分artifact隔離、元datasetで手動再開。現行版は不変。
- PR：P2a dataset/split、P2b再推定・registry、P2c定期実行・report（Actions変更はここで別審査）。

### Phase 3：PAPER売買判断モデルのオフライン比較

- 目的：既存BUY候補の選別効果を全資産経路で測る。SELLや安全gateを学習しない。
- 再利用：StrategyEvidence、候補／約定リンク、PaperTrading、Guard/Risk、compareBacktests、既存ML設計。
- 新規：opportunity grouping、反実仮想label、単純教師あり候補、同条件経路比較と打切り処理。
- 流れ：固定snapshot→候補群→固定出口ラベル→train/validate→未使用testでモデル有無の経路再生→report。
- DB：研究DBにlabelSpec／decision_link／policy評価追加、Bot会計schema変更不要を目標。
- 依存：ライブラリ選定はデータgate後。初期候補はロジスティック回帰、Python環境導入も別承認PRの必要性判断から。
- 資源：経路replayと試行でCPU増、run別label/report保持。VPS外、データ行数・試行上限を設ける。
- Actions：sanitizedデータで定期評価可能、公開成果物は集計のみ。
- 検証：cost二重控除防止、同足TP/SL不明、未決済、WAIT誤負例化防止、資金経路差、risk/guard拒否不変。
- 完了：既存の試行開始データ基準を監査で確認し、複数期間・pair別PnL/DD/件数/不確実性を提出。不足ならSKIP。
- 停止復旧：研究jobのみ停止、旧reportを保持。Botへ候補をロードしない。
- PR：P3a labelと結合、P3bモデル／比較、P3c感応度・採用gate。保留ブランチは再開しない。

### Phase 4：現行／候補のShadow並行評価

- 目的：未来に到着する入力で候補の劣化・遅延・比較差を観測する。注文なし。
- 再利用：AI Shadow設計の凍結入力・上限・kill switch・report、Phase 1 snapshot、Phase 2/3 artifact。
- 新規：別プロセスでモデル別推論、複数候補ID、仮想portfolioの独立状態、Shadow drift report。
- 流れ：同一snapshot→現行／候補→prediction又はshadow_decisions→確定outcome／仮想経路→比較。
- DB：研究側Shadow表が必要。Botの同一トランザクションへShadow書込みを混ぜない。
- 依存：初期はローカル数値モデル、LLM API不要。既存LLM案の実装は別判断。
- 資源：候補数×推論、snapshot転送／保持、候補別仮想状態。候補上限とキュー容量を計測。VPS同居は余白検証後のみ。
- Actions：結果の集計には可、常時低遅延Shadowの常駐実行には不向き。独立Workerを使用。
- 検証：入力hash一致、非発火／失敗分母、単一飛行、停止中／回復中はskip、遅延・OOM・disk fullがBotへ伝播しない。
- 完了：事前登録期間／有効件数、pair別の安定性、遅延／失敗と劣化条件、注文への参照0を満たす。
- 停止復旧：Shadow kill switch、未完了を理由付き記録。再開後も過去推論を当時の応答と偽らない。
- PR：P4a既存Shadow契約統合、P4b隔離Worker、P4c並行評価と停止試験。

### Phase 5：承認付き更新・ロールバック

- 目的：検証済み候補をオーナー承認後だけ、指定pair／用途へ適用できるようにする。
- 再利用：hash検証・既存安全／会計／認証方針。学習からデプロイブローカーを呼ばない。
- 新規：署名・承認台帳、厳格loader、atomic pointer切替、last-known-good、劣化監視とrollback演習。
- 流れ：評価＋Shadow report→ownerがhashを承認→別適用経路が検証→版選択→監視→旧版復帰。
- DB：研究registry承認／適用履歴、Botは選択modelId/hashの版付き記録が必要。保有／取引履歴のmigrationは不要。
- 依存：既存crypto機能で設計し、鍵保管／署名方式は別途具体化。秘密鍵は学習Workerへ渡さない。
- 資源：旧新artifact保持、ロード時の一時RAM、検証CPU。最大artifactサイズと旧版保持をquota内に収める。
- Actions：評価・検証まで可。定期jobから適用／デプロイ不可。owner承認経路は分離。
- 検証：改竄／未知model／schema／pair／署名／失効拒否、承認対象差替え拒否、切替途中crash、旧版復帰、risk/guard無効化不能。
- 完了：承認なしの適用0、証拠から選択版へ追跡可能、PAPERでrollback演習成功、既存安全回帰が成功。
- 停止復旧：検証失敗は現行維持、適用後劣化は事前承認した旧版復帰又は新規BUY停止。安全停止解除・会計巻戻しを伴わない。
- PR：P5a registry/署名、P5b承認loader、P5c切替／rollback、P5d PAPERのみの適用境界検証。

## 10. 検証項目と今回追加しないもの

実装PRでの必須検証群：

| 群 | 確認すること |
|---|---|
| データ契約 | 秒/ms、pair/provider、availableAt、未確定・改訂足、欠測、結合欠落、origin重複、snapshot hash |
| 評価妥当性 | label期間purge、train-only変換、未使用test、期間／pair分離、重複予測の有効標本数、再現性 |
| 会計 | 部分SELL原価配賦、費用不明、二重控除、spread/DEX内包費用、未約定、資金拘束、net PnL/DD |
| 障害分離 | CPU飽和、OOM、disk full、timeout、破損snapshot、read-only違反、無限retry防止、Bot安全系不変 |
| 採用制御 | 承認なし・hash差替え・不正署名・異pair拒否、原子的切替、旧版復帰、モデルから設定／purpose変更不可 |

今回は実装、学習、サービス／依存追加、MemWal連携、LLM接続、リアルタイム板履歴
サービス、強化学習、自動売買適用、SELL／数量／リスク上限最適化を追加しない。
理由はPhase 0境界、既存機能との重複、データ不足の未解消、権限分離と既決事項の維持。
既存表示の学習文言やlocalStorageを変更せず、過去コメント値を新モデルの性能証拠にしない。

## 11. 未確定事項と必要な追加証拠

| 未確定 | 判断に必要な証拠／次の判断 |
|---|---|
| 現在のデータ量 | 終了済みrunの整合DBコピー＋manifestを既存経路で取得し、ml-data-auditをpair別実行。BUY／独立候補／往復／局面／欠落を確認 |
| 予測の学習開始・採用閾値 | Phase 1の独立origin数と期間別誤差分布・信頼区間。許容改善／DD幅と必要期間を事前登録 |
| WAL予測への一般化 | SUI由来の経験コーンをWALの未使用期間で評価。WAL固有候補が必要か判断 |
| 時点／確定・遅延許容 | provider別firstAvailable/修復/確定証拠の観測、入力freeze地点とquality契約の測定 |
| VPS同居可否 | CPU数、RAM、disk quota/余白、Bot peak RSS・tick p95/p99・I/O/WAL増加と学習peak。値が無い間はVPS外 |
| snapshot運用 | 既存停止／maintenance要件に従う取得頻度、自然停止後の提供契約。常時自動取得は別設計 |
| Shadow契約統合 | 既存LLM単一cycle案と複数学習候補のID、トリガー母集団、別プロセス化、出口非対象を一つの契約にする |
| 鍵と承認 | owner署名経路、公開鍵配布／失効、承認有効期間、自動rollback事前許可の有無。学習側に秘密を置かない |
| 保持・公開 | dataset／snapshot／artifactのquota・保持期間・削除時の派生物失効。公開exportの許可項目を別レビュー |
| CI・運用状態 | Markdown除外のため本PRのCI状態とローカル検証を区別。既存本番安定化が完了するまでShadow実装を始めない |

本書は採用やデプロイの承認ではない。オーナーのマージ判断と、将来のモデル適用判断を分離する。

## 12. Phase 0の検証記録

- Node v24.22.1。最新mainの独立worktreeで既存node_modulesを再利用し、依存追加なし。
- `node scripts/run-project.mjs typecheck`：成功。
- `node scripts/run-project.mjs lint`：成功（エラー0、既存警告16）。
- `node scripts/run-project.mjs build`：成功（既存chunkサイズ警告）。画面変更なしのため描画スモーク対象外。
- `node scripts/run-project.mjs test`：Node test 45件成功、Vitest 1,599件成功・12件skip（135ファイル成功・2ファイルskip）。計1,644件成功・12件skip。
- sandbox内ではlocalhost接続EACCESによりVitest 40件失敗。PAPERローカル回帰を制限外で再実行し上記全件成功を確認した。コード修正はしていない。
- コード根拠の明示パス16件の存在確認成功、ステージ差分の空白検査成功、変更対象は本Markdown 1件のみ。
- mainへのコミット／マージ、VPS操作、実資金取引なし。CIのMarkdown除外とローカル成功は区別する。

自己判定：Phase 0文書としてマージ候補。実装・モデル採用・配置の承認を含まず、最終マージはオーナー判断。
