# 注文履歴の再構成（2026-11-13）

基点は #232 マージ後の main `8ad52c8`。未マージ #224 のうち、注文履歴の圧縮と保存済み日時の表示経路だけを再適用した。

- チャート詳細13pxは #232 の section に付いた chart-meta で実装済み。IndicatorPanel、予測領域を除外する dataEnd の欠損判定、チャート CSS は変更していない。#224 の指標値単位の折り返し・余白調整も今回には含めない。
- 注文履歴は狭い画面でも表形式を維持し、表内を横スクロール。初約定の補足、技術情報の開閉、全 JSON を維持。金額・価格の補足は fixed4。
- 表示専用 orderHistory() から SQL timestamp（epoch ミリ秒）を返し、records と従来 snapshot の両経路につなぐ。汎用 history()、保存データ、売買ロジックは変更していない。
- 実運用の「未取得」2件は今回も照合していない。インメモリ DB から API・DashboardClient・OrderHistory までの再現テストで検証。

## 検証

Node 24.22.1 / pnpm 9.12.3。
ネットワークの名前解決が失敗して依存の新規取得はできなかったため、元チェックアウトの node_modules を参照（lockfile の変更なし）。

- pnpm run typecheck: 成功。
- pnpm run lint: 終了コード0（既存の警告）。
- pnpm exec vitest run: 通常ローカル権限で137ファイル成功 / 2 skip、1613件成功 / 12 skip。
- sandbox 内の全テストは通信を使う40件が失敗。通常権限では全成功。
- pnpm run build: 成功。
- node scripts/render-smoke.mjs: 通常ローカル権限で成功。
- 合成データの OrderHistory とビルド済み実 CSS を Chromium で描画。375px・812×375px・1280px、reduced-motion で13px・table/table-row・ページ横あふれなし・技術情報の開閉を確認。375pxのスクリーンショットを目視確認。実運用データの確認ではない。

本番の起動・停止・配置・DB更新は実施していない。
