# AGENTS.md — SuiBa 改修ガイド（AI エージェント向け）

このリポジトリで作業するエージェント（Codex 等）向けの実務ガイド。
人向けの概要は `README.md`、個別仕様は `docs/` を参照。ここには
「壊しやすい場所」と「守ると安全な手順」だけを集めてある。

## プロジェクトの前提

- SuiBa は SUI/USDC・WAL/USDC を対象にした **PAPER 専用**のルールベース
  自動売買 Bot＋React ダッシュボード。実売買は入れない（実売買は
  TradeCap 委任の設計書 `docs/REAL_TRADING_TRADECAP_DESIGN_20261025.md`
  のみで未実装）。
- **取引ロジック・安全停止条件・DeepBook/Sui 通信経路の変更は、オーナー
  （たじゅまる）が明示的に選んだ場合だけ**。それ以外の改修で挙動を
  変えない。
- UI の文言は日本語。`prefers-reduced-motion` 対応を維持する。
  模式・装飾の表示は、模式であることを注記で正直に示す。

## リポジトリ地図

- `apps/dashboard/` — React 画面（Vite）。入口は `src/main.tsx`、
  指標チャートは `src/IndicatorChart.tsx`、価格チャートは
  `src/PriceChart.tsx`、実況は `src/agentNarration.ts`＋`src/narration/`。
- `apps/worker/` — Bot 本体。監視は `src/operations.ts`（安全・サイクル）、
  集計・レポート・判断テレメトリは `src/operations-report.ts`。
- `packages/` — shared（型・設定・回復ロジック）、market-data、
  paper-trading、profit-guard、database、portfolio、indicators。
  チャート監査データは `shared/src/chart-gap-audit.ts`、検証済み修復
  データは `shared/src/chart-gap-repairs.ts`。
- `tests/` — Vitest 一式（リポジトリ直下）。CSS の構造テストもここ。
- `deploy/broker/` — さくら VPS 配置ブローカー（特権コード）。
  承認一本化の設計は `deploy/broker/approval-ci.md`。
- `docker/` — VPS 向けイメージ、SSH 読み取りチェック等。
- `.github/workflows/` — `suiba-offline.yml` が検証の正。

## 実行環境と検証コマンド

- Node は **>=24.22.1 <25**（engines と Dockerfile で固定）。
- pnpm ワークスペース（コマンドは `sui-ai-trading-bot/` で実行）:
  - `pnpm run typecheck` / `pnpm run lint`（**終了コードで判定**。
    lint の警告14件は既知の exhaustive-deps で意図的に残置）
  - `pnpm exec vitest run`（全テスト。基線は約1,440件）
  - `pnpm run build` のあと `node scripts/render-smoke.mjs`
    （dist を配信して computed style を検証する描画スモーク）
- CI の `SuiBa offline validation` 成功がマージ可否の正。
  setup-node 組み込みの pnpm キャッシュはこのリポジトリでは使えない
  （ワークフロー内の手組みキャッシュを壊さない）。

## CSS の規約（事故が多い場所）

- スタイルは `apps/dashboard/src/styles/` の11ファイルに分割され、
  `style.css` の `@import` **順序そのものがカスケード**。順序を変えない。
- リベース競合で共有の閉じ括弧 `}` が消えると後続ルールが全部死ぬ
  （テスト・ビルドは緑のまま）。`tests/css-balance.test.ts` が防御。
- 繰り返し使う色は `base.css` の `:root` 変数（`--mint` 等）だけ。
  hex の直書きは `tests/css-palette.test.ts` が禁止している。
- 全体 `button` スタイルは特異度事故（ホバーでアバターが消えた）を
  防ぐため `terminal.css` で `:where(button)` にしてある。素の
  `button` セレクタに戻さない。

## 実況（narration）を触るとき

- 新しい kind を足すときは、表示側だけでなく
  `src/narrationStorage.ts` の zod enum と、`NarrationState` の
  新フィールドへの `.default()` を必ずセットで入れる（欠けると
  保存済みフィードの読み込みが落ちる）。
- キャラの関西弁は、感情が漏れる専用エントリ（ニアミス・的中ドヤ等）
  だけ。通常の実況・会話は標準語。

## データと通信の約束事

- **足（Candle）の timestamp は epoch 秒、timeframe は秒（300）**。
  Fill の timestamp は epoch ミリ秒。混同が最も多いバグ源。
- `chartData()` は不正な足が1本でもあると全足を落とす（検証を緩めない）。
- 表示用のポーリングに `ReadOnlySuiClient` を使わない。
- `apiAccess`（`packages/shared/src/api.ts`）は全体単例でサーキット
  ブレーカ状態を持つ。テストで Sui gRPC 失敗を再現するときは、
  sui-observations 系テストの後片付けパターンを真似ること。
- Sui gRPC は主系→予備のスティッキー切替あり
  （`SUI_GRPC_FALLBACK_URLS` で差し替え可能）。

## デプロイ経路

- PAPER 本運用はオーナーの Windows PC（ダッシュボード 3101、
  スマホ向け HTTPS 8443）。main への push だけでは実機に反映されない。
- さくら VPS は GitHub Actions＋ブローカー経由で、配置は
  **prepared_stopped（起動しない）** で止まるのが正しい状態。
  ブローカーは特権コードなので自己更新経路を持たない。

## 変更の進め方

- 変更はブランチで作業し、typecheck・lint・全テスト・ビルド
  （画面変更時は描画スモークも）を通してから報告する。
- 既存の表示・挙動の確定事項（アイコンのみの運用ボタン、スクロールに
  追随するアバター、説明文の最小化など）を、頼まれた範囲を超えて
  崩さない。必要なら別案として提案する。
- 大きなファイルの分割は「純粋なコード移動＋元の名前で再 export」
  を原則とし、移動ブロックが元と一致することを機械比較で確認する。
