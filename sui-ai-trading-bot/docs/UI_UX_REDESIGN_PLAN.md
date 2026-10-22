# SuiBa UI/UX 全面刷新：診断・設計計画

> **設計のみ。実装は未着手。** UI、売買ロジック、RiskEngine、Profit Guard、PAPER/LIVE、API、DB、Docker、アプリ依存関係は変更していない。

## 1. 調査対象・確度・制約

- 対象：`tajumaru/SuiBa` / `sui-ai-trading-bot` / ローカル `main`。
- 調査コミット：`8280279ed2a5e6c8ce3eeadb6b5a649d92d4be71`。
- 日付：2026-10-22（JST、クライアント提供日付）。
- **リモートの最新性は未確認**。`git fetch origin main` は `Could not resolve host: github.com` で失敗。ローカルHEADと取得済みorigin/mainの差分は0/0だが、これを最新リモート確認済みとは扱わない。実装着手前に再取得・差分診断が必要。
- 調査方法：全画面に関係するReact/CSS、表示変換、既存E2E・fixture、Skillの実行、マルチ通貨調査報告書の参照。
- **今回、ブラウザでの実画面診断は未実施**。隔離ビルドを試みたが、このチェックアウトには `node_modules/vite/bin/vite.js` がなく `MODULE_NOT_FOUND`。新規依存追加を避け、そこで中止した。別の既存環境から依存を流用したり、稼働PAPER・Docker・既存DBを使ったりしていない。
- 以下の問題はソースで確認した構造上の問題、または実画面での確認が必要なUXリスク。画素位置・横溢れ・フォーカス順・コントラストの現画面実測を完了したと主張しない。既存E2Eの存在と今回の実行結果も区別する。
- 書き込み・コミット対象は本報告書のみ。一時ビルド先はOS一時領域で、UIソースの生成・変更はない。

## 2. ui-ux-pro-max の動作確認

### 2.1 読み込み・依存・完全性

読み込んだSkill：リポジトリルートの `.agents/skills/ui-ux-pro-max/SKILL.md`。

配布情報は `upstream-manifest.json` と既存の `docs/UI_UX_PRO_MAX.md` を参照。導入物は `ui-ux-pro-max-cli@2.15.0`、参照GitHubコミットは `623a9a9037d006ea727f8213f084d02a6b6f11b5`。npm配布物とGitHub HEADが完全同一であるとは扱わない。

今回の実測：

| 確認 | 結果 |
| --- | --- |
| Python | 3.13.0、実行可能。インストールなし |
| スクリプト | `search.py`、`core.py`、`design_system.py`、`reasoning_contract.py` を確認 |
| 依存 | Python標準ライブラリと同梱モジュール。pip/npm追加なし |
| manifest整合性 | LF正規化SHA-256を46エントリすべて照合、不一致0 |
| 検索データ | products 192、styles 88、colors 192、typography 74、UX 119、charts 25レコードをCSVから実測。styles総数はactive検索件数とは異なる |
| Windows実行上の注意 | `Failed to find real location ... python.exe` の警告は出たが、検索結果を返し終了コード0。未実行扱いではない |
| 永続化 | `--persist` は使用していない。不適合な生成案を正規デザインシステムとして保存しないため |

Python実行時は `PYTHONUTF8=1`、`PYTHONDONTWRITEBYTECODE=1`。Skillや検索データを改変せず実行した。

### 2.2 実際に実行したコマンドと結果

以下のパスはGitルートからの相対パス。すべて実行済み。

```powershell
python --version
python .agents/skills/ui-ux-pro-max/scripts/search.py "fintech crypto trading dashboard" --design-system -p SuiBa -f markdown
# 不適合だったため、SkillのQuery Contractに従い1回だけ絞り直し
python .agents/skills/ui-ux-pro-max/scripts/search.py "trading platform" --design-system -p SuiBa -f markdown
python .agents/skills/ui-ux-pro-max/scripts/search.py "trading crypto" --domain product -n 2
python .agents/skills/ui-ux-pro-max/scripts/search.py "fintech trading" --domain color -n 2
python .agents/skills/ui-ux-pro-max/scripts/search.py "dark dashboard" --domain style -n 2
python .agents/skills/ui-ux-pro-max/scripts/search.py "keyboard focus modal" --domain ux -n 3
python .agents/skills/ui-ux-pro-max/scripts/search.py "time series financial" --domain chart -n 2
python .agents/skills/ui-ux-pro-max/scripts/search.py "japanese readable" --domain typography -n 2
python .agents/skills/ui-ux-pro-max/scripts/search.py "state accessibility forms" --stack react -n 3
```

