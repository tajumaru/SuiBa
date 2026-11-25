# Brief: SUI / BTC マーク切替（概要トップの表示切替）

## 結論（やること）
概要画面トップの PriceTicker ブロックに Sui マークと BTC マークの切替ボタンを付け、BTC 側では BTC の値動き＋影の概要だけを表示する。SUI 側は今まで通りの表示（切替行が増える以外は無変更）。あわせて PR #513 で戦略タブのパーティ欄に入れた「BTCの影」ブロックを取り除く（表示の置き場がここへ移るため）。

## 背景と確定事項（オーナー決定済み・変更不可）
- 切替はマーク（Sui の雫マーク／BTC の ₿ マーク）を押す形。状態は画面内だけ（永続化しない、既定は SUI）。
- BTC 側に出すのは次の要素だけ：現在値、24時間の変化率、24時間の値動きの線（1時間ごとの終値25点）、高値・安値、影の概要文、MemWal 経由である旨とエピソード時刻。
- BTC 側に売られすぎメーター（RsiGauge）は出さない。買いライン等も出さない。要素は銘柄ごとに取捨選択する設計。
- SUI 側は従来表示そのまま（RsiGauge 含む）。切替行の追加以外、SUI 側の見た目と挙動を変えない。
- 売買・設定・worker のデータ取得（MemWal recall→DB→snapshot の #513 の配管）は一切変えない。変えるのは dashboard の表示だけ。

## データ契約（読み取り専用・既存）
- snapshot の `btcShadowSummary: { text: string, fetchedAt: number } | null`（`apps/worker/src/memwal.ts` の `BtcShadowSummary` 型、`apps/worker/src/engine-snapshot.ts` で snapshot に載る）。dashboard では `data.btcShadowSummary` として既に StrategyTab が使っている。
- text の形式（実例・このまま fixture に使うこと）:
  `[btc-shadow-summary] 2026-11-25T10:43:21.757Z XBTC_USDC: 判断49件（AI買い1件）。+4h採点0件（AI買い分0件、平均―、プラス率―）。最新：AI=WAIT（確信64%）ルール=WAIT 局面=down 価格=58945。売買はしない記録だけの影。 動き: price=58943 chg24=-1.37 hi=60251 lo=58727 pts=59668,59775,60199,60085,60251,59757,59375,59946,60072,59673,59455,59821,59984,59735,59543,59260,59097,59387,58982,58953,59117,58727,59201,58840,58943`
- 末尾の ` 動き: price=<整数> chg24=<符号付き小数2桁> hi=<整数> lo=<整数> pts=<整数のCSV>` が値動きの機械可読部分。古いエピソードには無い場合がある（その場合は線なしで概要文だけ出す）。

## 読むファイル（これ以外は読まない）
- `apps/dashboard/src/PriceTicker.tsx`（RsiGauge・価格表示・formatChangePct / changeTone / sparklinePoints の既存ヘルパー）
- `apps/dashboard/src/main.tsx` の PriceTicker 呼び出し箇所（518行付近）
- `apps/dashboard/src/PartyPanel.tsx` 241〜245行と `apps/dashboard/src/StrategyTab.tsx` 110行（#513 の BTC ブロックと prop の除去対象）
- `apps/dashboard/src/styles/overview.css` と `apps/dashboard/src/styles/base.css`（パレット変数とボタンの最小高さ44pxルール）
- PriceTicker と PartyPanel の既存テスト（tests/ 配下の該当ファイル。探して様式を合わせる）

## 実装
1. 純関数パーサを新規ファイル `apps/dashboard/src/btcSummary.ts` に作る：
   `parseBtcShadowSummary(text: string)` → `{ at: string | null, body: string, move: { price: number, chg24: number, hi: number, lo: number, pts: number[] } | null }`
   - at = 先頭タグ直後の ISO 文字列。body = タグと ISO と末尾の「動き:」部分を取り除いた本文（前後の空白は整える）。
   - 「動き:」部分が無い・壊れている・pts が2点未満なら move は null（body は通常どおり返す）。例外を投げない。
2. 新規コンポーネント `apps/dashboard/src/BtcPanel.tsx`：
   - 見出し行：BTC マーク（オレンジ丸に白 ₿）＋「BTC」。
   - 価格行：`$58,943` 形式（カンマ区切り）＋「24時間 −1.37%」（符号と色は PriceTicker の formatChangePct / changeTone を再利用する）。
   - 線：pts を SVG ポリラインで描く（ミント色、薄い面塗り付き）。move が null のときは線・価格行・高安行を出さない。
   - 高値・安値行（move があるときだけ）。
   - 概要文 body をそのまま表示。
   - 最下行：`MemWal経由の参照表示` ＋ at の時刻（HH:MM）。
   - btcShadowSummary が null のときは「BTCの影の記録はまだ届いていません」の1行だけ。
3. `PriceTicker.tsx` に切替を入れる：
   - ブロック最上部に2つのボタン（Sui 雫マーク＋SUI／BTC マーク＋BTC）。選択中はマーク色の枠で示す。マークの色は TSX 内の SVG fill とインラインスタイルで持つ（チャートのオーバーレイが TSX に色を直書きしている前例に従う）。CSS 側はパレット変数だけを使う。
   - ボタンは高さ44pxを明示する（base.css の最小高さ44pxルールと衝突させない）。
   - `useState<"SUI" | "BTC">`（既定 SUI、永続化しない）。BTC のときは PriceTicker の従来内容（RsiGauge 含む）を描かず、BtcPanel だけを描く。SUI のときは従来内容そのまま。
   - btcShadowSummary は既存の data 経由で受け取る（main.tsx の呼び出し props の変更は最小限に）。
4. #513 の表示を除去：PartyPanel の BTC ブロック、PartyPanel の btcShadowSummary prop と型、StrategyTab の受け渡しを消す。worker 側（memwal.ts / engine-snapshot.ts）と snapshot のフィールドは残す。

## テスト・確認
- パーサの単体テスト：実例文（値動きあり）／値動きなし／壊れた値動き／pts 1点、の4ケース。
- 表示のテスト：BTC 選択時に RsiGauge が無く BtcPanel があること、SUI 選択時は従来どおり RsiGauge があること（既存の表示テストの様式に合わせる）。
- 実行するのは dashboard 関係のテスト、typecheck、lint、build、render-smoke のみ（フル vitest は CI に任せる）。
- PR 本文には画面の前後スクリーンショットを付ける：SUI 側（切替行が増えた状態）と BTC 側。サンプルデータでの撮影方法は #513 の PR と同じ流儀でよい。難しければローカルで snapshot を差し替えて撮影し、その方法を本文に書く。

## やらないこと
- worker・snapshot・MemWal まわりの変更、売買ロジック、設定項目の追加。
- 切替状態の永続化、BTC 側へのメーターや買いラインの追加。
- パーティ欄以外での #513 成果物の除去。

## PR 本文の形式
リポジトリの `.github/pull_request_template.md` の構成（結論→変わること→変わらないこと→確認したこと→本番への影響→画面の変更）に沿い、スクリーンショットを貼る。tokens used の累計は書かない（実行ログの最終行の数値をそのまま報告に使うこと）。

## 未指定パラメータの扱い
細部の数値や文言で指定が無いものは、保守的で妥当な値を自分で選んで実装し、PR 本文に明記する。
