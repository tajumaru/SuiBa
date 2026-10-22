# SuiBa マルチ通貨対応可否の事前調査

- 調査日: 2026-10-22
- 対象: tajumaru/SuiBa / main / sui-ai-trading-bot
- コード調査対象コミット: [9f05151dd9616caf95742f3b492857e84eb7f526](https://github.com/tajumaru/SuiBa/tree/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot)
- 市場観測: 2026-10-22 18:09–18:12 JST頃
- 文書化時のmain: c1b83ff5106aabfb8fa5d413135055d53cecb419。調査後のコード変更は再監査していない。
- 性格: 調査報告。実装仕様の確定、売買推奨、将来の流動性・収益性の保証ではない。

## 1. 結論と調査範囲

複数通貨への拡張は可能。ただし調査対象コードはSUI/USDC専用であり、ペア名の追加だけでは履歴・会計・リスクを安全に分離できない。最初の候補はWAL/USDC → DEEP/USDC → XBTC/USDC。BETH/USDC、WAL/SUI、SEND/USDCは今回の市場状態では自動PAPER対象から除外する。

調査ではGitHubコード、公式SDK、公式資料、公開Indexerの読み取りのみを実施した。コード・設定変更、DB接続・更新、Docker操作、注文、署名、24時間PAPER検証への操作は実施していない。後続のユーザー指示で、この報告書の作成・コミット・Pushのみが許可された。

取得できない項目は未確認とする。プール登録、SDKマップへの収録、価格取得、連続履歴、実際の約定可能性は別々に評価する。

## 2. ペア別判定

判定は必要なコード変更後の安全な自動PAPER運用を想定する。「現在のコードで利用可能」という意味ではない。

| ペア | 価格取得 | 7日履歴 | AI分析 | PAPER売買 | 流動性 | 総合判定 |
|---|---|---|---|---|---|---|
| WAL/USDC | 可能 | 取得確認、5分足欠落 | 条件付き | 条件付き | 売り板が薄い瞬間あり | 条件付きで対応可能 |
| XBTC/USDC | 可能 | 取得確認、5/15分足欠落 | 条件付き | 条件付き | 今回は比較的良好 | 条件付きで対応可能 |
| DEEP/USDC | 可能 | 取得確認、5/15分足欠落 | 条件付き | 条件付き | 小口向け、深さ監視必須 | 条件付きで対応可能 |
| NS/USDC | 可能 | 取得確認、欠落多数 | 条件付き | 条件付き | 薄い | 条件付きで対応可能 |
| BETH/USDC | 板取得可、実用価格に難 | 今回は空配列 | 現状困難 | 現状困難 | 著しく悪い | 現時点では対応困難 |
| WAL/SUI | 板取得可、実用価格に難 | 今回は空配列 | 現状困難 | 現状困難 | 著しく悪い | 現時点では対応困難 |
| DEEP/SUI | 可能 | 取得確認、欠落あり | 条件付き | 条件付き | 小口向け | 条件付きで対応可能 |
| LZWBTC/USDC | 可能 | 取得確認、5分足欠落多数 | 条件付き | 条件付き | 今回は比較的良好 | 条件付きで対応可能 |
| SEND/USDC | 約定価格取得可、板に難 | 少数のみ | 現状困難 | 現状困難 | 著しく悪い | 現時点では対応困難 |

AI分析の条件は履歴品質の検証と分析機能の実装。調査対象mainで有効な分析はrule-basedで、DeepSeekはavailable: false。LLMによる分析がすでに動くとは確認できない。

## 3. MainnetプールとCoin Type

対象9ペアはすべて公開Indexerと公式SDKのMainnet既定マップに存在した。BETHはSDKキーがBETH_USDC、Indexer名がBWETH_USDCで、同じPool IDを指す。

出典: [get_pools](https://deepbook-indexer.mainnet.mystenlabs.com/get_pools)、[公式SDK定数](https://github.com/MystenLabs/ts-sdks/blob/main/packages/deepbook-v3/src/utils/constants.ts)。外部リンクのmainとAPI応答は変動する。以下は調査時点の転記で、raw応答ファイルは保存していない。

| ペア | Pool ID |
|---|---|
| WAL/USDC | 0x56a1c985c1f1123181d6b881714793689321ba24301b3585eec427436eb1c76d |
| XBTC/USDC | 0x20b9a3ec7a02d4f344aa1ebc5774b7b0ccafa9a5d76230662fdc0300bb215307 |
| DEEP/USDC | 0xf948981b806057580f91622417534f491da5f61aeaf33d0ed8e69fd5691c95ce |
| NS/USDC | 0x0c0fdd4008740d81a8a7d4281322aee71a1b62c449eb5b142656753d89ebc060 |
| BETH/USDC | 0x1109352b9112717bd2a7c3eb9a416fff1ba6951760f5bdd5424cf5e4e5b3e65c |
| WAL/SUI | 0x81f5339934c83ea19dd6bcc75c52e83509629a5f71d3257428c2ce47cc94d08b |
| DEEP/SUI | 0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22 |
| LZWBTC/USDC | 0xf5142aafa24866107df628bf92d0358c7da6acc46c2f10951690fd2b8570f117 |
| SEND/USDC | 0x1fe7b99c28ded39774f37327b509d58e2be7fff94899c06d22b407496a6fa990 |

USDC建てペアのquoteは下記USDC、SUI建てペアのquoteは下記SUI。

| 通貨 | decimals | Coin Type |
|---|---:|---|
| WAL | 9 | 0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL |
| XBTC | 8 | 0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC |
| DEEP | 6 | 0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP |
| NS | 6 | 0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS |
| BETH | 8 | 0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH |
| LZWBTC | 8 | 0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC |
| SEND | 6 | 0xb45fcfcc2cc07ce0702cc2d229621e046c906ef14d9b25e8e4d25f6e8763fef7::send::SEND |
| USDC | 6 | 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC |
| SUI | 9 | 0x2::sui::SUI |

BTC本体、Sui上のxBTC、LayerZero WBTCは別資産。XBTCとLZWBTCも別Coin Type・別価格として扱う。BTC/USDによる代用は禁止すべき設計条件。公式SDKにもXBTCをBTC価格フィードで評価しない注意がある。

### 3.1 最小数量、lot、tick

| ペア | 最小数量: base | Lot Size: base | Tick Size: quote/base |
|---|---:|---:|---:|
| WAL/USDC | 1 | 0.1 | 0.000001 |
| XBTC/USDC | 0.00001 | 0.00001 | 1 |
| DEEP/USDC | 10 | 1 | 0.00001 |
| NS/USDC | 1 | 0.1 | 0.00001 |
| BETH/USDC | 0.001 | 0.0001 | 0.001 |
| WAL/SUI | 1 | 0.1 | 0.000001 |
| DEEP/SUI | 10 | 1 | 0.00001 |
| LZWBTC/USDC | 0.00001 | 0.00001 | 1 |
| SEND/USDC | 1 | 0.1 | 0.000001 |

Indexer登録値をSDKと同じ式で換算したもの。現在のオンチェーンbook parameterとの一致は未確認。

- 数量 = raw / 10^baseDecimals
- tick = raw × 10^baseDecimals / 10^quoteDecimals / 10^9

出典: [poolBookParamsのSDK実装](https://github.com/MystenLabs/ts-sdks/blob/main/packages/deepbook-v3/src/queries/poolQueries.ts)。

### 3.2 Maker/Taker手数料

- DEEP/USDC、DEEP/SUI: 公式仕様上whitelisted poolはMaker/Takerとも0%。今回の現在オンチェーン値は未確認。
- WAL/USDC、XBTC/USDC、NS/USDC、BETH/USDC、WAL/SUI、LZWBTC/USDC、SEND/USDC: 現在のMaker/Taker料率は未確認。

料率はプール別ガバナンスパラメータ。実装前にpoolTradeParams等で読む。SDKメソッドは換算済み料率を返すため、追加で1e9除算しない。

出典: [公式手数料仕様](https://www.docs.sui.io/onchain-finance/deepbook/deepbookv3/fees-and-funding)、[SDK処理](https://github.com/MystenLabs/ts-sdks/blob/main/packages/deepbook-v3/src/queries/poolQueries.ts)。

## 4. 現在の板・24時間取引

対象9ペアはticker上isFrozen=0。ただし出来高ゼロもあり、凍結フラグだけでは運用可能性を判定できない。オンチェーンのpause状態の独立確認は未実施。

板はlevel=2&depth=100（最大50水準/側）。深さはmid±0.3%以内の価格×数量の合計でquote通貨単位。取得上限外の板は含まない。1 bps=0.01%。

| ペア | 最良bid / ask | spread: bps | 買い板深さ / 売り板深さ | 24h quote出来高 |
|---|---|---:|---:|---:|
| WAL/USDC | 0.037702 / 0.037759 | 15.11 | 313.76 / 6.04 USDC | 234,537.75 USDC |
| XBTC/USDC | 81,795 / 81,828 | 4.03 | 16,091.12 / 3,564.93 USDC | 826,229.62 USDC |
| DEEP/USDC | 0.01826 / 0.01828 | 10.95 | 23.98 / 29.25 USDC | 222,553.03 USDC |
| NS/USDC | 0.01273 / 0.01275 | 15.70 | 6.43 / 41.43 USDC | 4,077.62 USDC |
| BETH/USDC | 1,000 / 99,975 | 19,603.86 | 0 / 0 | 0 |
| WAL/SUI | 0.0285 / 0.09 | 10,379.75 | 0 / 0 | 0 |
| DEEP/SUI | 0.01863 / 0.01865 | 10.73 | 5.03 / 19.59 SUI | 123,324.17 SUI |
| LZWBTC/USDC | 81,654 / 81,681 | 3.31 | 42,279.95 / 24,824.98 USDC | 798,832.34 USDC |
| SEND/USDC | 0.05 / 0.1989 | 11,964.64 | 0 / 0 | 2,442.02 USDC |

出典: [ticker](https://deepbook-indexer.mainnet.mystenlabs.com/ticker)、[板取得例](https://deepbook-indexer.mainnet.mystenlabs.com/orderbook/WAL_USDC?level=2&depth=100)。

単発観測であり、時間帯別安定性・約定集中度・24h約定件数は未確認。WALは出来高があっても売り板深さが約6 USDCの瞬間がある。既存5 USDC注文を無条件適用せず、深さに対する注文額倍率を制限する。

観測時status=OK、order_fill遅延約1秒。可用性保証ではない。[status](https://deepbook-indexer.mainnet.mystenlabs.com/status)

## 5. 時間足・7日履歴

公式対応時間足は1m、5m、15m、30m、1h、4h、1d、1w。対象9ペアの5m/15m/1hを実測した。

公式資料は時刻範囲をUnix秒と説明するが、今回の/ohclv実測では秒指定が空配列、ミリ秒指定で履歴が返った。返却足時刻もミリ秒。秒指定の空配列だけで履歴なしと判断しない。エンドポイントごとに単位を検証する。

対象範囲: start=1792055446690、end=1792660246690（Unixミリ秒、約10月15日18:10～22日18:10 JST）。interval別にlimit=3000で取得。

| ペア | 5分足: 本数 / 内部欠落 | 15分足: 本数 / 内部欠落 | 1時間足: 本数 / 内部欠落 |
|---|---:|---:|---:|
| WAL/USDC | 1,971 / 46 | 673 / 0 | 169 / 0 |
| XBTC/USDC | 1,625 / 391 | 654 / 19 | 169 / 0 |
| DEEP/USDC | 1,966 / 50 | 671 / 2 | 169 / 0 |
| NS/USDC | 746 / 1,266 | 445 / 226 | 162 / 6 |
| BETH/USDC | 0 | 0 | 0 |
| WAL/SUI | 0 | 0 | 0 |
| DEEP/SUI | 1,828 / 188 | 668 / 5 | 169 / 0 |
| LZWBTC/USDC | 1,370 / 645 | 624 / 48 | 169 / 0 |
| SEND/USDC | 20 / 1,935 | 15 / 637 | 11 / 153 |

API境界丸め・未確定足を含む生レスポンスの集計。169本を確定1時間足169本とは扱わない。内部欠落は返却最古・最新足間の不足数で、両端不足は含めない。欠落が無約定かIndexer欠損かは個別証明していない。

7日範囲で取得できることと、連続した7日分の足を保証できることは異なる。BETH/WAL-SUIの空配列は今回の観測結果であり、過去全期間に履歴がないことは意味しない。

既存売買用取得は各時間足limit=1000で、5分足7日=2,016本に不足。検証は61本以上・連続足を要求。再構築は5分足のみで、1分足集約と無約定証明を使う。15分/1時間の欠落には同じ再構築がない。表示履歴と売買判断用履歴も別経路。

出典: [公式Indexer仕様](https://www.docs.sui.io/onchain-finance/deepbook/deepbookv3/deepbookv3-indexer)、[取得例](https://deepbook-indexer.mainnet.mystenlabs.com/ohclv/WAL_USDC?interval=1h&limit=200)、[Provider](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/packages/market-data/src/deepbook.ts)、[Candle検証](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/packages/market-data/src/validation.ts)。

## 6. コード調査

以下のパスはsui-ai-trading-botからの相対パス。対象コミットの構造を記載する。

| 対象 | ファイル | 固定値・構造と変更要件 |
|---|---|---|
| 共通型・通貨 | packages/shared/src/index.ts | coin()はSUI/USDCのみ。decimals=9/6、Portfolio.sui、provenance.pair=SUI_USDCを一般化 |
| DeepBook | packages/market-data/src/deepbook.ts | プール検証・全パス・source・品質・証明がSUI固定。min/lot/tickを注文制約に使っていない |
| Market Data | packages/market-data/src/index.ts, selection.ts, provider.ts | GeckoもSUI/native USDC固定。選択状態・健全性を市場別に分離 |
| 再構築 | packages/market-data/src/reconstruction.ts | 証明・source・パスがSUI固定。証明キャッシュも市場別識別が必要 |
| 表示履歴 | apps/worker/src/chart-history.ts, chart-history-client.ts, chart-history-worker.ts | 履歴主キー(tf,ts)、coverageにもpairなし。市場キー追加 |
| 分析 | packages/strategy-engine/src/index.ts, apps/worker/src/engine.ts | rule-basedのみ有効。context・結果の市場識別を追加 |
| 指標 | packages/indicators/src/index.ts | EMA/RSI/MACD数式は再利用可。単一市場・同時間足・連続確定足を入力保証 |
| RiskEngine | packages/risk-engine/src/index.ts | SUI方向、p.sui、USDC評価、日次制限が固定 |
| Profit Guard | packages/profit-guard/src/index.ts | 方向・1e9/1e6・USDC損益・分割決済数量が固定 |
| PAPER | packages/paper-trading/src/index.ts, reconciliation.ts | SUI残高、9桁数量、照合許容誤差が固定。Fillに必須pairなし |
| 見積り | packages/dex-router/src/index.ts | Cetus利用。SUI基準の価格影響計算。totalDeepFee>0を拒否 |
| 資産評価 | packages/portfolio/src/index.ts | SUI数量×価格の構造 |
| DB | packages/database/src/index.ts | runtime/portfolio/settings/price/decision等が単一キー。履歴検索にpair条件なし |
| Worker・監視 | apps/worker/src/engine.ts, index.ts, operations.ts, scheduler.ts | 単一Engine・状態・監視。市場別停止・共有資金制御が必要 |
| 設定・API | packages/shared/src/index.ts, apps/worker/src/index.ts | 設定にpairなし。state/settings/control/chart/history等を市場別化 |
| ダッシュボード | apps/dashboard/src/main.tsx, PriceChart.tsx, SettingsPage.tsxほか | SUIラベル・9桁換算・source検査・単一状態を変更 |

重要な参照:
[共通型](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/packages/shared/src/index.ts) /
[Engine](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/apps/worker/src/engine.ts) /
[DB](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/packages/database/src/index.ts) /
[履歴DB](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/apps/worker/src/chart-history.ts) /
[Router](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/packages/dex-router/src/index.ts)。

### 6.1 データ混在リスク

売買Candleの主キーは(timeframe,timestamp,source)。sourceが異なれば即上書きではないが、取得は指定市場でなく時間足ごとの「最新source」を選ぶ。複数市場保存後に表示・取得対象が別市場へ変わる危険がある。

表示履歴DBのPRIMARY KEY(tf,ts)は同時刻の別市場で衝突する。取引・損益に必須pair列・検索条件がなく、portfolio/priceは共有キー。source文字列だけでは会計を分離できない。

## 7. PAPER対応可能性と推奨設計

現行PAPERはDeepBook板を消費する約定再現ではなく、Cetus見積りのminAmountOutを使う。DeepBook価格・板で検査しても、仮想約定経路は異なり得る。DeepBook専用PAPERを目指す場合は別の約定モデルが必要。

| 能力 | 現状 | 必要な構成 |
|---|---|---|
| 価格 | SUI固定 | Pool ID/Coin Typeを検証した市場別Provider |
| AI分析 | LLM未提供 | 市場・時間足・品質つき入力。最終売買許可はRiskEngine |
| PAPER | Cetus見積り方式 | 方式を一般化、またはDeepBook板方式を明示選択 |
| 数量・価格精度 | SUI/USDC固定 | atomic整数、decimals、lot/tick、min管理 |
| spread・流動性 | 検査あり | 注文量に応じた板消費、VWAP、部分約定、最大影響 |
| 損益 | 単一portfolio | 市場別数量・原価・費用・実現/未実現損益 |
| リスク | 共通設定 | 市場別注文額・保有率・損失・深さ・spread・鮮度 |
| 同時監視 | 単一Engine | 市場別状態と共有API・資金管理を分離 |

SUI建ては損益をまずSUIで管理し、USDC換算には時刻つきSUI/USDC価格が必要。初期はUSDC建てに限定する。

推奨するデータ構造:

- MarketSpec: network、Pool ID、Coin Type、SDKキー、Indexer名、decimals、min/lot/tick。
- MarketState: Candle、指標、証明、鮮度、分析、設定、停止理由。
- PortfolioLedger: 通貨別残高、市場別原価・損益、共有USDC予約台帳。
- Candleキー: network + poolId + timeframe + timestamp + sourceVersion。
- 注文・Fill・分析・risk・損益にmarketId必須。すべての検索にも指定。
- API予算とstatusを共有し、市場取得は時刻をずらす。
- 監視→分析→PAPERの順に市場別有効化。

## 8. API負荷・安全性

「通貨数」は監視ペア数。60秒周期、再試行・再構築なしの概算。現行DeepBook経路はstatus、板、3時間足=5要求/ペア/サイクル。一覧は5分キャッシュ、板はキャッシュなし、OHLCVは20秒キャッシュ。

| 項目 | 1ペア | 3ペア | 5ペア |
|---|---:|---:|---:|
| 現行相当Indexer要求/分 | 約5.2 | 約15.6 | 約26 |
| 同上/日 | 約7,488 | 約22,464 | 約37,440 |
| status・一覧共有構成/分 | 約5.2 | 約13.2 | 約21.2 |
| 通常フレーム最大保持 | 3,000足 | 9,000足 | 15,000足 |
| 7日×3時間足の理論本数 | 2,856足 | 8,568足 | 14,280足 |
| 毎分3,000足再保存時のupsert/日 | 約432万 | 約1,296万 | 約2,160万 |

upsertは処理回数で、増加行数ではない。Sui health、Cetus見積り、表示履歴、境界再確認は別枠。30秒周期では通常負荷は概ね倍。

- 公開Indexerの保証されたレート上限は未確認。表の量が許容されるとは断定できない。
- 再構築は最大8ページの1分足取得と欠落区間別trades照会を加え得る。
- 要求timeoutは8秒、transient retry最大2回。1要求に約24秒+backoffを使い得る。単純直列化は45秒取得期限や板10秒鮮度と衝突する。
- 最新足・板・最終成功・証明を市場別管理。他市場の成功で遅延を隠さない。
- 指標CPUは足数に概ね比例。CPU使用率、実メモリMB、DB待ちは未計測。
- 同期SQLiteと大量upsertには差分保存、短いtransaction、市場索引が必要。
- PAPER並行処理は共有USDC予約と約定確定を原子的に実施する。

ApiAccessはAPI名単位の待ち行列・backoffとグローバルcallbackを持つ。Engine追加だけではcallback上書きと停止範囲混乱の危険がある。

停止範囲:

1. 市場別: 板欠落、過大spread、薄い板、足欠落、異常価格、市場別損失。
2. 共有API: Indexer遅延、429、接続障害。
3. 全体緊急停止: 手動、会計照合不一致、全体損失。約定確定直前にも確認。

参照: [API制御](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/packages/shared/src/api.ts)、[監視](https://github.com/tajumaru/SuiBa/blob/9f05151dd9616caf95742f3b492857e84eb7f526/sui-ai-trading-bot/apps/worker/src/operations.ts)。

## 9. その他Mainnet候補

get_poolsは26プールを返した。対象9ペアと既存SUI/USDC以外は:

NS/SUI、IKA/USDC、SUI/USDSUI、USDSUI/USDC、SUI/SUIUSDE、SUIUSDE/USDC、WUSDC/USDC、WUSDT/USDC、USDT/USDC、SUI/AUSD、AUSD/USDC、TYPUS/SUI、DRF/SUI、ALKIMI/SUI、GR/USDC、GY/USDC。

この16ペアのうちtickerで24h出来高が正だったのはNS/SUI、IKA/USDC、SUI/USDSUI、USDSUI/USDC、SUI/SUIUSDE、SUIUSDE/USDC。残りは今回ゼロ。16ペアの板・7日履歴・現在手数料は未確認で、総合判定は保留。登録だけで売買可能とはしない。Pool ID/Coin Typeはリンク先一覧で取得できるが、この16ペアについて個別のSDK照合・転記は本調査対象外。

## 10. 追加順・変更規模・テスト・P0

### 10.1 最初の3通貨

1. WAL/USDC: SUIと同じ9 decimals、USDC会計維持。今回15分・1時間足に内部欠落なし。板深さで注文を制限する。
2. DEEP/USDC: 6 decimalsとlot/minimumを検証。USDC会計維持。ゼロ手数料仕様と現在値の照合が必要。
3. XBTC/USDC: 比較的良好な板。8 decimals、高単価、1 USDC tick、BTCと異なる識別を検証。5分足品質対策後に追加。

LZWBTC/USDCは次候補。板は良好だったが別資産識別と多数の5分足欠落への対応が必要。

### 10.2 変更規模と想定問題

中～大規模。Providerだけでなく、共通型、DB、会計、実行、監視、API、UIに及ぶ。工数・変更ファイル数の確定見積りは未実施。

想定問題は、履歴欠落による停止、ミリ秒/秒差、BETH名の不一致、lot端数、薄い板、CetusとDeepBookの経路差、費用未計上・二重計上、共有資金競合、複数Engineの状態上書き、同期DB処理による鮮度劣化。

### 10.3 必要なテスト

- 同時刻の異市場Candle保存・取得・表示、証明の異市場流用拒否。
- 6/8/9 decimals、atomic整数、lot/tick境界、最小数量、端数残高。
- 未確定足、範囲端、秒/ms、ページング、欠落・無約定証明、15分/1時間品質。
- 部分約定、VWAP、片側板、薄い板、広いspread、失効quote。
- 手数料の支払通貨・換算と二重計上防止、原価配賦、損益混在防止。
- 共有USDC同時予約、重複注文、再起動冪等性、照合不一致。
- 429/timeout/Indexer遅延の停止範囲、手動緊急停止後の約定拒否。
- SUI/USDC既存挙動、Profit Guard、安全停止、API/UIの回帰。

本報告書作成時はテスト・アプリ実行を行っていない。

### 10.4 実装前P0

1. 売買DB・表示DB・状態・取引・損益の市場識別子を必須化。
2. decimals、lot/tick、最小数量、端数の精度設計。
3. 履歴API単位・上限・未確定足・欠落証明・全時間足の品質契約。
4. Cetus方式かDeepBook板方式かを決定し、費用モデルを確定。
5. 共有資金予約、市場別停止、共有障害停止、全体緊急停止を分離。
6. 現在オンチェーンのbook parameter・Maker/Takerを確認。
7. 既存SUI/USDCの会計・Profit Guard・安全停止を回帰検証。

推奨する初期実装範囲はUSDC建て3ペアの状態・会計・リスク基盤まで。その検証後にSUI建て・低流動性ペアへ広げる。本報告書は実装を行わない。
