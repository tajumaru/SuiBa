# DeepBook 5分足43欠損の原因と検証付き再構築

## 結論

基準はmain 284e0ea（Provider 0fa9a73）。導入済みdeepbook-sdk / deepbook-overviewを使用した。
前回の固定範囲を再取得して43区間を特定した。全43区間で公式Indexerの約定履歴が0件、1分足も0本であり、公式実装が無約定バケットを生成しないことと一致した。分類は**公式Indexerに収録された約定に基づく無約定空白**である。

これは全オンチェーンチェックポイントを独立走査して約定ゼロを証明した結果ではない。Indexer自体の未収録を数学的に排除したとは主張しない。以下の分類表と再構築はこの信頼範囲を明記する。既定ProviderはGeckoTerminal、再構築は既定offを維持する。DeepBook単独での24時間安全性は未確認。

## 1. 43本の原因分類と証拠

対象UTC範囲は2026-10-17 12:40以上〜2026-10-21 03:30未満（1042区間）。元の確定5分足999本、内部欠損43本。
正確な全43時刻は[evidence/gaps/missing-43.csv](evidence/gaps/missing-43.csv)に保存した。最初は10/17 13:35、最後は10/20 00:40 UTC。

| 分類                               | 観測結果                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| 約定なしによる空白                 | 43本。各300秒区間の公式/trades応答0件、上限未到達、該当1分足0本。独立した全チェーン不在証明ではない |
| Indexer側の足欠落（約定は存在）    | 今回は0本。約定があるのに足がない実例は確認できなかった                                             |
| API取得処理による43本の欠落        | 根拠なし。固定時間範囲・上限2000で同じ内部43欠損を再現。1分足は4ページで取得し重複0                 |
| 時間境界・集約不良による43本の欠落 | 根拠なし。元5分足999本のOHLCVが既存1分足集約と全件一致                                              |
| 原因未確定                         | 公式Indexerの収録範囲では0本。Indexerの歴史全体の完全性は未独立監査という制限を残す                 |

照合した公開APIと実装:

- OHLCVの固定範囲はミリ秒指定。5分足と1分足、15分足を比較した。
- /trades/SUI_USDCは**秒**指定。各欠損範囲をlimit=1000で照会したが全て0件で、取得上限による切り詰めではなかった。範囲外の約定を無視してゼロと誤判定しない。
- 1分足は1000+1000+1000+637件（終端境界の足を含む）。最古時刻より1秒前へend_timeを進め、ページ重複は0。分析では対象範囲外と未確定足を除外した。
- 照合終了時のIndexer status=OK、最大時間遅延1秒。order_fillのindexed_timestamp_ms=1792574314560で対象区間を通過している。これは現在の進捗であり、歴史的データの独立完全性保証ではない。
- 欠損13:35の隣接13:30区間には実約定を確認。Sui gRPCでdigest E8bRNsLUFv7XKBJEc2tK7TYYCZFix9yxawWhaNdGp4s6のOrderFilledを読み取り照合し、同じSUI_USDC pool、raw price=990270、base_quantity=2300000000、quote_quantity=2277621を確認。Indexerの0.99027 USDC/SUI、2.3 SUIと一致した。署名・注文はしていない。

公式ソースはMystenLabs/deepbookv3の276cca90cdaca2c3bf824cf03c313dda5e0beb8bを確認した（公開エンドポイントのデプロイSHAまで確認したわけではない）。