| 検索 | 確認できた出力 | 採否 |
| --- | --- | --- |
| 全体生成・初回 | Trust & Authority + Conversion、Contact Sales、金/紫、Orbitron/Exo 2 | 実行成功。ただし営業サイト・未来的英字書体は端末に不適合。不採用 |
| 全体生成・再試行 | Hero + Features + CTA、汎用の明色パレット、Outfit/Work Sans | 実行成功。ただし汎用LP。妥当な端末専用システムは生成できなかった |
| product | Fintech/Crypto、Financial Dashboard、Dark Mode + Data-Dense、Minimalism | 金融ダッシュボードの情報優先と簡潔さを採用 |
| style | `dark-mode-oled`、`data-dense-dashboard` | 階層化した暗色面・グリッドを採用。黒一色、ネオン、過度な圧縮は採らない |
| color | Fintech/Crypto：金/紫 | ユーザー指定のチャコール/エメラルドを優先し不採用 |
| typography | Japanese Elegant：Noto Serif JP / Noto Sans JP、Corporate Trust | 日本語sansの方向を採用。明朝見出し・外部フォント読込は採らない |
| chart | Stock / Trading OHLC、Trend Over Time | 共通時間軸、塗り/中抜き、線種、OHLC表、キーボード代替を採用 |
| ux | Focus States、Focus Not Obscured Minimum/Enhanced | 固定バーの被覆防止と明瞭なfocusを採用。AAとAAAを混同しない |
| react | Controlled components、Debounce rapid input、Handle form submission | 入力値保持と送信状態の整理へ適用。安全操作をdebounceしない |

**結論：Skillの読込・生成・検索は正常に利用できた。一方、自動生成された全体案の製品適合は不合格。以下はSkillの検証済み部分ルールとユーザー要件を統合した人手設計案であり、生成器がこの完成案を返したとは主張しない。**

### 2.3 適用するルール

SKILL.mdのQuick Reference §1–§3を優先する。主な参照ルールは `color-not-only`、`focus-states`、`focus-not-obscured`、`keyboard-nav`、`error-feedback`、`content-priority`、`number-tabular`、`color-semantic`、`fixed-element-offset`、`error-recovery`、`state-preservation`、`tooltip-keyboard`、`time-scale-clarity`。

- 通常文字のコントラスト4.5:1以上、大文字/非テキストの該当要件3:1以上を設計目標とする。
- Webの最小ターゲット基準とiOSのpt/Androidのdpを混同しない。本製品の操作目標は44×44 **CSS px**、重要操作48px、間隔8px以上。
- 下部ナビは5項目以下、数字は等幅桁、色に加えて文言・形・アイコン。
- Skill内のPhosphor、GSAP、Tailwind、チャートライブラリ推奨は依存導入の許可ではない。今回も将来案の前提も新ライブラリ不要とする。

## 3. 現状診断

### 3.1 維持すべき既存の改善

既に日本語ラベル/Reasonによるエラー説明、44px以上のbutton/summary、設定プリセット・変更差分・保存確認、チャートの移動/拡縮ボタンとキーボード操作、価格/RSI/MACDの同期、欠損/表示専用再構築の監査表示がある。

また `dashboardClient.ts` のsummary/records/candles分離、遅延応答の保護、通信断の警告、PAPER専用表記も維持対象。「チャート操作やエラー説明がない」という診断はしない。

### 3.2 問題一覧と優先順位

P0は運用状態や操作の誤認に関わるUX修正を先行させる分類であり、実売買の脆弱性を発見したという意味ではない。

