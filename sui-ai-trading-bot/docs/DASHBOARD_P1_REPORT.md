# DeepBook欠損監査とダッシュボード通信削減

## 欠損調査

対象はUTC 2026-10-15〜22の既存プローブと同じ固定7日窓（from=1792020000 / to=1792624800、終了は排他的）。原データ1,968/2,016本、48本欠損（2.381%）。40区間、最大連続2本。

- NO_TRADES_VERIFIED: 48
- INDEXER_MISSING / PAGINATION_GAP / DATA_INVALID / UNKNOWN: 各0

[全48本のUTC・日本時間](DEEPBOOK_GAPS_48_P1.md)、[個別証拠と前後OHLCV](evidence/chart-gaps-48/report.json)、[公開API生応答](evidence/chart-gaps-48/responses.json)を保存した。

同一窓の5分足2ページ、対象範囲の1分足4ページ、欠損ごとの5分間の約定48リクエスト、最終同期状態1リクエストの計55件を2.5秒以上の間隔で照合した。すべてHTTP200。各約定応答は完全な空配列、1分足にも該当区間の足はなく、order_fillの非backfillパイプラインの同期時刻は全区間終了を超えていた。単なるOHLCV未返却を根拠にしていない。

OHLCV範囲パラメータは実測でミリ秒、約定範囲は秒、応答timestampはミリ秒。ページ境界・重複・変換による消失は認められなかった。公式仕様参照: https://docs.sui.io/onchain-finance/deepbook/deepbookv3/deepbookv3-indexer

独立したオンチェーン全約定イベント照合は未実施。分類の保証範囲は公式Indexer内の同期状態と約定APIの整合性であり、Indexer自身の完全性を外部証明したものではない。

既存のreconstructFiveMinutesを証拠取得時刻で適用し、48本をNO_INDEXED_TRADESとして生成。OHLC=直前確定終値、volume=0、provenanceと証拠URLを保持。表示キャッシュ内の本数は2,016、未解決0（0%）。元APIの欠損率自体は変わらない。将来の未知区間は自動補完しない。後から原OHLCVが取得できればキャッシュ内の無約定再構築を原データで更新する。

Bot側のProvider・再構築条件・分析入力には戻さない。元DBを変更しない。画面に期待/取得/欠損/再構築/未確定原因の件数と日時選択を追加した。

証拠からの再集計（外部アクセスなし）:

```powershell
pnpm exec tsx scripts/build-chart-gap-audit.ts
```

## 通信量の実測と比較

[変更前](evidence/dashboard-before.json)は稼働中3100への認証付き読み取り。約1秒隔てた2応答でデータフィールドの変更なし。取得所要64.2ms、Content-Encodingなし。

| 対象 | 変更前 /api/state | 新summary形式 |
|---|---:|---:|
| 非圧縮JSON | 1,034,818 B | 1,796 B |
| gzip相当 | 157,617 B | 997 B |
| 10秒×6回/分 非圧縮 | 6,208,908 B | 10,776 B |

新形式は同じ稼働中状態を読み取り、ローカルで新サーバー形式へ変換した値（[比較証拠](evidence/dashboard-after.json)）。通常更新の非圧縮削減率99.826%、gzip同士99.367%。gzip前値の数バイト差は別取得時の時刻差。初回チャート・記録・明示7日履歴・実際の変更分は別途加算される。HTTPヘッダー/TLSは含めない。新APIの実環境へのデプロイおよび実回線での削減率測定は未実施。

重複5分足253,706 B、candlesByTimeframe766,810 B、リスク履歴12,801 Bが主因。変更前のレスポンスの1,034,486 Bが比較時点で不変だった。10秒ごとに約3,000本と重複1,000本を受信・再解析していた。

## 実装

- 認証付き /api/dashboard/summary は安全状態・設定・KPI・接続/鮮度とチャネル版を返す。10秒周期を維持。チャート待機中も独立して状態を取得/表示する。
- /api/dashboard/candles?timeframe=300&version=... は新規・変更足と削除時刻だけを返す。全TF各3版を保持。基準版喪失/サーバー再起動/取得元変更では最大1,000本を再取得。SHA256検証で取りこぼしを検出し、古い表示を残して警告、次回完全復旧する。
- /api/dashboard/records は既存と同じ上限の取引/注文/リスク履歴。版が変化した時だけ取得。履歴の部分差分ではなく、整合性確認付きの有界スナップショット置換。
- チャートは表示中の時間足だけ。7日履歴は既存の手動取得・独立SQLiteキャッシュを再利用。閲覧操作からDeepBookの通常取得を呼ばない。
- 安全状態・鮮度は常にsummaryで更新。足の取得時刻のみの変更は版更新に含めない。OHLCV/取得元/provenance変更は含める。
- 1KB超のJSONはgzip対応クライアントに非同期圧縮。gzip;q=0を尊重。既存の認証・no-storeと旧/api/state互換を維持。旧サーバーには404時のみ旧APIへフォールバックし、その場合は通信削減されない。
- summary失敗は正常と見なさず既存の接続不明表示へ。履歴チャネルだけ失敗した場合も古い可能性を警告。停止/緊急停止API応答は即時表示し、自動再開しない。

