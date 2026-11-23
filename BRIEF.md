# BRIEF: 強制決済（とどめの一撃／戦線離脱）— PAPER only

## 目的
オーナーがダッシュボードから「今すぐ保有分を全部売る」を実行できるようにする。ルールの売り条件と ProfitGuard の最低利益ゲートを待たずに売るが、手数料・ガスは通常どおり計算して記録する。対象は PAPER のみ。REAL では API が拒否し、画面にも出さない。

承認済みサンプル（見た目と文言の正）: `~/workspace/your_files/force-close-sample-v2-20261123.png` と触れる版の挙動（確認2タップ→実行→演出）。ただし実装はこのリポジトリの既存パターンに合わせること。

## 設計（確定事項）
1. **新しい sellPurpose "MANUAL"**
   - `packages/shared/src/index.ts` の sellPurpose ユニオンに追加。
   - `packages/profit-guard/src/index.ts`: Purpose 型に追加し、既存の bypass リスト（STOP_LOSS 等、evaluateSell 内）にも追加する。これで最低利益ゲートを素通りしつつ、コスト計算とレポートは通常どおり残る。
   - 閉じた許可リスト全てに登録すること（下の横断チェック参照）。
2. **トリガーと実行**
   - `POST /api/control` に新コマンド `force-close` を追加（apps/worker/src/http-routes.ts の既存コマンド分岐の流儀で）。
   - ハンドラ内では売らない。db に保留リクエストを記録する（例: キー `forceClose` に `{ requestedAt }`）。検証: 保有ゼロなら 409 `FORCE_CLOSE_NO_POSITION`、REAL モードなら 409 `FORCE_CLOSE_PAPER_ONLY`（モード判定は既存の execution mode の判別方法を使うこと — paper-only テストが使う仕組みを参照）、runtime が emergency/error なら 409。
   - エンジン（apps/worker/src/engine.ts）は tick の意思決定ポイントで保留リクエストを消費する: 保有 > 0 かつリクエストが新鮮（10分以内）なら、その tick の decision を `{ action: "SELL", sellPurpose: "MANUAL" }` に置き換え、通常の実行経路（quote・コスト・監査・約定記録）にそのまま流す。1 tick の売却量は通常の SELL と同じ上限（maxOrder 換算）でよい（分割決済）。リクエストはポジションがゼロになったら自動で消す。10分を超えたら失効して消す。emergency が立ったら消す。
   - 安全ゲート（gateStopsCycle）が止める tick では消費しない（リクエストは残るが実行されない）。
3. **画面（概要タブの資産カード内）**
   - 新コンポーネント（例: apps/dashboard/src/ForceClose.tsx）。表示条件: PAPER かつ保有 > 0 かつ runtime.running かつ emergency/error なし。資産カード（OverviewTab.tsx の aria-label="資産" のカード）の保有表示の下に置く。
   - 中身はサンプルどおり: 主人公アイコン（party-hero.webp 流用可）、含み損益ゲージ（中心=取得価格、左端/右端は損切りライン stopLossPct・利確ライン takeProfitPct を目盛りにし、ドメインは両ラインを含む範囲＋余白）、主人公の一言（ライン越え状態で出し分け: 利確ライン以上／損切りライン以下／その間は一言なし or 中立な一言）、コマンド窓。
   - コマンド名: 含み益（手数料後見込みが +）なら「とどめの一撃」、含み損なら「戦線離脱」。横に「強制利確／強制損切」と手数料後の見込み額を併記する。見込み額はスナップショットから得られる最新の売り評価（recordProfit の最新レポート等、既存の ProfitGuard 表示が使うデータ）から作る。得られない場合は税引前額＋「見込み」と明記し、捏造しない。
   - 操作: 1タップで確認表示、2タップ目で `POST /api/control {command:"force-close"}`。送信後は「強制決済中」の表示（保留リクエストがスナップショットで見えるならそれを使う。見えない場合は送信直後のローカル状態＋ポジション減少で判定）。ポジションがゼロになったら結果演出（斬撃フラッシュ＋実現損益の大きなポップ＋結果バナー）を1回だけ出す。実現損益は直近の MANUAL 約定から取る。
   - CSS は既存ファイルの流儀で（色は base.css の変数のみ、素の button セレクタ禁止、44px 最低高さに注意）。
4. **売買ルールへの影響**: 戦略の通常判断・通常の利確/損切りには一切触れない。MANUAL は保留リクエストがある時だけ発火する。

## 横断チェック（必須）
- `TAKE_PROFIT` / `sellPurpose` / `Purpose` をリポジトリ全体（docker/run-review.py 等の Python も含む）で grep し、閉じた許可リスト・集計バケット・型ユニオンの全てに "MANUAL" を登録する。登録漏れがあるとレビュー集計や運用レポートで落ちる/消える。
- 実況（narration）の種類追加はしない。強制決済の約定は通常の SELL 約定として既存の実況に乗ればよい（新しい kind が必要になったら止まって報告）。

## 読む範囲（これ以外は読まない）
- apps/worker/src/engine.ts（tick の phases と decision の出所、sellPreview/recordProfit 周辺）
- apps/worker/src/http-routes.ts の /api/control 分岐
- packages/profit-guard/src/index.ts（Purpose と bypass）
- packages/shared/src/index.ts（sellPurpose ユニオン、Settings、スナップショットの型）
- apps/worker/src/operations-report.ts（purpose の扱い）
- apps/dashboard/src/OverviewTab.tsx（資産カード）、ProfitGuard 表示が最新評価を読む方法
- 既存テスト: tests/ の engine/control/profit-guard 関連で最も近いもの

## 検証（PR 前に必須・対象スイートのみ）
- 新規/更新テスト: ①エンジン: 保留リクエスト＋保有あり→次の tick で MANUAL 売りが ProfitGuard の最低利益未達でも実行される ②分割上限（maxOrder）を守る ③ポジションゼロでリクエストが消える ④保有ゼロ/REAL/emergency では API が 409 ⑤画面: 表示条件と確認フロー（control 呼び出し）
- 実行するのは触った領域のスイートのみ（フル vitest は CI に任せる）。typecheck と lint は通すこと。
- render-smoke が通ること（UI 変更のため）。

## 停止条件
- MANUAL を登録すべき閉じたリストが判断つかない場所にあったら、勝手に決めず止まって報告する。
- tick の意思決定ポイントで安全に割り込める場所が無い（並行実行の競合が避けられない）場合は、別の消費方法を実装せず止まって報告する。
- 実況に新 kind が必要になったら止まって報告する。

## PR
- タイトル: 「強制決済（とどめの一撃／戦線離脱）を追加（PAPER）」
- 本文は専門用語なしの平易な日本語で、結論を1行で先に書く。何が変わるか・安全側の決め事（PAPERのみ、停止中は実行されない、10分で失効）・テスト結果を書く。
- tokens used の累計は本文に書かない（ランログ側で管理）。