| ID | 優先 | 確認根拠 | 問題・リスク | 改善・受入条件 |
| --- | --- | --- | --- | --- |
| U01 | P0 | `SettingsPage.tsx:274` ProfitGuardSummary | `r.allowed` を「取引許可」と表示。利益審査とRisk/実行の許可を混同しやすい | 「利益条件を通過」に変更する設計。Risk・最終判断・約定状態は別段階表示 |
| U02 | P0 | `main.tsx:486–499`、CSS headerにsticky指定なし | 長い画面で緊急停止が視界外となり得る。実画面で到達性未検証 | 全画面に固定安全バー。停止に確認ダイアログを挟まず、再開/解除を別操作にする |
| U03 | P0 | headerの `disabled={!data}`、初回summary失敗経路 | 初回データ取得失敗では停止ボタンが無効。読み取り不能と停止指令可否が一緒になる | 認証状態・送信可否・停止確認を分離する設計。API可否は次工程で契約確認。通信断でも停止完了と表示しない |
| U04 | P1 | mainの状態欄、MarketDataPanel、OperationsPanel、複数Reason | 停止理由・データ品質・接続情報が複数の長文ブロックに分散 | 常時要約1か所＋段階的詳細。既存の未解決欠損/代替取得/監査根拠は隠蔽しない |
| U05 | P1 | Overviewの8KPI→ProfitGuard→チャート、StrategyにもProfitGuard先行 | ユーザーの最初の問い「稼働・安全・現在判断」が縦スクロールに分散 | 安全要約→損益4KPI→チャート/判断→履歴。利益の詳細計算は展開 |
| U06 | P1 | `style.css`の12/13px多用、`.error-code`11px、複数の個別HEX | 日本語・数値・補足の役割が近く、色と密度が画面ごとに異なる | 文字/面/余白/状態の意味トークン化、本文16px、補足14px、数字の右寄せ・等幅桁 |
| U07 | P1 | mainの横スクロールnavに7画面＋ログアウト | モバイルで隠れた画面が生まれる。場所の把握と戻る動作が弱い | PCサイドバー、スマホ4主要ナビ＋その他。ログアウトは設定内に分離 |
| U08 | P1 | `.cards`は450px以下1列、共通表はnowrap | スマホでKPIが長く続き、表の日時・理由・費用を見渡しにくい | 主KPI2列、主要ラベルが収まらなければ1列。履歴は要約カード＋詳細。横溢れは実測要 |
| U09 | P1 | SVG viewBox・12px軸文字、連動IndicatorPanel | 縮小時の軸/ローソク密度、操作説明とデータ品質表示の比率が未検証 | 指標の初期高さ・tick間隔・表示本数を幅別に設計。既存の共通軸・欠損表示を維持 |
| U10 | P1 | 運用検証に24h/7日会計、別タブにバックテスト | 実績レポートと合成見積もりの比較結果の発見経路が分かれる | レポート入口に「PAPER実績」「バックテスト試算」の二つを明示。集計値を混合しない |
| U11 | P1 | StrategyでDeepSeek未実装を明記 | AI Trading Terminalという将来ブランドがLLM稼働済みと誤認され得る | 現在は「ルールベース判断」。AIは未接続の説明のみ。架空のAI信頼度やモデル名を表示しない |
| U12 | P1 | Chart/DeepBook限定のfocus-visible、一般部品はUA依存 | キーボードフォーカスの見た目が全体で統一されていない | 全操作対象の共通focusとskip link。UA outlineを消すだけの変更は禁止 |
| U13 | P2 | 複数画面のdetails/pre/Reasonと長いデータ表 | 説明・監査・日常操作の情報密度が同じ | 一次判断、操作、監査証跡を3段階に。監査JSONは詳細に残す |
| U14 | P2 | 通常navの選択はローカルstate、CSSに複数breakpoint | URL/戻る/スクロール保持、幅別ルールの統一余地 | hash等の軽量な画面状態、標準breakpoint、未保存変更の既存保護を維持 |
| U15 | P2 | 今回はソース診断のみ | 実画面の折返し・読取・コントラスト・支援技術操作が未検証 | 隔離モックでPC/スマホ・200%拡大・キーボードを検証してから実装承認 |

## 4. デザインコンセプト

**SuiBa — Professional AI Trading Terminal**

運用者が数秒で「モード・稼働状態・データ・損益・判断」を把握でき、異常時は迷わず止められる端末。チャコールの階層面、限定したエメラルド、整列した日本語と数値を基本にする。装飾的なガラス、ネオン、価格点滅、背景動画、宣伝用heroは使わない。

ブランド下に常に「現在：ルールベース / PAPER仮想売買」を表示。将来のAI対応と、現時点の実装能力を分ける。LIVEは「未提供」であり、クリック可能なモード切替を作らない。

## 5. デザイントークン案（未適用）

### 5.1 色

下記は**提案CSSの文書化**であり、style.cssには適用していない。

```css
:root {
  color-scheme: dark;
  --color-bg: #0E1211;
  --color-surface: #161B1A;
  --color-surface-raised: #1D2522;
  --color-surface-selected: #15382B;
  --color-text: #F1F5F3;
  --color-text-secondary: #A9B8B1;
  --color-accent: #34D399;
  --color-on-accent: #06251B;
  --color-success: #34D399;
  --color-warning: #FBBF24;
  --color-danger: #FCA5A5;
  --color-danger-fill: #B91C1C;
  --color-on-danger: #F8FAFC;
  --color-info: #93C5FD;
  --color-border: #34463D;
  --color-control-border: #71867D;
  --color-focus: #93C5FD;
  --color-chart-up: #34D399;
  --color-chart-down: #FCA5A5;
  --color-chart-ema20: #93C5FD;
  --color-chart-ema50: #FBBF24;
  --color-chart-rsi: #C4B5FD;
  --color-chart-off: #93C5FD;
  --color-chart-on: #34D399;
}
```

