# DeepBook市場データの実動作検証とProvider統合

## 結論

main af96282を基準に、導入済みdeepbook-sdk / deepbook-overviewを使用した。実注文、署名、資金移動は行っていない。
DeepBookはSUI/Native USDCの板とOHLCVを取得できる。ただし5分足は欠損があり、現状の既存安全条件では単独運用に採用できない。既定のGeckoTerminalを維持し、明示設定でstrict DeepBookまたは全時間足単位の代替取得を試せるようにした。

## Phase 1: 追加の実測

公式資料:

- https://www.docs.sui.io/onchain-finance/deepbook/deepbookv3/deepbookv3-indexer
- https://www.docs.sui.io/onchain-finance/deepbook/deepbookv3-sdk/pools
- https://github.com/MystenLabs/skills/tree/e31b38016723e2dcee36161d59c50e028e13b52a

SDK 2.8.0とSui 2.37.0によるmidPrice、getLevel2TicksFromMidの成功は前回検証を再利用。今回の追加RPCはpoolBookParamsのみで、350ms、tickSize=0.00001 / lotSize=0.1 / minSize=1を確認した。キーやBalanceManagerは不要。SDK用依存は隔離調査フォルダにあり、アプリには新しい依存を追加していない。
SDKの読み取りはSui RPC上のシミュレーション。Indexer RESTは別の通信経路である。どちらも可用性を保証するものではない。

今回のIndexer板（観測値、固定レートではない）:

- SUI_USDC pool: 0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407
- Bid 1.02757 / Ask 1.02765 USDC/SUI、mid 1.02761、spread約0.007785%
- 最良買数量937 SUI、最良売数量973 SUI、各5段を取得
- 更新時刻1792553581987ms、板HTTP応答256ms
- Indexer status=OK、checkpoint lag=4、time lag=1秒、応答479ms

以下はlimit=1000、未確定足を除いた観測値。欠損率は最古〜最新の確定足の範囲内で「期待本数−取得本数」を期待本数で割った値。リクエスト全期間に対する網羅率ではない。0件の応答は欠損率を算定不能とする。

| 時間足 | 既定取得の確定本数 | 観測範囲（UTC、終端は足の終了） | 欠損本数 / 率 | 応答ms |
| ------ | -----------------: | ------------------------------- | ------------- | -----: |
| 1分    |                999 | 10/20 09:41〜10/21 03:33        | 73 / 6.81%    |   1991 |
| 5分    |                999 | 10/17 12:40〜10/21 03:30        | 43 / 4.13%    |   1147 |
| 15分   |                672 | 10/14 03:30〜10/21 03:30        | 0 / 0%        |    423 |
| 1時間  |                168 | 10/14 03:00〜10/21 03:00        | 0 / 0%        |    470 |
| 4時間  |                 42 | 10/14 00:00〜10/21 00:00        | 0 / 0%        |    292 |
| 日     |                  7 | 10/14 00:00〜10/21 00:00        | 0 / 0%        |    758 |

全6時間足がHTTP 200で対応。前回の5分足「36」は欠損区間数、今回は欠損した足の本数「43」を数えている。両者を同じ尺度として比較しない。欠損が取引ゼロ区間の省略かIndexer欠落かは確定していない。

公式資料はstart_time/end_timeを秒としているが、180日の秒指定は全6時間足で空配列だった。ミリ秒指定を追加検証すると:

| 時間足 | 確定本数 | 観測範囲（UTC）               | 範囲内欠損 | 応答ms |
| ------ | -------: | ----------------------------- | ---------: | -----: |
| 1時間  |      999 | 2026/09/09 12:00〜10/21 03:00 |          0 |   1371 |
| 4時間  |      999 | 2026/05/07 12:00〜10/21 00:00 |          0 |   1765 |
| 日     |      180 | 2026/04/24 00:00〜10/21 00:00 |          0 |    384 |

これは確認できた範囲であり、最大保持期間やページングの保証ではない。期間指定の単位差は実装の推測で埋めず記録した。運用Providerは今回安定して検証できた既定取得URLを使用し、期間パラメータを送らない。再現診断の--history-msだけ明示的にミリ秒を試す。

生データの要約・対象URL・観測時刻・最古/最新行はevidence/deepbook-readonly.jsonに保存した。

## 分析互換性

