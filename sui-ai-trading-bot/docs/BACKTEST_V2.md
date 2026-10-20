# Profit Guard対応バックテスト2.0

調査・実装ベース：`main` の `5636b18`。P0の「全SELLを安全性検証し、成功した保護的SELLだけ利益閾値を免除する」仕様を共用します。LIVE・署名・秘密鍵・実ウォレット・実送信は追加しません。

## 構成と既存実装との差分

| ファイル | 役割 |
| --- | --- |
| `packages/backtest-engine/package.json` / `src/index.ts` | 比較設定、履歴検証、仮想見積もり、独立したON/OFF計算、指標・履歴・入力スナップショット |
| `apps/worker/src/backtest.ts` | SQLite / JSON入力、比較CLI、JSONレポート出力 |
| `apps/worker/src/backtest-sample.ts` | 固定シードの合成OHLCVサンプル |
| `apps/worker/src/backtest-service.ts` | 保存履歴の読込、比較レポートだけの永続化 |
| `apps/worker/src/index.ts` | 既存のBearer認証の内側にGET/POST `/api/backtest` を追加 |
| `packages/database/src/index.ts` | 追加専用の `backtest_runs` テーブルを作成。既存データの書き換えなし |
| `apps/dashboard/src/BacktestComparison.tsx` / `main.tsx` | 設定、指標比較、資産/DDグラフ、売買/WAITポイント、履歴・理由・費用 |
| `tests/backtest-engine.test.ts` | 比較エンジンと保存サービスの回帰テスト |
| `package.json` / `pnpm-lock.yaml` / `README.md` | サンプルコマンド、workspace登録、利用案内 |

指標 `calculate`、`RuleBasedStrategy`、`evaluateBuy/evaluateSell`、`assessRisk`、`PaperTrading.fill`、`equity/metrics` を再利用します。これらの既存実装と通常の `BotEngine.tick` は変更しません。旧 `packages/paper-trading/src/backtest.ts` は既存の検証用に残します。現在の `pnpm backtest` は2.0を使用するため、旧CLIと指標項目・費用モデルは異なります。

## 実行方法

ダッシュボードの「バックテスト比較」を選択し、期間と費用を入力して比較します。学習最終足、検証開始足、検証最終足はUTCです。フォーム変更後は再実行が必要です。画面には最新の保存済みレポートも復元します。

```powershell
# SQLiteの最新ソース、保存済み5分足（最大1000本）
pnpm backtest
# 固定シード20261020の合成データ。外部通信・実相場の取得はなし
pnpm backtest:sample
# JSONのCandle配列、または保存した2.0レポートから再実行
pnpm backtest data/backtests/sample-v2.json
# 入力履歴 + 個別の比較設定JSON
pnpm backtest path/to/candles.json path/to/options.json
```

レポートは `data/backtests/*.json`。ブラウザ/APIの結果は `backtest_runs` へ追記します。入力履歴・期間・設定・モデル版・全判断・見積もり・約定・資産推移を含みます。比較が通常PAPERの残高・設定・停止状態・注文/約定履歴を変更することはありません。サンプルを実運用DBの市場履歴へ挿入しません。

GET `/api/backtest` は本数・範囲・最新レポート、POSTは次の設定を受け取ります。認証必須、同時実行1件、入力ボディ16KBまで。長い計算中も一定間隔でイベントループを解放します。

```json
{
  "start": 1790872800,
  "end": 1790992500,
  "trainEnd": 1790872500,
  "initialUsdc": 100,
  "maxOrder": 5,
  "slippage": 0.003,
  "spread": 0.001,
  "impact": 0.001,
  "dexFeeRate": 0.003,
  "additionalFeeRate": 0,
  "gasUsdc": 0.03,
  "participation": 0.001,
  "minNetProfitUsdc": 0.05,
  "minNetProfitPct": 0.01
}
```

設定の率はfractionです。最大注文5 USDC、slippage/impact各0.3%、ガス上限1 USDCなどの制約をスキーマで検証します。日次買付20 USDC・日次損失1%・保有20%のRiskEngine制限も維持します。`gasUsdc:null` は不明費用の試験用で、ON/OFFとも取引を拒否します。

## 時系列・比較の公平性