相対輝度式で今回計算したペア：

| 前景 / 背景 | 比率 | 用途 |
| --- | ---: | --- |
| text / surface | 15.84:1 | 本文・主要数値 |
| text-secondary / surface | 8.44:1 | 補足・ラベル |
| accent / surface | 9.06:1 | 重要状態・リンク |
| on-accent / accent | 8.48:1 | 主ボタン |
| warning / surface | 10.43:1 | 警告文字 |
| danger / surface | 9.18:1 | 異常文字 |
| on-danger / danger-fill | 6.18:1 | 緊急停止ボタン |
| control-border / surface | 4.49:1 | 非テキストの操作境界に限定。小文字の色には使わない |

面を変えた組合せ、hover/focus/disabled、半透明、チャートの細線は次工程で個別測定する。一般borderは区切り用で、ボタンの唯一の識別手段にはしない。負の損益は符号と「損失」、利益は符号と「利益」を併記し、赤緑だけに依存しない。

### 5.2 タイポグラフィと数字

- 本文：既存の `"Noto Sans JP", "Yu Gothic", Meiryo, "Segoe UI", sans-serif` を維持。外部フォント配信・新規バイナリなし。
- 数字：`font-variant-numeric: tabular-nums lining-nums`。利用フォントで等幅桁が得られない場合は数値列だけ既存システムのmonospaceへfallback。
- 画面見出し24/32px・600、節見出し18/24px・600、本文16px・400・行間1.65、表14px・行間1.5、補足14px・行間1.6、コード12pxは展開詳細だけ。KPI28–32px・600。
- 数値は右寄せ、単位は隣接した列/ラベル。数量・価格・金額・率を別formatterで表示。内部Decimal/atomic値は変更しない。
- 損益は符号とUSDC、比率は%。不明を0と表示しない。丸め表示には「参考表示、詳細で正確値」を用意。極小価格を桁丸めで0に見せない。
- 本文の `word-break: break-all` は使わない。長いCoin Type/Digestだけ `overflow-wrap:anywhere`。日本語は約30–40全角文字の説明幅を基本にする。

### 5.3 余白・グリッド・部品寸法

| 項目 | トークン案 |
| --- | --- |
| 余白 | 4 / 8 / 12 / 16 / 24 / 32 / 48px |
| PC | 12列、gap24、サイドバー224、上部安全バー64、content padding24–32 |
| タブレット | 8列、gap16、drawerナビ |
| スマホ | 4列、gap12、左右16、カードpadding16、縦section24 |
| カード | radius12、1px境界、見出し/主値/補足の3層。浅いshadowは浮遊部品だけ |
| 操作 | button/input最小44px、主要・緊急操作48px、隣接間隔8px |
| 表 | 行48px、数値右寄せ、見出し固定は表領域だけ。小画面はカードへ変換 |
| レイヤー | content0 / sticky10 / drawer30 / dialog40 / status50。alertとdialogでfocusを隠さない |
| 動き | hover/focus120ms、開閉160msまでを目安。新数値の点滅なし。reduced-motionでは装飾transitionなし |

### 5.4 共通コンポーネント契約

| 部品案 | 責務・必須状態 |
| --- | --- |
| AppShell / SideNav / MobileNav | 現在位置、主要4項目＋その他、戻る、ページ見出し、skip link |
| SafetyBar | PAPER表示、稼働状態、停止理由要約、データ鮮度、緊急停止。状態不明を正常へ置換しない |
| StatusBadge | アイコン＋日本語＋必要時刻。稼働/停止/異常/未確認/遅延を区別 |
| MetricCard / NumericValue | 実績/試算、単位、時点、丸め、ゼロ/不明を明示 |
| DecisionPipeline | 戦略候補→見積もり→利益審査→Risk→最終判断/仮想約定。未審査は未審査 |
| AlertBanner / InlineError | 原因・影響・次操作・発生/最終成功時刻。コードは展開、重要警告は自動消去しない |
| FormField / SettingsDiff | 単位・範囲・入力エラー・保存済み/未保存・送信中/失敗を保持 |
| ChartToolbar / TimeRangeSummary | ペア、期間、時間足、共通選択時刻、欠損、表示専用再構築の凡例 |
| HistoryTable / TradeCard | 注文/約定/拒否を区別、フィルター、原価・費用・判断根拠の詳細 |
| ReportContext | PAPER実績/モデル試算、期間、データ元、費用設定、最終集計時刻 |
| LoadingState / EmptyState | 初回読込・取引なし・データ不足・取得不能・認証失効を別表示 |