既存のTimeframeは300/900/3600秒。RSI14、EMA20/50、MACD12/26/9などは既存calculateをそのまま使用。取得段階で61本以上を要求し、直前足を除いた60本でも計算可能な既存条件を維持した。

- 15分・1時間は既定取得で必要本数を確保し、前回の実データと今回の同形式テストで指標計算成功。
- 5分は999本あっても途中欠損でCANDLE_GAPとなり、計算・売買へ渡さない。
- 1分は欠損、4時間/日足の既定取得は本数不足。追加の時間足を既存戦略へ自動適用しない。
- 長期指定では4時間/日足も本数を確保できたが、戦略とバックテストの時間足対応追加は今回行わない。
- 不足・欠損などで取得に失敗した場合、実効判断をWAITとして保存し既存の即時安全停止も維持する。

全時間足がAPI対応のため代替集約は実装していない。将来集約する場合は、同一取得元・ペア・単位の確定足がUTC境界に沿って全件揃うことを条件とする。欠損した1分足から5分足を捏造しない。
価格形成市場と出来高対象が異なるので、指標計算の形式互換性はシグナルの同一性を意味しない。OHLCV出来高をUSDC金額と仮定した換算は追加していない。

## Phase 2: 運用Provider

.envのMARKET_DATA_PROVIDER:

- geckoterminal: 従来互換、既定値。DeepBookへアクセスしない。
- deepbook: DeepBookのみ。品質不合格なら停止。
- auto: DeepBookを最初に検証し、対象障害時はGeckoTerminalで5分/15分/1時間の全系列を取り直す。

市場間のローソク足補完、時間足ごとのProvider混在、midを見積もり価格として流用する変更はない。売買の市場価格は既存どおり確定5分足close、見積もりはCetus、Profit Guard / RiskEngine / Paper Ledgerはそのまま通る。

安全条件:

- Native SUI/Native USDCの型・decimals、OHLCVの正数/整列/確定/連続性/鮮度を検証。
- Indexerのstatusと応答時刻を確認。
- 板の更新から10秒以内（未来許容5秒）、有限の正価格・数量、正しい並びと両側の存在を要求。
- spreadは既存設定maxSlippage以下。現在のmaxOrderを両方向とも許容価格範囲内の板で満たすことを要求。
- 約定直前にも板の鮮度と最新設定を同期的に再検証。RiskEngine等を迂回しない。
- 429、キャンセル、ペア不一致、古い/薄い/広い/不正な板はフォールバックで回避しない。
- 取得元の変化はDBに保存してMARKET_SOURCE_CHANGEDで停止。API復旧やDeepBookへの復帰でも自動再開しない。既存のsource別履歴保存を再利用し、履歴を削除しない。
- 両Provider失敗時は以前の価格を使わず停止。
- 従来のPAPER専用起動制約を維持。LIVE設定は全ProviderでDB作成・サーバー起動前に拒否する。LIVE機能の新規実装はしていない。

通信制御:

- DeepBookは各試行8秒、他APIは従来10秒。本文受信まで期限を適用。
- DeepBookのタイムアウト・通信障害・502/503/504だけ追加再試行最大2回（合計3試行）。1秒/2秒の指数待ちに0〜25%（最大1秒）のジッター。各待ち最大60秒。
- 通信失敗は最初の段階でWorkerを停止。復旧のための限定再取得が成功しても停止は解除しない。他APIの通常障害は従来どおり自動再試行なし。
- 429は既存のRetry-After処理、最大2回、長い待機・上限到達時の手動解除を維持。429で即時停止し代替先へ迂回しない。
- API別同時通信1、同一リクエスト集約、OHLCV20秒/pools300秒/status5秒キャッシュ。板はキャッシュしない。キャッシュ使用後もデータ自体の鮮度を検証。
- API別に最終正常取得と試行所要時間を監視。DNS失敗・通常通信失敗をタイムアウトと一律分類しない。

## Docker実測

新規イメージsuiba-verify:cecbc7f3bac0でWorkerを起動せずProviderだけを実APIへ接続した。

