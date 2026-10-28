# Sui Paper Lab — Sui AI Trading Bot v1.0

SUI / Native USDC または WAL / Native USDC のMainnet市場データで、ルール戦略を検証する独立したPAPER専用Botです。**署名鍵の読込・署名・トランザクション構築・送信・実スワップは実装していません。** AI SDK・AI APIも使用しません。利益や24時間の安定運用は検証済みではありません。

[ProfitGuard](docs/PROFIT_GUARD.md)で、利確SELLの純利益とBUY前の想定往復コストを追加審査します。損切り・リスク削減は利益条件の対象外です。費用内訳と計算上の制約はリンク先を参照してください。

Windows 11 + Docker Desktopの手順、429の対応と検証結果は[API安定化・Docker運用 1.1](docs/API_DOCKER_V1_1.md)を参照してください。

[GeckoTerminal通信失敗の原因調査と24時間再テスト手順](docs/GECKO_TIMEOUT_INVESTIGATION.md)も参照してください。当時の通信障害の種類は未確定ですが、全通信例外をタイムアウト表示する誤分類を修正しました。

## 起動

Node.js 24.22.1 以降の 24 LTS / pnpm 9.12.3。プロジェクトディレクトリで実行します。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# 次のコマンドでトークンを生成し、.env の ADMIN_TOKEN に設定
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
pnpm build
pnpm dev
```

[管理画面](http://127.0.0.1:3100)を開き、管理トークンを入力します。トークンはブラウザのメモリにのみ保持し、再読込時には再入力します。`.env` はGit・Dockerビルド対象外です。初期仮想残高はペアごとに100 USDC / 基軸通貨0。Workerは停止状態で起動し、市場データを取得します。接続を確認してSettingsの「開始」を押すとPAPER売買を開始します。

パターンによるログイン・登録は、保存データから管理トークンを推測されるリスクのため停止しています。更新後のログイン画面は、同じブラウザ・同じオリジンに残った旧パターン登録と暗号化トークンを削除します。以前の画面を開いているタブは閉じてください。削除に失敗した場合は画面の案内に従ってサイトの保存データを削除してください。すでに持ち出された暗号文や別ブラウザ・別オリジンの保存データは無効化できません。漏洩が疑われる場合はWorkerの`ADMIN_TOKEN`を変更して再起動してください。

認証のブラウザ回帰テストは `node node_modules/playwright/cli.js test --config playwright.auth.config.ts` で実行できます（ChromiumとWebKitのインストールが必要）。iPhone設定のWebKitはSafari実機試験の代わりではありません。

```powershell
pnpm dashboard # 開発用Vite、/apiを3100へプロキシ
pnpm test
pnpm verify:runtime # 認証・3時間足取得・緊急停止の再起動後復元を確認
pnpm smoke     # 公開Mainnetへの読み取り専用疎通。実送信なし
pnpm backtest  # SQLiteに保存済みの5分足で検証、data/backtests/にJSON保存
docker compose -f docker/compose.yaml up --build -d
```

Docker DesktopのLinuxコンテナでビルド・Compose起動・再起動後の停止/緊急停止・SQLite履歴保持を検証済みです。Linux内の160件の回帰テストと実コンテナへのChromium接続も成功しました。検証範囲と再実行方法は[API安定化・Docker運用 1.1](docs/API_DOCKER_V1_1.md)を参照してください。Node組込みSQLiteを採用しており、Node 24では実験的APIの警告が出ます。Windows / OneDriveでのパッケージリンク問題を避けるためpnpmはhoisted方式です。

## 安全動作

- `MODE=PAPER` のみ。ほかの値は起動拒否。ウォレット接続UIや秘密鍵設定はありません。
- 管理APIはGETも含めBearer認証必須。32文字以上のトークンがないと起動拒否。初期bindは127.0.0.1、Docker公開もloopback限定。外部公開する場合はTLSと別途アクセス制御を用意してください。
- 初回・再起動時とも停止状態。緊急停止フラグ・異常理由・前回処理足・残高・平均取得費・設定はSQLiteに永続化します。異常後は「停止解除」、続いて「開始」の2操作で再開します。
- 同時処理は1件。注文IDはデータソース・時間足・確定足時刻・方向により固定。注文と約定と残高を `BEGIN IMMEDIATE` 内で保存し、一意制約で再処理を拒否します。APIから直接注文する機能はありません。
- 5 / 15 / 60分足すべてを検証。未確定足を除外し、欠損・重複・時刻ずれ・非数・OHLC不整合・30%超の価格ジャンプ・古いデータは拒否。必要な履歴がない場合も停止します。欠損を都合よく補間しません。
- 外部APIは試行ごと10秒タイムアウト。HTTP 429は即時PAPER停止し、Retry-Afterまたは指数バックオフ＋ジッターで最大2回再試行します。上限到達後は手動解除が必要で、復旧後もPAPERは自動再開しません。最終失敗、履歴データ障害、見積もり失敗、会計エラーは停止状態とrisk_eventsを保存します。生の外部エラーや認証情報はログに出しません。
- Coin TypeはSDKの正規化後に選択ペア（SUIまたはWAL / Native USDC）と完全一致で検証。名前の部分一致やブリッジUSDCの代用はしません。
- 最大注文5 USDC、UTC日次買付20 USDC、日次損失1%、スリッページ0.3%、保有比率20%。Settingsでは初期安全上限より厳しくできます。借入・空売り・レバレッジなし。日次損失到達後のBUYを止め、残高内のSELLは可能です。

## データと仮想約定の意味

履歴ソースは[GeckoTerminal Public API](https://apiguide.geckoterminal.com/)のSuiプールOHLCVです。対象2トークンをメタデータで照合し、24時間取引高が最大のペアを選択します。`MARKET_POOL`で固定も可能です。1プールの履歴であり、Sui DEX市場全体の統合足ではありません。`currency=token` とSUI側の `token` を指定し、価格はNative USDC建てで取得します。出典は各足に保存します。Public APIはBetaで、利用上限・提供範囲・可用性は保証されません。

見積もりは[Cetus公式Aggregator V3 SDK](https://github.com/CetusProtocol/aggregator)の `findRouters`（exact input）のみを使います。SUIまたはWALとUSDCの双方向に対応し、最適ルート選択はAggregatorに委ねます。Aftermath独自アダプターは未実装です。SDKには実行機能も含まれますが、このアプリから呼び出すのは見積もりだけです。

通常の見積もりはサービス側の約定保証・統一された有効期限を持ちません。**ローカルで取得開始から15秒を上限**とし、期限内でもオンチェーン約定できる保証とは扱いません。`validateQuote` は期限・流動性・数量・price impactを確認します。price impactは最新確定足との価格差の絶対値とSDKの `deviationRatio` の絶対値の最大値で、純粋なAMM価格影響を分離測定したものではありません。価格乖離も保守的に拒否します。

PAPERでは、見積もりの出力（ルート手数料と流動性影響を含む）からさらに最大スリッページを差し引いた最低受取量を約定量にします。追加で検証用手数料0.3%とガス0.03 USDCを徴収し、手数料の重複も許容する保守的モデルです。ガスはUSDC相当で課金するモデルであり、実際のガスコイン選択・dry-run・MEV・ネットワーク競争を再現しません。SDKが追加DEEP費用を報告したルートは、費用をモデル化できないため拒否します。**実約定可能性は証明していません。**

## 指標・戦略・バックテスト

EMAはSMAで初期化、RSI14とATR14はWilder平滑化。MACDはEMA12−EMA26 / signal EMA9。最低61本の確定足が必要です。EMA上昇・RSI売られすぎから回復・MACD histogram改善でBUY候補。逆条件でSELL候補。取得費基準の損切り2% / 利確4%を優先します。出来高変化率の絶対値が上限超ならWAIT。前の足または現在足の出来高がゼロの場合もWAITにします。

バックテストは保存済み5分足の前60%を調整用として分離し、後40%で評価します。実際のパラメータ学習処理はありません。テスト期間前の足は指標のウォームアップにのみ使用。判断の次の足の始値で執行し、その足の出来高は参照しません。前の足の出来高の0.1%を注文上限とし、固定impact 0.1%・最大スリッページ・手数料・ガスを課金します。**過去の実DEX見積もりは復元できないため、履歴約定はモデル推定です。**

損益・勝率・最大DD・profit factor・年率換算Sharpe（暗号資産365日、無リスク金利0）・約定数・手数料・完了した保有期間の平均・コスト控除Buy & Hold比較を出力します。含み損益を最終資産に含め、期末強制決済はしません。勝率とPFはSELL約定単位。損失がない場合PFはnull。未完了の保有時間は平均から除外。設定変更はbot_settingsに追記、検証ごとのパラメータと期間も結果JSONに保存します。短期の結果から収益性を結論づけないでください。

## モジュール

| モジュール      | 責務                                                     |
| --------------- | -------------------------------------------------------- |
| shared          | 共通型、Coin許可リスト、設定スキーマ、数量変換           |
| sui-client      | Mainnet gRPC読み取り、残高・decimals・取引情報、接続状態 |
| market-data     | 実ペア選定、3時間足の履歴足、外部応答・鮮度検証          |
| dex-router      | DexRouter共通契約、Cetus見積もりアダプター               |
| indicators      | 確定足の指標計算                                         |
| strategy-engine | TradingStrategy / TradingDecision、ルール戦略、登録機構  |
| risk-engine     | 実行から独立した注文可否の判定                           |
| paper-trading   | TradingExecutor、仮想約定と会計、バックテスト            |
| portfolio       | 時価評価、勝率・PF・DD                                   |
| database        | 全SQLiteアクセス、スキーマ、トランザクション             |
| worker          | データ→戦略→リスク→PAPER実行、認証管理API                |
| dashboard       | Overview / Chart / Strategy / History / Settings         |

依存は shared → 純粋計算・アダプター → database / worker の方向（表記は利用される順）です。UIはWorkerの型のみを参照し、サーバーコードをバンドルしません。将来のAIは `TradingStrategy` を実装してRegistryへ登録し、設定スキーマと選択UIを拡張します。DeepSeekのキー・SDK・通信コードはありません。`TradingExecutor` は現段階でPAPERのみを許可します。将来Liveを追加する際にこの契約を明示的に拡張し、別の実装と検証を追加する必要があります。

## DB / API

9つの指定テーブルを作成します。`market_candles`は時間足・時刻・ソースが複合主キー。その他のイベントテーブルはID・時刻・JSON payloadで保存し、`bot_runtime_state`はキー・JSONの状態ストアです。起動時は `CREATE IF NOT EXISTS` を適用。将来の破壊的スキーマ変更用マイグレーションは別途必要です。DBとWAL/SHMは `data/` 配下に置き、ボット停止後にまとめてバックアップします。

| API                | 用途                                                      |
| ------------------ | --------------------------------------------------------- |
| GET /api/state     | 市場、PAPER残高、判断、履歴、設定、接続状態               |
| GET /api/balances  | READ_ONLY_ADDRESSのMainnet残高（仮想残高とは別）          |
| POST /api/control  | `{ "command": "start" / "stop" / "emergency" / "reset" }` |
| POST /api/settings | 全設定オブジェクトの検証・保存・履歴追記                  |

## 公式資料の確認先

- [Sui SDK gRPC](https://sdk.mystenlabs.com/sui/clients/grpc) / インストールされたSDKの `docs/llms-index.md` と `docs/clients/querying.md`
- [Cetus Aggregator getting started](https://cetus-1.gitbook.io/cetus-developer-docs/developer/cetus-aggregator/getting-started)
- [Cetus機能と入力](https://cetus-1.gitbook.io/cetus-developer-docs/developer/cetus-aggregator/features-available)
- [GeckoTerminal API仕様](https://api.geckoterminal.com/docs/index.html)
- [OHLCV引数の公式説明](https://docs.coingecko.com/reference/pool-ohlcv-contract-address)

実装時の固定バージョンはpnpm-lock.yaml参照。Cetus / GeckoTerminalは外部サービスであり、公開API利用の将来の継続・商用条件・SLAを保証しません。専用認証や契約が必要になった場合は、その条件を確認してからアダプターを更新してください。

Profit Guardは初期状態で有効です（最低純利益0.05 USDC・最低利益率1%）。Settingsで変更できます。計算・制約は[設計資料](docs/PROFIT_GUARD.md)を参照してください。

DeepBookの実測、Provider設定、品質条件と検証結果は[DeepBook Provider検証](docs/DEEPBOOK_PROVIDER_VALIDATION.md)を参照してください。既定の取得元はGeckoTerminalのままです。

## DeepBook 24時間PAPER検証専用環境

既存環境と分離したCompose・計測・日本語ダッシュボード・JSON/Markdownレポートを利用できます。[Windows 11の起動・停止・確認・バックアップ手順](docs/DEEPBOOK_24H_PAPER.md)を参照してください。24時間未満は「検証途中」で、PAPERの開始・異常後の再開は手動です。標準Providerは変更しません。

## Windows無人検証ツール（passive preflightの長時間監視）

隔離済み passive preflight（`docker/compose.preflight-30m.yaml`、PAPER・`running=false` の受動的観測）を、Windows 11で .bat のダブルクリックだけで30分／2時間／6時間／24時間実行し、Markdown・JSON・CSVレポートを自動生成するツールが [tools/windows-verification](tools/windows-verification/README.md) にあります。AIエージェント不要で、異常時は検証専用コンテナだけを安全停止します。

DeepBookの取得周期・安全監視のP0修正と、既存検証を保持したままポート3102で再実行する手順は [DeepBook P0修正](docs/DEEPBOOK_P0_SCHEDULER.md) を参照してください。


## SUI/USDC・WAL/USDCの選択

画面上部の「取引ペア」で、停止中に1ペアを選択します。取得処理・長時間のAPI処理・バックテストの実行中やレート制限待機中は切り替えられません。切替元または切替先に未決済数量・残原価・未処理注文／候補がある場合も切替を拒否します。自動決済・取消・残高削除は行いません。切替後と再起動後は停止状態を維持し、PAPER開始は手動操作が必要です。他のブラウザタブで古いペアを操作した場合は再読込します。

SUIの既存DBパスは変更しません。WALは`DATABASE_PATH + ".WAL_USDC.sqlite"`、選択状態は`DATABASE_PATH + ".pairs.sqlite"`、チャート履歴もペア別です。仮想資金・ポジション・注文・分析履歴・損益・リスク設定・運用検証は独立しています。既存の内部フィールド名`portfolio.sui`は選択ペアの基軸通貨数量を格納し、`baseCoin`で資産を識別します。

WALはDeepBookのみを使用し、SUIのGeckoTerminal市場にはフォールバックしません。分析取得はSUIが直近1,000本、WALが直近300本（5分足では約25時間）です。両者とも最低61本、未解決欠損ゼロ、既存の鮮度・板厚・スプレッド・再構築上限を適用します。長い過去履歴は表示専用取得を利用します。

`TRADING_PAIR=WAL_USDC`で起動ペアを指定できます。この環境変数を設定した場合は再起動時も環境変数が優先されます。UI選択を復元する運用では未設定にします。

調査結果・公式情報・既知の制約・30分／2時間のPAPER検証手順は[WAL対応検証計画](docs/WAL_USDC_IMPLEMENTATION_JA.md)を参照してください。