部品は既存ReactとCSSで設計する。アイコンは既存資産またはプロジェクト内の単純なinline SVGを同一24px/線幅2pxで統一する案。装飾SVGはaria-hidden、操作には日本語の可視ラベルを付ける。Skillの推奨アイコンパッケージは導入しない。

## 6. 情報設計と画面構成

### 6.1 ナビゲーション

PC：ダッシュボード / チャート / 判断・戦略 / PAPER監視 / 取引履歴 / 損益・検証レポート / 設定。

モバイル：下部「概況・チャート・履歴・その他」の4項目。判断・監視・レポート・設定は「その他」一覧と各画面の文脈リンクから到達。緊急停止はこのナビと独立して上部固定。ログアウトは設定内のアカウント領域に分離する。

モードとナビ選択を同じ緑pillにしない。将来LIVEが追加されても、PAPER/LIVEは文字と異なるアイコンで区別。今回の設計にLIVE開始導線は含めない。

### 6.2 ダッシュボードPCワイヤー

```text
┌ SuiBa ─ PAPER仮想売買 ─ 停止中 / 停止理由 ─ 鮮度 ─ [緊急停止] ┐
│ Navigation │ 現在市場 SUI/USDC                  最終更新 JST │
│            │ [総資産] [日次純損益] [累計純損益] [保有残高]   │
│            │ 価格・EMAチャート 8列 │ 現在の判断/審査 4列     │
│            │                      │ 停止理由・次の安全操作  │
│            │ 直近取引/拒否 8列     │ 利益保護要約 4列        │
│            │ 展開：接続元・欠損監査・計算根拠・会計内訳      │
└────────────┴──────────────────────────────────────────────┘
```

優先順位は、①稼働状態/理由、②モード、③データ健全性、④損益/残高、⑤価格/チャート、⑥判断、⑦履歴。PCでは安全情報と判断を同時に見渡せる配置にする。

### 6.3 ダッシュボードスマホワイヤー

```text
上部固定：SuiBa / PAPER [緊急停止]
安全要約：停止中・理由・データ遅延/正常・最終成功
KPI 2列：総資産 / 日次損益、累計損益 / 保有残高
価格 + 簡潔なチャート（詳細はチャート画面）
現在判断 + 審査段階（利益条件通過≠実行）
直近3件の約定/拒否 + 履歴リンク
下部固定：概況 | チャート | 履歴 | その他
```

safe-areaと固定部品の高さを本文padding/scroll-paddingに反映。320pxまたは200%拡大でラベルが収まらなければKPI1列。非常操作を「その他」の中だけに置かない。

## 7. 画面別改善案

難易度：S＝表示部品中心、M＝レイアウト/状態保持、L＝チャート連動やデータ境界の入念な回帰確認。すべて実装前の見積もり。