- [server.rs](https://github.com/MystenLabs/deepbookv3/blob/276cca90cdaca2c3bf824cf03c313dda5e0beb8b/crates/server/src/server.rs#L2048): ohclvは期間をミリ秒で読む。ParameterUtilのtradesは秒を1000倍する。
- [reader.rs](https://github.com/MystenLabs/deepbookv3/blob/276cca90cdaca2c3bf824cf03c313dda5e0beb8b/crates/server/src/reader.rs#L605): OHLCV期間を1000で割ってSQLへ渡す。
- [OHLCV SQL](https://github.com/MystenLabs/deepbookv3/blob/276cca90cdaca2c3bf824cf03c313dda5e0beb8b/crates/schema/migrations/2025-09-30-202714-0000_add_ohclv/up.sql): 5分/15分は存在するohclv_1mをGROUP BY。generate_seriesによる無約定足生成はない。
- [更新SQL](https://github.com/MystenLabs/deepbookv3/blob/276cca90cdaca2c3bf824cf03c313dda5e0beb8b/crates/schema/migrations/2026-08-21-000000-0000_align_ohclv_refresh_windows/up.sql): 約定を分単位で集約し、境界を揃えて更新。
- [live_ohclv.rs](https://github.com/MystenLabs/deepbookv3/blob/276cca90cdaca2c3bf824cf03c313dda5e0beb8b/crates/server/src/live_ohclv.rs): 最近の実約定を重ねる処理で、無約定足は生成しない。

資料に書かれたOHLCV秒指定は、同じ既知取引区間でも空配列、ミリ秒指定は3件だった（time-unit-check.json）。これはAPIごとの単位差であり、期間指定のない既存5分足URLの43欠損原因ではない。

根拠はevidence/gapsのhistorical-5m.json、cross-check.json、consistency-summary.json、neighbor-onchain.json、time-unit-check.json、upstream-implementation.jsonに保存した。公開約定の比較は2.5秒以上間隔で行い、429や通信失敗時の自動連打はしない。

## 2. 根拠付き再構築

明示設定DEEPBOOK_RECONSTRUCT_CANDLES=verifiedの場合だけ有効。既定off。既定MARKET_DATA_PROVIDER=geckoterminalは変更しない。

- 連続する同一市場・単位の確定1分足5本がある場合: 最初のopen、最大high、最小low、最後のclose、volume合計。重複・境界不正・未確定・異市場は拒否。
- 1分足が0本の場合: 正常なIndexerとorder_fillの進捗、正しい秒指定、範囲内の全約定取得が上限未到達で0件である証拠が必要。前の連続した確定足のcloseをOHLC、volume=0にする。
- 1分足が1〜4本しかない場合は、ゼロ証拠と矛盾する場合も含めて未解決。欠損1分足は作らない。
- 約定が存在するのに1分足がない、上限到達、証拠期限切れ、進捗未確認、遅延、範囲外応答は補完しない。
- 無約定確認は区間終了2分以降に限定。証拠の有効期限は1時間で、元の取得時刻と根拠を保持する。遅れて過去データが訂正されるリスクは残るため、運用前にこの信頼モデルを確認する。
- 1回の最大64欠損、1分足最大8ページ、45秒経過後は次の照会を開始しない。進行中APIの既存タイムアウト・再試行上限は別途適用されるため、総所要時間45秒を保証するものではない。途中証拠は後続周期で再利用できるがBotの自動再開はしない。
- 再構築に時間がかかるため、全系列取得後にIndexer状態と板を再取得してから既存の約定直前検証へ進む。
- 品質が不足すれば従来のCANDLE_GAP、WAITと安全停止を維持。既存autoフォールバック、429即時停止、RiskEngine、Profit Guard、Paper Ledger、緊急停止は変更しない。

今回の保存データでは、元999本を変更せず無約定足43本を生成。合計1042本、欠損率43/1042=4.1267%から0%、未解決0本。完全な1分足5本から再構築できた今回の欠損は0本（全43区間で1分足自体が0本だった）。1分足方式は追加テストで確認した。

## 3. 品質と履歴

Candleの任意provenanceにorigin（ORIGINAL / ONE_MINUTE_AGGREGATE / NO_INDEXED_TRADES）、upstream、pair、fetchedAt、timeframe、evidenceを保存。過去レコードでこの項目がなくても読める。
fetchedAtはProviderが元応答を受け取った観測時刻。既存HTTP短期キャッシュ使用時の元HTTP取得時刻は別のAPI監視を参照し、観測時刻だけで価格を新しいと判断しない。

品質集計に元データ欠損本数、再構築本数、未解決本数、最新確定足終了時刻、出自別本数を記録。Workerはmarket_qualityへ保存し、画面にDeepBook 5分足品質を日本語表示する。
再構築有効時は全DeepBook系列のsourceをDeepBook:SUI_USDC:USDC:verified-v1とし、元系列と保存領域を分離する。各足のprovenanceで元足・再構築足も区別する。source変更時は既存の手動再開ゲートを通る。DBスキーマ変更や履歴削除はしていない。

## 4. 1分・5分・15分の整合性

- 存在する5分足999本: 1分足の実観測集約と999/999一致。
- 15分足の完全な347区間: 無約定足を除いた実観測集約では347/347一致。
- 無約定5分足を含めて15分へ再集約すると337一致・10相違。相違は先頭にゼロ足がある15分区間のopen/high/lowで、closeとvolumeは一致した。

公式15分足は最初の実約定を始値とする。一方、ゼロ足を含む集約は前期間の終値から始まるため、例えば2026-10-18 03:30 UTCのopenは公式0.98686に対してゼロ足込み0.98457になる。これは再構築規約の差であり、新たな約定があった証拠ではない。公式15分足を再構築版で置き換えず、各時間足の出自を保持した。詳細はfifteen-mismatches.json。

## 5. 既存分析への影響

scripts/analyze-deepbook-gaps.tsは保存済み観測だけを使用し、APIや本番DBへ接続しない。欠損を含む元データの指標値は数学的な診断比較専用で、取引可能な入力として扱わない。

| 指標      | 最新比較点の差（再構築−元） | 比較期間中の最大絶対差 |
| --------- | --------------------------: | ---------------------: |
| RSI14     |                   -4.20e-11 |        5.26637ポイント |
| MACD12/26 |                   -1.33e-15 |             0.00062236 |
| Signal9   |                   -2.30e-15 |             0.00076079 |
| EMA20     |                           0 |             0.00165132 |
| EMA50     |                    2.45e-10 |             0.00130207 |

最新点の差が小さくても、欠損に近い区間では無視できない変化がある。ゼロ足により時間経過のEMA平滑化やRSIの平均損益の減衰が追加されるため。出来高0の足とその直後は既存の出来高判定が新規エントリーを見送る。規約の異なる系列を同じ入力として黙って置き換えていない。

- 同じ981時点・保有なし・既定RuleBasedStrategyの比較: 補完前は不正履歴をWAIT扱い、補完後もBUY=0 / SELL=0 / WAIT=981。差0だが、他設定・他戦略で差が出ない保証ではない。
- 元履歴のバックテストはCANDLE_GAPで拒否（実行不能を利益0と偽って比較しない）。
- 再構築履歴の既存バックテスト: Profit Guard ON/OFFとも977評価イベント、売買0件、純損益0、最終資産100 USDC。合成見積もりのPAPERモデルであり、実際の過去約定可能価格を再現したものではない。
- 再構築後のインメモリPAPER一周期再生: WAIT、取引0、安全エラーなし。これは実市場24時間運用ではない。再構築不能時のPAPER停止はテストで別途確認。
- 外部AI/LLMへの問い合わせは行っていない。既存の利用可能なルール戦略・指標を検証した。既存で未提供のAI戦略を新たに有効化していない。

詳細はimpact.json。

## 6. テスト結果

- pnpm build: 成功。既存のZod注釈警告のみ。
- pnpm test: Windows 224件成功（追加20件）、失敗0。
- pnpm test:e2e: 64件成功、失敗0。375/390/430/1280pxで品質表示を確認。
- node --check scripts/probe-deepbook-gaps.mjs と保存データモード: 成功。既定実行はAPIアクセスなし。
- pnpm exec tsx scripts/analyze-deepbook-gaps.ts: オフライン比較成功。
- Docker: suiba-verify:bc4b0a81a4eeのLinuxビルド・起動・再起動停止・履歴保持成功。
- node docker/verify-compose.mjs suiba-verify:bc4b0a81a4ee --browser: Linux内224件、認証画面、WAL、SIGTERM/SIGKILL、再作成、停止/緊急停止/設定/履歴保持、LIVE拒否、容量不足時の安全停止に成功。
- 検証ボリュームは削除せず保持: suiba-verify-bc4b0a81a4ee-data、suiba-compose-verify-16cc9fac8a2f_paper-data。

追加テストは完全履歴、証拠付き無約定、実約定との矛盾、完全5本の1分足、1分足不足、遅延、重複、境界不正、不十分証拠、履歴43本の再生、再構築不能時のWAIT/安全停止を含む。既存Geckoフォールバック・PAPER/LIVE拒否・Profit Guard/RiskEngineも回帰実行した。

## 7. 段階的な次の手順

標準ProviderからGeckoTerminalを外す判断はまだできない。次の独立した検証環境で、まず24時間のデータ品質・確認コスト・レート制限・板鮮度を観測する。既存.envと本番コンテナは今回変更していない。

```powershell
# このブランチを取得したプロジェクトで実行
node scripts/probe-deepbook-gaps.mjs
pnpm exec tsx scripts/analyze-deepbook-gaps.ts
# 約2〜3分・間隔付きの公開GETを再実施したいときだけ
node scripts/probe-deepbook-gaps.mjs --fetch
```

--fetchは新規data/gap-probe-時刻フォルダへ証拠を保存し、既存証拠やDBを上書きしない。HTTPエラーで停止し、無制限再試行しない。

分離した検証用.envでのみMARKET_DATA_PROVIDER=deepbook、DEEPBOOK_RECONSTRUCT_CANDLES=verifiedを明示する。再起動後は停止状態のまま、未解決0・十分な足数・取得元・板鮮度を確認する。source変更の停止理由を確認して手動解除・手動開始する。証拠収集が予算内に終わらなければWAIT/停止を受け入れ、条件を緩めない。

残るリスクはIndexer単一ソースの歴史完全性、過去データの訂正、初回証拠収集の時間/リクエスト増加、ゼロ足規約が他戦略へ与える影響。24時間検証とより長い期間・設定別バックテストを行い、必要なら自前Indexerや独立したオンチェーン照合を追加する。

## 変更ファイル

- packages/market-data/src/reconstruction.ts / deepbook.ts: 検証付き再構築、単位差に応じた取得、上限・キャッシュ・板再確認。
- packages/shared/src/index.ts: 任意のCandle provenance。既存レコード互換。
- packages/market-data/src/provider.ts / selection.ts: 品質伝搬と最終再確認。
- apps/worker/src/index.ts / engine.ts / .env.example: 明示設定、品質のDB記録。標準Provider維持。
- apps/dashboard/src/MarketDataPanel.tsx / tests/e2e/market-data.pw.ts: 日本語品質表示。
- tests/candle-reconstruction.test.ts / docker/verify-compose.mjs: 追加20テストとLinux実データfixtureの配置。
- scripts/probe-deepbook-gaps.mjs / analyze-deepbook-gaps.ts / docs/evidence/gaps / 本書: 再現手順、全43時刻、根拠、分析結果。