- 各検証足の始値で、その直前の足までの確定OHLCVだけを指標・戦略へ渡します。前足の確定後の判断を次足始値で執行するモデルであり、シグナル足終値での約定はありません。
- 現在足の始値は取引候補生成後の見積もりにだけ使います。現在足の高値/安値/出来高は約定条件に使いません。現在足終値は約定後の資産評価にだけ使用します。
- 最低61本のウォームアップと2本の検証足が必要です。入力全体を検証し、重複/欠損/不正OHLC/異常値/混在ソースを拒否。欠損補間・並べ替えによる黙示修復はしません。JSON入力は最大5000本です。
- `trainEnd < start < end`。調整期間で売買せず、過去足は指標のウォームアップに使用します。自動最適化は実装しません。検証期間を見て調整した場合は、新しい未使用期間が必要です。
- OFF/ONそれぞれ新しい戦略インスタンス・ポートフォリオ・注文集合を作ります。変わるのは利益閾値の適用だけです。OFFも同じProfitGuardの安全性検証とRiskEngineを通ります。モデル自体は乱数を使いません。
- 注文IDは足時刻と方向から固定し、1足1候補だけ処理。重複足自体も入力検証で拒否します。
- 期末は保有分を終値評価し、強制売却はしません。未実現損益には未実施の将来の売却費用は含めません。

## 仮想DEXと費用

売買の公正出力に対し `(1-spread) × (1-impact) × (1-dexFeeRate)` を掛け、atomic単位へ切り下げます。spreadは片道の出力控除率で、半スプレッドという意味ではありません。さらにslippageを控除した最低受取数量でPAPER約定します。

DEX手数料は出力数量へ内包済みです。USDC換算の内訳を参考保存しますが、原価/純利益へ再加算しません。追加費用は `additionalFeeRate` と `gasUsdc` のみです。PAPER会計へも同じ値を渡します。バックテスト初期値は内包DEX 0.3%、追加0%です。通常Workerの追加0.3%を変更するものではありません。

直前確定足の `volume × participation` をUSDC相当の流動性上限プロキシとします。入力volumeはUSDC相当へ正規化済みであることが前提です。実プールの板厚・ルート容量ではありません。実データの出来高単位やUSDCペッグのずれは別途検証が必要です。ガスはUSDC相当の固定課金で、SUIガスコインを消費しません。

ProfitGuardのBUY試算は現在の逆方向見積もりを価格比で拡大する既存モデルを共用します。戦略の実際の利確価格より遅い想定価格を使わず、分割売却分のガスも考慮します。将来の見積もり/流動性/利益を保証しません。

## 指標の定義

- 純損益 = 最終時価資産 − 初期資産。購入費用を原価に含め、部分SELLは平均原価を保守的に按分。残余は最終売却へ配賦。
- 勝率・平均利益/損失・Profit Factor・連敗は **部分SELL約定ごと** の実現純損益から計算します。ポジション全体の往復回数とは異なり、約定数量で重み付けしません。
- ゼロ純損益も勝率の分母へ含め、連敗はリセット。損失ゼロのPFはnull、該当しない平均値はnull。約定ゼロでも資産、DD、勝率、費用を正しく返します。
- 総手数料 = USDC換算の内包DEX手数料 + 追加手数料。総ガスは別欄です。内包DEX分を純損益から再控除しないでください。スプレッド・impact・slippageも数量へ反映済みです。
- 最大DD・DD推移は初期資産をピーク候補に含めた確定足終値の時価資産から計算。足中の最悪ドローダウンではありません。
- 利益不足WAITはProfitGuardの閾値/BUY往復コスト不足のみ。安全性拒否は見積もり・費用・原価・RiskEngine・モデルエラー等。通常の戦略WAITとは区別します。

## 再現可能なサンプル

`pnpm backtest:sample`：合成600本、調整200本、検証400本。初期100 USDC、既存RuleBasedStrategyのデフォルト、上記の費用設定を使用。実相場データではありません。

| 指標 | OFF | ON |
| --- | ---: | ---: |
| 最終資産 USDC | 99.962007 | 100 |
| 純損益 USDC | -0.037993 | 0 |
| 最大DD % | 0.254913 | 0 |
| 約定 / BUY / SELL | 5 / 2 / 3 | 0 / 0 / 0 |
| 勝率 % | 33.333333 | 0 |
| Profit Factor | 0.809494 | null |
| 総手数料 USDC | 0.060463 | 0 |
| 総ガス USDC | 0.15 | 0 |
| 利益不足WAIT | 0 | 2 |

ONでは想定利益不足のBUYが2回抑制されました。この例は動作検証で、ONが一般に優れている証拠ではありません。取引ゼロは収益戦略の有効性を示しません。

## 限界・実売買前の残課題

OHLCVの始値は任意数量の実行可能価格ではありません。固定spread/impact、直前出来高プロキシ、価格比のBUY試算では、MEV・ルート/板厚変化・遅延・約定失敗・ガス急変・USDC乖離を再現できません。手数料や流動性設定を変えた感度分析、長期の未使用期間、ウォークフォワード検証、実時点の見積もり履歴収集が必要です。

LIVE前には独立した承認・PTB検証・必須TransactionSimulation・実残高/原価/ガス照合・二重送信防止・送信不明時停止を実装・検証する必要があります。比較結果でLIVEを有効化する機能はありません。