| 画面 | 現状の問題 | 改善後の優先順位・PC | スマホ | 共通部品 | 難易度/既存影響 |
| --- | --- | --- | --- | --- | --- |
| ダッシュボード | U04/05、8KPIと利益計算が長い | 安全→4KPI→チャート/判断→直近履歴。計算詳細を展開 | 上記ワイヤー。KPI2列＋要約 | SafetyBar、MetricCard、DecisionPipeline | M。データ算式不変、summary/recordsキャッシュ維持 |
| チャート | 操作は充実、説明/監査/図の密度が高い | 市場/期間/時間足→価格→RSI→MACD→選択OHLC。3図の共通時間軸を維持 | 価格240px、RSI/MACD各100–120px目安、指標折畳み。別表で正確値 | ChartToolbar、StatusBadge、TimeRangeSummary | L。座標/間引き/欠損/履歴取得/同期へ高い回帰リスク |
| AI分析・判断 | 現在はルール戦略。ProfitGuardの方が先に表示 | 現在の最終判断→候補から拒否までの段階→根拠→固定指標/パラメータ。AI未接続明示 | 判断カード→縦pipeline→指標詳細 | DecisionPipeline、Reason、NumericValue | M。戦略条件・confidenceの意味を変えない |
| PAPER運用・安全監視 | 監査/24h判定/会計を長い画面で表示 | 現在の安全状態→停止理由/復旧手順→接続/鮮度/欠損→会計照合→24h監査 | 上位3情報を先頭、詳細は見出し単位で展開。重要異常は折畳まない | SafetyBar、AlertBanner、StatusBadge | L。観測合格を自動売買再開/LIVE可能と表現しない |
| 取引履歴 | 横長表、約定と拒否の詳細が連続 | 期間/方向/約定・拒否フィルター→サマリー→表→明細。ソートは表示のみ | 時刻/方向/数量/純損益をカード化、費用・原価・理由は展開 | HistoryTable、TradeCard、Reason | M。注文ID/件数/日時/台帳一致を保持 |
| 損益レポート | 実績は監視内、試算は別タブ | 入口を統合して「PAPER実績」と「バックテスト試算」を明確な別viewに。期間→純損益→資産/DD→費用 | 指標を絞り、ON/OFFは同じ表の2列、図は縦 | ReportContext、MetricCard、NumericValue | M。部分SELLの勝率定義・費用二重加算防止・期末未実現を維持 |
| 設定 | プリセット・差分確認は良いが、状態操作と数値設定の密度が高い | 運用開始/停止・解除を独立section。基本→利益保護→リスク→詳細。保存済み/編集中を分離 | 単位付き縦フォーム、送信中/未保存を保持。差分確認を再利用 | FormField、SettingsDiff、StatusBadge | M。上限・競合検出・保存と開始の分離を変更しない |
| エラー/警告/通知 | 複数の長文警告で状況を再構成する必要 | 最重要異常1件を常設、影響と次操作、関連するfieldにもinline。復旧は自動再開ではない | 1要約＋詳細、長いコードは展開。通知で操作を覆わない | AlertBanner、InlineError、LoadingState | M。コード情報/監査性/古い表示の警告を保持 |
| 認証/初回接続 | 待機とエラー時の情報が少ない | 接続中/認証失効/ネットワーク失敗を区別、再入力と再試行、入力paste可 | 16px入力・44px操作、トークン非表示 | FormField、InlineError、LoadingState | S。トークンをlocalStorage・URL・ログへ保存しない |

### 7.1 緊急停止の操作設計

1. 「緊急停止」＋停止形SVGを常時表示。設定保存/開始と色・位置・間隔を分離。
2. 停止指令は1タップ/1クリックで送る。長押しや事前確認で緊急操作を遅延させない。
3. 誤タップ対策は最低48px、周囲余白、危険操作群の分離で行う。解除/再開には既存の別手順を維持。
4. 指令送信中→サーバー確認済み停止→失敗/状態不明を区別。送信しただけで停止完了にしない。
5. 「緊急停止は新規注文停止であり、保有資産の強制売却ではない」と説明。
6. 認証済みでsummaryだけ取得不能な場合の停止操作は次工程の契約確認事項。API/権限を弱めず、停止確認不能ならその事実を表示する。

### 7.2 状態と復旧

| 状態 | 表示 | 操作・禁止事項 |
| --- | --- | --- |
| 初回読込 | 「状態を確認中」＋固定サイズのskeleton | 0資産/正常稼働と仮定しない |
| 取引ゼロ | 「まだ仮想約定がありません」 | 通信障害と区別、残高は既存値を表示 |
| 履歴不足 | 必要本数/不足/欠損理由、対象時間足 | 足を架空補間して有効に見せない |
| 一部表示取得失敗 | 影響したチャネルと最終取得時刻 | summary正常だけで古いチャートを正常扱いしない |
| 全通信断 | 「状態不明・最終取得時点」 | 古い値を消して0にしない、停止完了と断定しない |
| 安全停止/緊急停止 | 原因・確認時刻・次操作 | 正常化後の自動再開、色だけの解除は禁止 |
| 設定保存失敗 | fieldエラー＋保存前差分を保持 | 入力を初期化しない、未保存値で運用開始しない |

## 8. レスポンシブとアクセシビリティ

幅区分：0–479小スマホ、480–767大スマホ、768–1023タブレット、1024–1439PC、1440以上ワイド。既存の375/390/430/1280 E2Eは継続し、320/768/1024/1440と横向きを追加する。