## 性能・安全性と検証

ビルド、ユニット、認証付き隔離HTTPサーバー、ブラウザー4幅（375/390/430/1280px）で検証。稼働Docker/検証DBへの書き込み、再起動、再作成、デプロイは行っていない。

通常時は大きな配列をブラウザーへ転送・再解析・交換しない。サーバーでは版判定のため既存の有界履歴を読み出しハッシュするため、サーバーCPUがゼロになるものではない。定量的な実機モバイル速度・新APIの本番P95は未測定。

既存市場取得周期、監視、RiskEngine、Profit Guard、PAPER判断、LIVE拒否、24時間検証セッション保存と合格条件、JSON/Markdown検証レポートは変更していない。表示専用履歴失敗が取引判断へ伝播しない。稼働環境への反映は24時間検証終了後に行う。

### 実施結果（2026-10-22）

- `pnpm build`: 成功（依存ライブラリの既存annotation警告のみ）。
- `pnpm test`: 25ファイル、358件成功。RiskEngine/Profit Guard、PAPER限定、停止維持、認証、gzip、版喪失・チェックサム不整合からの復旧、取引記録置換、停止状態の即時公開、遅延応答による停止表示上書き禁止を含む。
- 新通信方式のブラウザー単独再実行: 4/4成功。モックAPI・ローカルChromiumで初回表示 375px=543ms、390px=546ms、430px=533ms、1280px=568ms。実回線・実機の速度ではない。
- 2,016本同期描画の既存E2Eも実行。画面幅ごとのズーム時間とSVG要素数をテスト出力に記録。
- Dockerは状態確認のみ。3100/3101とも作業開始時と同じコンテナID・StartedAt、再起動回数0、healthyを確認。

### 主な変更ファイル

- 調査・証拠: `scripts/investigate-chart-gaps.mjs`、`scripts/build-chart-gap-audit.ts`、`docs/DEEPBOOK_GAPS_48_P1.md`、`docs/evidence/chart-gaps-48/*`、`docs/evidence/dashboard-{before,after}.json`
- 表示用欠損管理: `packages/shared/src/chart-{gaps,gap-audit,gap-quality}.ts`、`apps/worker/src/chart-history.ts`、`apps/dashboard/src/PriceChart.tsx`
- API/差分プロトコル: `apps/worker/src/dashboard-feed.ts`、`apps/worker/src/index.ts`、`apps/worker/src/engine.ts`（snapshot表示投影のみ）、`packages/shared/src/dashboard-wire.ts`
- クライアント: `apps/dashboard/src/dashboardClient.ts`、`apps/dashboard/src/main.tsx`
- テスト: `tests/chart-gaps-p1.test.ts`、`tests/chart-history.test.ts`、`tests/dashboard-feed.test.ts`、`tests/settings-api.test.ts`、`tests/e2e/{chart-gap,dashboard-feed}.pw.ts`。既存E2Eの旧APIモック3ファイルには404互換応答を追加。

残る課題は、Indexerの独立オンチェーン照合、将来発生する未知の欠損の個別監査、24時間検証終了後の新API実配信計測、実機スマートフォンの応答測定。標準Providerの変更や安全条件の緩和では解決していない。

- 全E2E最終実行: 156/156成功、失敗0。測定結果は `docs/evidence/dashboard-tests-p1.json` に保存。最終実行の初回表示は約522〜542ms、2,016本のズーム操作は約74〜166ms（ローカルモック環境）。

### 機能単位のコミット

`0ca8959` 証拠監査、`6ee721d` 欠損表示と限定再構築、`e008102` 原データ優先更新、`2a7008c` 軽量APIと版管理、`385fc58` クライアント通信分離、`3728d1c` 遅延応答の逆転防止。最終テスト・報告書は別コミット。