- DeepBookは5分足欠損で拒否、GeckoTerminalの5分1000本・15分1000本・1時間999本を取得。
- 全時間足のsourceは同一GeckoTerminalプール。CANDLE_GAPを代替取得理由として表示。
- 一式9597ms、DeepBook 4リクエスト・最終HTTP387ms、GeckoTerminal 4リクエスト・最終HTTP1052ms。
- 429・再試行は0。HTTP成功でも足品質は別途不合格と判定できた。

短い試験の結果で24時間安定性やDeepBookの速度優位は保証できない。Geckoの間欠タイムアウトの根本箇所は未確定、Sui gRPCのタイムアウトは別課題として残る。

## Phase 3: 検証

- pnpm build: 成功（既存Zodの注釈に関するビルド警告のみ）。
- pnpm test: Windowsで204件成功、失敗0。
- pnpm test:e2e: Chromium 375/390/430/1280pxで64件成功、失敗0。
- node --check scripts/probe-deepbook.mjs: 成功。
- node docker/verify-paper.mjs: Linuxビルド、起動、再起動後停止、緊急停止、SQLite履歴保持に成功。
- node docker/verify-compose.mjs suiba-verify:f9c9db7adcd2 --browser: Linux内204件、実ブラウザー、WAL/SIGTERM/SIGKILL/再作成/バックアップ/履歴保持/LIVE拒否/容量不足時の安全停止に成功。最終イメージで追加のLIVE各Provider設定・板再検証・取得元変更時の旧価格消去も検証済み。
- 検証ボリュームは保持: suiba-verify-cecbc7f3bac0-data、suiba-compose-verify-5bbe24e49fa1_paper-data、suiba-verify-f9c9db7adcd2-data、suiba-compose-verify-ed7f070e8e29_paper-data。
- 本番コンテナ・実運用DB・既存.envには触れていない。24時間連続運用、実回線での429/502/503/504強制発生は未実施。障害テストは制御された模擬入力で実行。

## 再検証・段階導入（PowerShell）

```powershell
Set-Location D:\Source\SuiBa\sui-ai-trading-bot
# 9件の公開GET。DBや売買は起動しない。繰り返し連打しない。
node scripts/probe-deepbook.mjs
# 長期取得は必要なときだけ。資料との差を確認する明示的なミリ秒指定。
node scripts/probe-deepbook.mjs --history-ms
pnpm build
pnpm test
pnpm test:e2e
```

HTTP成功だけで売買適合とは扱わず、欠損と必要本数を確認する。既存の5分足欠損が解決するまではgeckoterminalを推奨。
検証用の別DB/別Composeプロジェクトでautoを試す場合は、PAPERを停止した状態で.envのMARKET_DATA_PROVIDER=autoを明示し再ビルドする。起動後、取得元・鮮度・代替取得理由を画面で確認する。停止理由を確認して手動解除・手動開始し、まず24時間の観測を行う。実運用のDB/ボリュームを上書きしない。down -vは実行しない。

次の改善は、公式側への期間パラメータ単位差の確認、5分足欠損原因の特定、取得元別バックテスト、24時間の品質/遅延/レート制限の観測。これらを合格条件として既定取得元の変更を判断する。

## 変更ファイル

- packages/market-data/src: Provider契約、DeepBook REST取得、板検証、全系列選択、既存足検証の共通化。
- packages/shared/src/api.ts / index.ts: API別期限・限定再試行・遅延計測・安全なエラーコード。
- apps/worker/src/engine.ts / index.ts: 明示設定による構成、約定直前検証、取得元変更時停止、旧価格/指標/利益判定の消去。
- apps/dashboard/src/MarketDataPanel.tsx / OperationsPanel.tsx / main.tsx / operationLabels.ts: 取得元、遅延、代替取得、板、応答時間の日本語表示。
- .env.example / README.md: 互換性を保つ設定例と手順へのリンク。
- tests/api-recovery.test.ts / deepbook-provider.test.ts / paper-only.test.ts / e2e/market-data.pw.ts: 障害・品質・復旧・LIVE拒否・画面の回帰。
- scripts/probe-deepbook.mjs / docs/evidence/deepbook-readonly.json / 本書 / DEEPBOOK_SKILLS.md: 再現診断、公開データの根拠、追加知見。

GeckoTerminalの過去ログの約10秒は応答ヘッダー取得前の期限到達を示すが、接続待ちかCDN/上流応答待ちかまでは確定できない。今回もDNS変更やIPv4強制を根拠なく追加していない。