- 1024以上は224pxサイドバー。768–1023はdrawer。767以下は下部4ナビ。
- 主画面の横スクロールなし。台帳の詳細表だけ例外として明示し、スマホではカード代替を優先。
- 本文・入力16px。200%拡大、フォント未導入、長い日本語、ゼロ/負値/大桁で検証。
- 見出しh1→h2→h3、mainへのskip link、現在ページaria-current、展開aria-expanded。navは画面移動、tabは同一文脈の切替に使い分ける。
- focusは3px＋offset3pxを基本に全操作へ統一。stickyによる被覆を防止。モーダルはEsc/取消/初期focus/復帰先を明確にする。
- 状態変化は必要なまとまりをaria-liveで通知し、価格更新のたびに読み上げない。緊急警告以外はfocusを奪わない。
- チャートは色以外に上昇/下降の塗りと中抜き、EMAの実線/破線、ON/OFFの直ラベル。RSI30/70、MACDゼロ線を明示。
- hover専用にせず、タップ/キーボード選択で同じOHLC/指標値を表示。既存の拡大/縮小/移動/最新ボタンを残す。
- データ欠損の線を連続価格として結ばない。表示専用補修は凡例で区別し、戦略用データへ昇格させない。
- reduced-motionで装飾を停止。価格点滅・自動スクロール・リアルタイム更新による選択解除を避ける。

## 9. 将来のマルチ通貨UI（実装しない）

参照：`docs/MULTI_CURRENCY_FEASIBILITY_2026-10-22.md`。同報告の市場観測は一時点の値であり、現在の対応可否・流動性を再確認したものではない。

SUI/USDCは現在市場。WAL/USDC、DEEP/USDC、XBTC/USDCは「設計候補・未提供」。クリックで実際に切り替わるように見せない。XBTCはBTC/USDやLZWBTCと別資産、decimalsも別である。

### 9.1 表示コンテキスト

将来の `MarketContextKey` はチェーン/ネットワーク、PAPER・LIVE、baseCoinType、quoteCoinType、pool/source、時間足、strategyIdを含む。表示名だけをキーにしない。損益はペア別台帳と口座全体を明確に区分する。

1. 全画面上部に現在ペアとモード。チャート・判断・損益・履歴の見出しにも対象を明示。
2. ペア切替で世代IDを増やし、旧リクエストをabort。キャンセル不能でも古い世代/異なるkeyの応答は破棄。
3. 新しい市場の取得中に前市場の値を新市場ラベルの下へ置かない。市場別キャッシュを使う場合も必ずその市場の最終取得値として表示。
4. chart、quote、decision、portfolio、records、設定のkeyと時点を揃えたview modelが揃うまで「切替中」。一部成功を市場全体の正常としない。
5. グラフの範囲/カーソル、判断理由、比較レポートは市場別に保存。GLOBAL集計には「全市場」の見出し。
6. 注文不可理由（未提供・データ不足・lot不一致・流動性不足）を別状態で表示。UIで既存Coin許可リストを広げない。
7. WAL/DEEPの小数価格、XBTCの大きい価格/8桁数量を別formatterで扱い、固定4桁で0表示にしない。最小数量・lot・tickは将来の検証済みメタデータに基づく。

回帰シナリオ：SUI→WAL→DEEP→XBTCを連続選択、応答順逆転、一部チャネル失敗、同じ時刻の別通貨取引、PAPER/LIVE誤混入、USDC残高の二重集計。今回はデータ型/API/DB/Coin Typeを変更しない。

## 10. 実装優先順位とコミット案

次回、ユーザーが設計を確認して実装指示を出した後に進める。

| フェーズ | 優先 | コミット単位の案 | 完了基準 |
| --- | --- | --- | --- |
| 0：再確認 | 前提 | 最新main再取得、隔離モック環境/ベースライン画像を準備 | 本報告との差分、実画面のP0/P1を確認。稼働環境は不使用 |
| 1：安全な表示 | P0 | `fix(ui): distinguish profit approval and confirmed stop states` | 利益審査と実行を区別、緊急停止の到達性、失敗時の不明表示を検証 |
| 2：基盤 | P1 | `refactor(ui): introduce semantic tokens and shared primitives` | 数式/データを変えず色・数字・余白・focusを統一 |
| 3：Shell/概況 | P1 | `feat(ui): add responsive terminal shell and dashboard hierarchy` | PCサイドバー/スマホナビ、状態→損益→判断の優先順位 |
| 4：各画面 | P1 | チャート、判断/監視、履歴/レポート、設定を個別コミット | 既存の同期・監査・会計・上限・保存競合を維持 |
| 5：品質 | P2 | `test(ui): cover accessibility responsive and stale data states` | モックE2E・keyboard・200%・低速/通信断・各幅の比較 |
| 6：将来準備 | 保留 | マルチ通貨の表示コンテキスト設計を別承認 | backend/台帳分離が先。今回のUI刷新と同時実装しない |

難易度が高いのはチャートと安全監視。配色変更とデータ取得/チャート計算の変更を同じコミットへ混ぜない。

### 10.1 変更予定ファイル（今回は変更しない）

- `apps/dashboard/src/style.css`：トークン、共通文字/グリッド、responsive。
- `apps/dashboard/src/main.tsx`：AppShell、安全要約、情報順序、部品への分割。
- `apps/dashboard/src/SettingsPage.tsx`、`settingsEditor.ts`、`settingsPresets.ts`：表示と入力体験。既存上限/競合ロジックは維持。
- `PriceChart.tsx`、`IndicatorPanel.tsx`、`chartPresentation.ts`、`presentation.ts`：視覚と数値表示。計算値を変えない。
- `MarketDataPanel.tsx`、`OperationsPanel.tsx`、`DeepBookValidation.tsx`、`Reason.tsx`：状態・復旧・監査の表示階層。
- `BacktestComparison.tsx`：実績/試算の文脈と比較可読性。
- 将来新設候補：`ui/SafetyBar.tsx`、`ui/MetricCard.tsx`、`ui/StatusBadge.tsx`、`ui/DecisionPipeline.tsx`、`ui/HistoryTable.tsx`。別パッケージ導入なし。
- `tests/e2e/*.pw.ts`、既存fixture：隔離表示・回帰ケース追加。
- 原則変更対象外：worker/API、DB、RiskEngine、Profit Guard、strategy、paper-trading、Coin許可リスト、Docker、package依存。表示に追加データが必要なら別途設計し承認する。

## 11. 回帰テスト計画

今回アプリコードを変更していないため `pnpm build/test/test:e2e` は実行していない。既存チェックアウトの依存不足もあり、成功したとは報告しない。次回は新規ライブラリなしで隔離依存環境を用意できるかを先に確認する。

| 観点 | ケース | 受入条件 |
| --- | --- | --- |
| 安全表示 | 停止/稼働/安全停止/緊急停止、summary初回失敗/送信失敗 | 不明≠正常、指令送信≠停止完了、解除≠再開 |
| 審査 | BUY/SELL/WAIT、ProfitGuard通過/Risk拒否/未審査/仮想約定 | 同じデータで既存判断と一致、許可段階を誤表示しない |
| 認証 | 未接続/失効/再試行/ログアウト | TokenをURL・永続ストア・consoleへ出さない |
| 通信 | summary成功＋chart失敗、records遅延、応答逆転、復帰 | 既存dashboard-feedのバージョン整合・古い応答防止を保持 |
| チャート | 5m/15m/1h、履歴追加、拡縮、欠損/補修/元足復帰 | RSI/MACD共通軸、欠損を連結しない、表示補修を売買へ使わない |
| 会計 | 部分SELL、ゼロ取引、マイナス損益、不明費用、最終保有 | 原価/純損益/勝率/手数料/ガスの数値・定義が一致 |
| 設定 | preset/個別調整/未保存/保存失敗/409競合/開始 | 差分保持、保存と運用開始を分離、安全上限不変 |
| responsive | 320/375/390/430/768/1024/1280/1440、横向き、200% | 固定バー被覆なし、長文/大桁可読、主画面横溢れなし |
| a11y | Tab/Shift+Tab/Enter/Esc、スクリーンリーダー、色覚差 | focus可視、名前/状態/順序適切、色以外の識別 |
| 状態 | 初回skeleton、データ不足、取引ゼロ、一部障害 | 0/不明/未取得を区別、入力や選択位置を失わない |
| 影響境界 | mock API全経路捕捉、メモリDB、隔離ポート | production API/DB/Dockerへアクセスしない |

既存 `tests/e2e/chart*.pw.ts`、`dashboard-feed.pw.ts`、`market-data.pw.ts`、`market-timing.pw.ts`、`settings.pw.ts`、`operations.pw.ts`、`deepbook-validation.pw.ts`、`validation-ux.pw.ts`、`localization.pw.ts` を基盤にする。通常unit/build成功後にモックE2E、比較画像、手動支援技術確認を行う。見た目だけのために安全テストを削除・緩和しない。

## 12. 最終判断

最初の改修対象は **共通SafetyBarとダッシュボード**。P0の意味と到達性を固めてから、トークン→Shell→各画面→responsive/a11yの順に進める。

Skillは実際に利用できたが、全体生成の適合と画面実測には上記の限界がある。実装承認前には最新main確認と隔離画面診断を補完する。本報告は収益性・運用安全性・将来AI/LIVE稼働の保証ではなく、UI刷新の設計案である。
