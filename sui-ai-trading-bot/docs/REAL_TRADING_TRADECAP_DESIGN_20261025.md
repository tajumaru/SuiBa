# REAL（実売買）モード設計書 ― DeepBook v3 TradeCap 委任方式

- 作成日：2026-10-25
- ステータス：設計のみ（未実装）。本書は田嶋の「方式2（TradeCap 委任）で進める」決定に基づく
- 対象：`sui-ai-trading-bot`（Worker ＋ React ダッシュボード、SQLite、Sui / DeepBook v3）

---

## 1. 目的・前提

### 1.1 目的

現行 PAPER（仮想売買）専用の SuiBa に、DeepBook v3 の `TradeCap` 委任を用いた REAL（実売買）執行経路を追加する。資金は田嶋のウォレット配下の `BalanceManager` に置き、Bot には「売買のみ・出金不可」の権限（TradeCap）だけを渡すことで、サーバー側に資金そのものを置かない構成を取る。

### 1.2 前提（不変条件）

1. **PAPER が既定**。REAL は明示的なオプトイン（設定＋起動時確認）でのみ有効化される。PAPER の挙動・記録・検証フローは一切変えない。
2. **鍵の所在**：田嶋のオーナーウォレットの鍵はダッシュボード（ブラウザ）から先に出ない。Worker が保持するのは Bot アドレスの鍵のみ（後述。TradeCap 方式でも Bot アドレスは必須）。
3. **モード表示の誠実性**：現行 UI には「PAPER（仮想売買）専用」「実売買は行いません」等の文言がある（§8.3 に箇所一覧）。REAL 有効時はこれらをモードに応じた正確な文言に切り替え、PAPER の記録と REAL の記録が混同される表示をしない。
4. **フェイルクローズ**：REAL 経路で状態が不明な場合は「取引しない」側に倒す。既存の安全ゲート（通信異常・データ陳腐化での停止）の思想を REAL にもそのまま適用する。
5. **金額の既定値は本書で決めない**。上限額・投入額などの数値は §11 の「要判断」に集約し、田嶋が決める。

### 1.3 用語

| 用語 | 意味 |
|---|---|
| BalanceManager (BM) | DeepBook v3 の共有オブジェクト。取引資金を保持し、全プール共通で使える |
| TradeCap | BM に対する「売買のみ」権限オブジェクト。発行・移転・失効が可能（§2） |
| TradeProof | 発注時に必要な一時証明。オーナーは `generate_proof_as_owner`、TradeCap 保有者は `generate_proof_as_trader` で生成 |
| Bot アドレス | Worker が鍵を保持する小さなウォレット。TradeCap の保有先であり、取引 tx の署名者 |
| オーナー | 田嶋のウォレット。BM の所有者。入金・出金・Cap 発行・Cap 失効の権限を持つ |
| 執行アダプタ | 戦略・リスク層の後段で注文を実際に執行する部品。PAPER / REAL(TradeCap) / 将来の REAL(Bot資金) を差し替える境界（§5.1、§9） |

---

## 2. 調査結果（公式仕様の裏取り）

### 2.1 TradeCap の発行・移転・proof

- BM のオーナーのみが `mint_trade_cap` を呼べる（Move 側で `validate_owner` を強制）。発行された TradeCap は別のアドレスへ移転でき、受け取ったアドレスはその BM で注文を出せるが、**入金・出金はできない**。
- 発注時は `generate_proof_as_trader(balance_manager, trade_cap, ctx)` で TradeProof を生成して Pool に渡す。TS SDK では DeepBookClient の設定に `balanceManagers: { KEY: { address, tradeCap}}` を与えると、発注系メソッドが proof 生成を内部で行う。
- Cap の総数上限は BM あたり 1,000（TradeCap／DepositCap／WithdrawCap の合計）。
- 注意点（公式ドキュメント明記）：TradeCap は owned object のため、proof 生成には **equivocation（同一オブジェクト版数の競合）リスク** がある。単一プロセス・直列実行であれば回避可能であり、本設計では REAL の tx 送信を単一キューで直列化する（§6.4）。

### 2.2 失効（kill switch）― 結論：オーナーがいつでも失効できる

- Move に `revoke_trade_cap(balance_manager, trade_cap_id: &ID, ctx)` が存在し、**オーナーのみ**呼べる。BM の `allow_listed` から対象 Cap の ID を除去する。以後、その Cap での `generate_proof_as_trader` は `validate_trader` で失敗し、発注できなくなる。
- TS SDK にも `balanceManager.revokeTradeCap(managerKey, tradeCapId)` ヘルパーがある。
- つまり本方式の kill switch は二段構えにできる：
1. **Cap 失効**（`revoke_trade_cap`）：Bot の売買権限だけを即時に剥がす。資金は BM に残る。
2. **資金退避**（オーナーが BM から全額出金）：失効と併せて行えば、万一 Cap が残っていても掴む資金がない。
- 失効はオーナー署名の tx で行うため、ダッシュボード（dapp-kit 経由）またはウォレットアプリ単体でも実行できる。**Worker の生死に依存しない**点が重要（Worker が暴走・停止不能でもオーナー側で止められる）。

### 2.3 プールと手数料

- プールキー（SDK 既定）：mainnet は `SUI_USDC`（quote はネイティブ USDC `0xdba3…::usdc::USDC`）。**testnet にネイティブ USDC はなく**、SDK 既定の testnet プールは `SUI_DBUSDC`（quote はテスト用 DBUSDC）。Phase 1（testnet 一巡）は SUI/DBUSDC で行う設計とする（§10）。
- 手数料は注文ごとに `pay_with_deep` フラグ（SDK では `payWithDeep`、既定 true）で支払い資産を選べる：
- DEEP 払い（既定）：手数料は DEEP 建て。BM に DEEP 残高が必要。
- **入力資産払い（`payWithDeep: false`）も可能**で、その場合の手数料は DEEP 建て比で **+25%**（FEE_PENALTY_MULTIPLIER）。
- したがって DEEP の保有は必須ではない。少額運用では「DEEP を別途用意しない代わりに入力資産で +25% を払う」か「少量の DEEP を BM に常備するか」は運用判断（§11 要判断）。
- 実際の taker/maker レートはプールの `poolTradeParams` で取得できるため、ProfitGuard のコスト計算は固定値（現行 PAPER の `feeRate` 既定 0.003）ではなくプール実値＋ガス実績で置き換える（§5.4）。

### 2.4 Bot アドレスのガス

- TradeCap 方式でも、取引 tx の署名者は Bot アドレスであり、ガスは **Bot アドレス自身の SUI** から払う（公式のマーケットメイカー例でも Bot 側 keypair が `signAndExecuteTransaction` する構成）。
- BM 内の SUI は取引資金であり、ガスには使われない。ガス用 SUI は Bot ウォレットに少額を常備し、残高監視と不足時のフェイルクローズ（発注停止＋運用画面への表示）を設計に含める（§7.4）。
- スポンサード tx は前提にしない（複雑さに見合わない）。

### 2.5 既存リポジトリの現状（差し込み箇所の特定）

| 対象 | 現状 | REAL 化での扱い |
|---|---|---|
| 注文執行 | `apps/worker/src/engine.ts` の `BotEngine` が `private paper = new PaperTrading()` を**直に保持**し、約定計算 `this.paper.fill(...)`（engine.ts:559）を同期的に呼ぶ。`TradingExecutor` インターフェースは `packages/paper-trading/src/index.ts` に定義（`mode: "PAPER"` リテラル、同期・純関数） | REAL は非同期・オンチェーン状態依存のため、この interface には乗らない。§5.1 の執行アダプタ抽象を新設し、PAPER は既存経路をそのままアダプタ内に包む |
| 候補・監査 | 執行前に `db.putCandidate(audit)` で候補（ProfitGuard 評価・リスク評価）を記録する仕組みが既にある（engine.ts:281〜） | REAL でも同一の候補記録を前段に使う。執行段だけが変わる |
| 安全ゲート | サイクル冒頭で `monitor.ordersAllowed()`／`runtime.running`／`runtime.emergency`／`runtime.error` を検査し `SAFETY_GATE` で打ち切る（engine.ts:255〜266） | REAL ではサイクル冒頭に加え、**署名前の最終チェック**としても同じ条件を再検査する（§7.2） |
| クォート | `packages/dex-router/src/index.ts` の `CetusRouter`（`DexRouter`）が PAPER の価格付けに使われる。市場データ読み取りは `packages/market-data/src/deepbook.ts` の `DeepBookMarketData`（Indexer の orderbook 等） | REAL の執行価格・スリッページ保護は DeepBook プール自身の状態（板・mid・`getQuoteQuantityOut` 相当）から取る。Cetus クォートは PAPER 専用のまま |
| 記録 | `packages/database/src/index.ts` の `BotDatabase`。汎用 JSON テーブル `paper_orders`／`paper_trades`／`paper_checks` に id キーで格納し、`commitFill` がトランザクションで確定する | REAL は新規テーブル `real_orders`／`real_trades` を分ける（§8.1）。`commitFill` 相当の確定処理も REAL 用を別に作る |
| 注文 id | PAPER は `paper:{source}:300:{candleTimestamp}:{side}`（engine.ts:278） | REAL は `real:{network}:{candleTimestamp}:{side}:{nonce}` 形式とし、tx digest とは別に内部相関 id を持つ（§6.2） |
| 設定 | `packages/shared/src/index.ts` の `settingsSchema`（zod `.strict()`、line 234〜）と `defaults`。PAPER 上限は既に小さい（`maxOrder` ≤ 5 USDC、`dailyBuyLimit` ≤ 20 等） | REAL 設定は Settings に混ぜず、独立した `realTradingSchema` を shared に追加し、DB の別キーで保持する（§5.3） |
| Worker 配線 | `apps/worker/src/index.ts` が `new BotEngine(db, MarketSelection, new CetusRouter(), ReadOnlySuiClient)` を構築。各種設定は環境変数（`DATABASE_PATH`、`SUI_GRPC_URL` 等） | Bot 鍵も環境変数パターンに倣う（§5.2）。ただし鍵はログ・スナップショット・API に絶対に含めない |
| Sui クライアント | `packages/sui-client` の `ReadOnlySuiClient`（`@mysten/sui` の `SuiGrpcClient`＋gRPC-Web fetch トランスポート） | DeepBook SDK の公式例も `SuiGrpcClient` ＋ `$extend(deepbook(...))` であり互換。署名・実行には書き込み可能なクライアントを Worker 内に別途持つ |
| モード表示 | `apps/worker/src/operations.ts` に `mode: "PAPER"` リテラルが複数箇所（167/229/243/263/987 行付近） | スナップショットの mode を実モードから導出するよう変更が必要（§8.3） |

---

## 3. 全体アーキテクチャ

```
┌──────────────────────── 田嶋のブラウザ ────────────────────────┐
│ ダッシュボード (React) │
│ ├─ @mysten/dapp-kit でオーナーウォレット接続 │
│ ├─ オーナー操作（全てオーナー署名）: │
│ │ BM 作成 / 入金 / 出金 / TradeCap 発行・移転 / Cap 失効 │
│ └─ 表示：PAPER / REAL モード、BM 残高、Bot ガス残高、REAL 注文 │
└──────────────┬───────────────────────────────▲─────────────────┘
│ Worker API（読み取り＋制御） │ オンチェーン
┌──────────────▼──────────────────────────────────────────────────┐
│ Worker (Bot) │
│ 戦略 → 候補記録 → ProfitGuard / リスク → 安全ゲート │
│ │ │
│ 執行アダプタ (ExecutionAdapter) │
│ ├─ PaperAdapter（現行 PaperTrading を包む） │
│ ├─ RealTradeCapAdapter（本設計の主軸） │
│ └─ RealBotWalletAdapter（将来用・§9、初期は無効）│
│ │ 署名・送信 │
│ Bot アドレス（鍵は Worker のみ）: TradeCap 保有 + ガス用 SUI │
└──────────────┬──────────────────────────────────────────────────┘
│ Sui チェーン / DeepBook v3
BalanceManager（資金：田嶋） ── Pool SUI_USDC
```

要点：

- **資金の置き場は常にオーナー配下**（BM）。Worker は資金を「持たない」。Worker が持つのは TradeCap（権限オブジェクト）と Bot 鍵とガス用 SUI だけ。
- **戦略・判定・監査の前段は PAPER と共通**。分岐は執行段のみ。これにより「PAPER で検証した判断がそのまま REAL の判断になる」ことが構造で担保される。
- ダッシュボードは **オーナー操作の実行者** であり、Worker はオーナー操作（入金・失効等）を一切代行しない。Worker API 経由で鍵や署名を扱う経路は作らない。

---

## 4. オーナー側フロー（ダッシュボード＋dapp-kit）

新規に `@mysten/dapp-kit`（＋ `@mysten/sui` は既存）をダッシュボードへ導入し、「REAL 設定」画面（運用検証タブ配下を想定、§11 要判断）を設ける。

### 4.1 初期セットアップ（一度だけ）

1. ウォレット接続（dapp-kit の ConnectButton 相当）。
2. BalanceManager 作成：`createAndShareBalanceManager` をオーナー署名で実行し、生成された BM オブジェクト ID を記録する。
3. 入金：取引資金（USDC、必要なら SUI と DEEP）を BM へ `deposit`（オーナーのみ可能）。
4. TradeCap 発行と Bot への移転：`mint_trade_cap` で Cap を発行し、Bot アドレスへ移転する。同一 PTB 内で発行＋`transferObjects` まで完結させるのが望ましいが、SDK ヘルパー（`mintTradeCap`）の返却形によっては「発行 tx → 移転 tx」の 2 段になる。実装時に SDK の挙動を確認して決める（§11）。
5. Worker 側に BM ID と TradeCap ID を登録（§5.3 の REAL 設定）。Worker は起動時にオンチェーンで次を検証し、1 つでも崩れていたら REAL を有効化しない（フェイルクローズ）：
- BM の `owner` が登録済みオーナーアドレスと一致する
- TradeCap が Bot アドレスに存在し、その Cap が当該 BM のものである
- Cap が失効していない（proof 生成の devInspect 相当で検証可能）

### 4.2 日常のオーナー操作

| 操作 | 実行者 | 備考 |
|---|---|---|
| 入金・出金 | オーナー（ダッシュボード署名） | 出金はいつでも可能。出金すると Bot は残高不足で自然に止まる |
| Cap 失効 | オーナー（ダッシュボード署名、またはウォレット単体） | §2.2。緊急時の第一手 |
| Cap 再発行 | オーナー | 失効後に再開する場合。古い Cap ID は REAL 設定から除去する |
| Bot へガス補充 | オーナー（通常送金） | Bot アドレス宛に SUI を送るだけ |

---

## 5. Worker 側設計

### 5.1 執行アダプタ抽象（差し込み口）

現行 `BotEngine` は `PaperTrading` を直に保持している（§2.5）。次の抽象を新設する：

```ts
// 概念定義（実装時の型設計の指針）
interface ExecutionAdapter {
readonly kind: "PAPER" | "REAL_TRADECAP" | "REAL_BOT_WALLET";
// 候補（監査記録済み）を受け取り、執行結果を返す。REAL 系は非同期。
execute(intent: ExecutionIntent): Promise<ExecutionResult>;
// 緊急停止時：未約定注文の一括キャンセル
cancelAllOpenOrders(reason: string): Promise<CancelResult>;
// 照合用：オンチェーンの現在状態（残高・未約定）を取得
fetchOnchainState(): Promise<AdapterOnchainState>;
}
```

- `engine.ts` の変更は「`this.paper.fill(...)` 呼び出し地点を、現在の同期 PAPER 経路を含むアダプタ呼び出しへ置き換える」一点に絞る。候補生成・ProfitGuard・安全ゲート等の前段ロジックには手を入れない。
- PAPER の約定後照合（`reconcileFill`、`db.commitFill`）は PaperAdapter 側に寄せ、REAL は §6 の専用ライフサイクルで照合する。
- アダプタの選択は Worker 起動時に REAL 設定（§5.3）から決まる。**実行中の動的切替はしない**（モード変更は Worker 再起動を伴う運用手順とする）。これにより「いま走っているのが PAPER か REAL か」がプロセス単位で一意になる。

### 5.2 Bot 鍵の管理

- Bot 鍵は環境変数（例：`SUIBA_BOT_PRIVATE_KEY`、`suiprivkey1…` 形式）で Worker にだけ渡す。既存の環境変数パターンに倣うが、次を必須とする：
- ログ、スナップショット、運用 API、DB、例外メッセージに鍵（およびその断片）を含めない。起動時検証のログは Bot アドレスのみ出す。
- `.env` ファイルを使う場合は権限 600 とし、リポジトリに含めない（`.gitignore` 確認を実装チェックリストに入れる）。
- 鍵の生成は田嶋がウォレットアプリ等で行い、Bot アドレスをダッシュボードの REAL 設定画面に登録する（Worker が鍵を生成・表示する UI は作らない）。

### 5.3 REAL 設定スキーマ（shared への追加案）

`settingsSchema`（PAPER 用）とは分離し、shared に独立スキーマを追加。DB には別キー（例：`real_config`）で保持する。

```ts
// 案（金額系フィールドの既定値は §11 の要判断のため、ここでは型と上限だけ示す）
realTradingSchema = z.object({
enabled: z.boolean(), // 既定 false（オプトイン）
network: z.enum(["testnet", "mainnet"]),
executionSource: z.literal("TRADECAP"), // 将来 "BOT_WALLET" を追加（§9）
ownerAddress: SuiAddress,
balanceManagerId: ObjectId,
tradeCapId: ObjectId,
botAddress: SuiAddress,
poolKey: z.enum(["SUI_DBUSDC", "SUI_USDC"]), // network と整合させる
maxOrderUsdc: Decimal上限つき, // REAL 専用・1回の上限（値は要判断）
dailyRealLimitUsdc: Decimal上限つき, // REAL 専用・1日の上限（値は要判断）
payWithDeep: z.boolean(), // 手数料の支払い資産（§2.3、要判断）
minBotGasSui: Decimal, // ガス不足とみなす閾値（値は要判断）
}).strict()
```

- REAL 上限は PAPER の `maxOrder`／`dailyBuyLimit` とは**独立**に効かせる（REAL の実績を PAPER の上限消費に数えない、逆も同じ）。
- スキーマ側には暴走防止の**絶対上限（ハードキャップ）** を入れることを推奨する。具体値は §11 要判断だが、「設定ミスで桁を間えても壊滅しない」ための天井は設計として入れる。
- `enabled: true` への変更は、ダッシュボードの通常の設定保存フローとは別に、**確認ステップ付きの専用操作**にする（§8.3）。

### 5.4 コスト計算（ProfitGuard 連携）

- REAL の ProfitGuard は、現行 PAPER の想定コスト（`feeRate`、`gasUsdc` の固定値）ではなく：
- プール手数料：`poolTradeParams` の実レート × `payWithDeep` の別（入力資産払いは +25%）
- ガス：直近の実績ガス（SUI 建て）× SUI/USDC レート
で見積もる。見積もり不能な場合は候補を棄却する（フェイルクローズ）。
- 戦略・ProfitGuard の判定ロジック自体は PAPER と共通のものをそのまま使う。

### 5.5 DeepBook SDK 依存

- Worker に `@mysten/deepbook-v3` を追加する（バージョンは実装時に固定し、pnpm-lock に記録）。既存の `@mysten/sui`（2.37.0、`SuiGrpcClient`）へ `$extend(deepbook({ address: botAddress, balanceManagers: {...}}))` する構成は公式例と同一であり、既存の gRPC 読み取り経路とは別クライアントとして持つ。
- 読み取り専用の `DeepBookMarketData`（Indexer 経由）は現行のまま市場データ用に残す。REAL の状態取得（残高・未約定）は SDK の devInspect 系（`checkManagerBalance`、`accountOpenOrders` 等）を使う。

---

## 6. 注文ライフサイクル（REAL）

### 6.1 状態機械

```
INTENT（候補・監査記録済み）
→ PREFLIGHT（上限・残高・ガス・陳腐化・緊急停止フラグの最終検査）
→ SUBMITTING（tx 構築・署名・送信。digest を即時記録）
→ SUBMITTED（finality 待ち）
→ CONFIRMED（tx 成功。イベント解析：OrderFilled / 配置のみ）
→ OPEN（未約定が残っている場合）
→ FILLED / PARTIAL→FILLED / CANCELED（終端）
異常系：REJECTED（チェーン側失敗） / UNKNOWN（応答喪失）→ RECONCILING → いずれかの終端 or HALTED
```

### 6.2 発注

- 注文種別：当面は**成行相当の即時執行**を基本とする。現行戦略は「その足で約定する」前提の PAPER fill と意味を揃えるため、SDK の `placeMarketOrder`、または価格上限付き指値（IOC）を用いる。どちらにするかは Phase 1 で約定性とスリッページ実績を見て決める（§11）。
- 価格保護：市場価格（DeepBook 板の mid / 直近約定）から現行 `maxSlippage` を超える約定が見込まれる場合は発注しない。指値を使う場合は価格リミットに同条件を埋め込む。
- 送信前に内部注文レコードを `SUBMITTING` で DB に書き、送信直後に **tx digest** を必須記録する。digest のない REAL 注文は「存在しない」扱いにせず、§6.5 の照合対象にする。

### 6.3 約定確認

- `signAndExecuteTransaction` の結果＋ finality 取得後に effects とイベントを解析する：
- 約定数量・約定価格は OrderFilled 系イベントと BM 残高差分（`checkManagerBalance`）の双方で突き合わせ、一致しない場合は RECONCILING に入れる。
- 約定価格・数量・手数料の実績を `real_trades` に記録する（§8.1）。PAPER の `Fill` 型（orderId/side/quantity/price/fee/pnl…）に相当する項目＋ digest ＋ onchain の order_id を持つ。

### 6.4 直列化（equivocation 回避）

- BM は共有オブジェクト、TradeCap は Bot の owned object であり、並行 tx は版数競合を起こしうる。RealTradeCapAdapter は**送信キューを 1 本**にし、前の tx の finality 確認が終わるまで次の tx を送らない。戦略サイクル（現行 60 秒間隔）とは独立に、キュー滞留時は新規候補を棄却する。

### 6.5 照合（通信異常・約定不明時）

Sui の tx は原子的であり、「送信したのに結果が分からない」のは主に**応答喪失**の場合である。手順：

1. digest が記録済みなら `getTransactionBlock(digest)` で確定状態を取得し、状態機械を進める。
2. digest が不明（送信直後のクラッシュ等）なら、オンチェーンの未約定一覧（`accountOpenOrders`）と BM 残高を DB の未終端レコードと突き合わせ、差分が説明できる範囲で状態を復元する。
3. 説明できない差分がある場合は **REAL を HALTED**（新規発注停止、要手動確認）にし、運用画面に事象を表示する。推測で DB を書き換えない。
4. サイクル毎の定期照合：DB 上の保有量・現金相当と BM 残高（SUI/USDC/DEEP）を比較し、不一致なら HALTED。PAPER の `reconcileFill` 思想のオンチェーン版。

### 6.6 キャンセル

- 個別キャンセル：`cancelOrder`（onchain order_id 指定）。
- 一括キャンセル：`cancelAllOrders`（プール＋BM 指定）。緊急停止時（§7.2）と Worker 終了時に呼ぶ。
- キャンセルも tx であり digest を記録する。キャンセル失敗（通信異常等）はリトライし、最終的に失敗したら「未約定が残っている可能性」を運用画面に明示する。

---

## 7. 安全設計

### 7.1 REAL 専用上限（多層）

1. **オンチェーン側の上限**：BM に入っている金額そのものが絶対上限。少額から始める運用とセット。
2. **設定上限**：1 回の注文上限 `maxOrderUsdc` と 1 日の累計上限 `dailyRealLimitUsdc`（§5.3）。PAPER の上限とは独立に集計する。
3. **スキーマのハードキャップ**：設定値自体の天井（§5.3、値は要判断）。
4. **既存の安全弁**：ProfitGuard（§5.4）、日次損失ガード（`dailyLossPct` 相当を REAL 残高ベースで評価）、最大保有比率（`maxHoldingRatio` 相当を BM 残高ベースで評価）。これらの「対象残高」が PAPER の仮想ポートフォリオから BM 実残高に変わる点を実装時に明示する。

### 7.2 緊急停止時の実注文の扱い

- 既存の緊急停止（`runtime.emergency`）は REAL でも最優先で効かせる：
1. 新規発注の即時停止（サイクル冒頭ゲート＋署名前チェックの二重化、§2.5）。
2. **未約定注文の一括キャンセル**（§6.6）をアダプタに指示する。結果（成功／失敗／対象件数）を監査記録と運用画面に残す。
3. 緊急停止の解除は従来通り手動操作のみ。解除しても REAL が自動で再有効化されることはない（REAL 設定の `enabled` と緊急停止は別軸とし、両方そろって初めて発注できる）。

### 7.3 通信異常時

- 市場データの陳腐化・gRPC 異常は現行の安全停止（判断を止める）に連動し、REAL の新規発注も止まる。
- 送信系の異常は §6.5 の照合手順に従う。「送れたか分からない注文」を抱えたまま次の注文を出すことはしない（直列化キューの停止条件に含める）。

### 7.4 Bot ガス枯渇

- サイクル毎に Bot アドレスの SUI 残高を確認し、閾値（§5.3 `minBotGasSui`）未満なら REAL 発注を停止して運用画面に表示する。ガス不足で tx が失敗し続ける状態を作らない。
- ガス補充はオーナーの通常送金のみ（§4.2）。Worker は補充を代行しない。

### 7.5 TradeCap 失効・資金退避ランブック（オーナー用手順）

異常時（Worker の想定外挙動、鍵漏洩の疑い等）は次の順で止める。**1〜2 は Worker が死んでいても実行できる**：

1. ウォレット（またはダッシュボード）から `revoke_trade_cap` を実行し、Bot の売買権限を剥がす。
2. BM の未約定注文をオーナー権限でキャンセルする（オーナーは proof を自分で生成できる）。
3. BM から全額をウォレットへ出金する。
4. Bot アドレスの鍵が漏れた疑いがある場合は、その鍵を廃棄し、新アドレス＋新 Cap で再構成する（旧アドレスの SUI 残高は回収可能なら移す）。

ダッシュボードの REAL 設定画面には、この手順への導線（失効ボタン＝オーナー署名 tx の発行）を持たせる。

---

## 8. 監査・記録・表示

### 8.1 記録の分離

- 新規テーブル **`real_orders`／`real_trades`**（既存の汎用 JSON テーブル方式に倣う）を追加し、PAPER の `paper_orders`／`paper_trades` とは物理的に分ける。集計クエリが PAPER と REAL を合算してしまう経路を作らない。
- REAL 注文レコードの必須項目：内部注文 id、候補 id（既存 audit との相関）、アダプタ種別（`TRADECAP`／将来の `BOT_WALLET`）、network、プール、side、数量・価格（要求値と約定実績の両方）、**全 tx の digest**（発注・キャンセル・照合で発生したもの）、onchain order_id、状態（§6.1）、手数料実績（資産と額）、ガス実績（SUI）、ProfitGuard 評価の写し、エラーコード。
- 候補・判断の記録（`putCandidate` の監査）は PAPER/REAL 共通の前段として残し、「なぜその注文を出そうとしたか」はモードに依らず追えるようにする。執行結果だけがモード別テーブルに分かれる。

### 8.2 履歴・実況での表示区別

- 取引履歴：REAL の行には「REAL」バッジと tx digest（Suiscan 等へのリンク）を表示する。PAPER の行には従来通り PAPER 表示。フィルタでモード別に絞れるようにする。
- 実況（エージェント実況）：REAL の約定は文面でも区別する（例：「実際に買ったよ（REAL）」相当の明示）。PAPER の約定で「買った」とだけ言う現行文面と混同させない。実況の数値は従来通り記録に基づくものだけを使う原則を REAL にも適用する。
- 成績集計（宣言の成績表・振り返り等）：PAPER と REAL を合算しない。REAL の成績は独立した集計として扱う（実装範囲は §11 要判断）。

### 8.3 モード表示の方針（文言の矛盾解消）

現行の PAPER 前提文言と、その扱い：

| 箇所 | 現行 | REAL 有効時の方針 |
|---|---|---|
| ヘッダーバッジ（`apps/dashboard/src/main.tsx:339`） | 「PAPER（仮想売買）専用」 | モード連動にする。PAPER 時は現行文言。REAL 有効時は「REAL（実売買）モード」等の警告色バッジに切替 |
| 実況の注記（`apps/dashboard/src/AgentNarration.tsx:317`） | 「表示はPAPER（仮想売買）の記録で、実売買は行いません」 | モードに応じて文面を出し分ける。REAL 時は「実売買の記録を含みます」旨の正確な注記にする |
| バックテスト比較（`BacktestComparison.tsx:266`） | 「PAPER（仮想売買）専用」 | バックテスト自体は常に PAPER 相当なので文言は維持（REAL の実績とは無関係である旨は現行通りで正しい） |
| Worker スナップショット（`apps/worker/src/operations.ts` の `mode: "PAPER"` リテラル群） | 固定で PAPER | 実モード（アダプタ種別＋network）から導出して返すよう変更する |

- REAL の有効化・無効化は、通常の設定保存とは別の**専用操作＋確認表示**（対象 BM・Bot アドレス・上限額の読み合わせ）とする（§5.3）。
- REAL 有効中は、ダッシュボードの全タブで現在のモードが一目で分かる状態を維持する（バッジ常駐）。「実は REAL だった」に気づけない UI にしない。

---

## 9. 組み合わせ構成：Bot 専用ウォレット（方式1）との関係

田嶋からの追加質問「方式1（Bot 専用ウォレット）も組み合わせできるか」への設計回答。

### 9.1 TradeCap 方式でも Bot ウォレットは必須（＝自然な組み合わせ）

TradeCap は「オブジェクト」であり、誰かが保有し、その保有アドレスの鍵で tx に署名しなければ使えない。したがって本方式でも Worker が鍵を保持する Bot アドレスは必須であり、その保有物は次の 2 つに限られる：

- **TradeCap オブジェクト**（BM への売買権限）
- **ガス用 SUI**（少額）

この構成自体が「方式2 の本体 ＋ 方式1 の器（ただし資金は入れない）」という組み合わせである。Bot 鍵が漏れても：

- BM からの**出金は不可能**（WithdrawCap もオーナー権限も持たない）。
- 可能な被害は「BM 内資金を使った不利な取引」による価値流出に限られる（例：不当に安く売る／高く買う）。これは実質的な資金流出になりうるため、上限（§7.1）と監視、失効ランブック（§7.5）が効く前提で「限定された被害」と位置づける。
- 被害の天井は「BM に入れた金額」であり、オーナーウォレット本体には到達できない。

### 9.2 方式1そのもの（Bot ウォレット資金での執行）を第二アダプタとして併用できるか

**できる**。§5.1 の執行アダプタ抽象の下に `RealBotWalletAdapter` を追加し、Bot アドレス自身の残高（SUI/USDC のコインオブジェクト）で DeepBook の swap／発注を行う構成である。併用時の分離方法は次の通り：

| 分離軸 | 方式 |
|---|---|
| モード分離 | 注文は 1 件ごとに単一のアダプタで執行する。`realTradingSchema.executionSource` で有効な執行元を排他選択し、**初期実装では同時有効化を禁止**する（両方有効は将来拡張。その場合も「戦略シグナル→どのアダプタか」の振り分け規則を明示しない限り有効化しない） |
| 上限の分離 | アダプタ別に 1 回上限・日次上限を持ち、別々に集計する。さらに両アダプタ合算の日次上限を上位に置く（二重の天井） |
| 記録の分離 | `real_orders`／`real_trades` に `executionSource` を必須項目として記録し、集計・履歴表示で混ぜない（§8.1） |
| 残高照合の分離 | TradeCap 経路は BM 残高と照合。Bot 資金経路は Bot アドレスのコイン残高と照合。照合先を取り違えないよう、アダプタごとに `fetchOnchainState` を実装する（§5.1） |
| 資金の分離 | Bot ウォレットに取引資金を入れるのは方式1 有効時のみ。TradeCap 単独運用時はガス用 SUI 以外を入れない運用ルールを明記する（誤送金検知のため、Bot 残高に USDC 等があれば運用画面に注意表示する） |

### 9.3 リスク差分（組み合わせ時）

| 観点 | TradeCap 経路（主軸） | Bot 資金経路（方式1そのもの） |
|---|---|---|
| 鍵漏洩時の最大被害 | BM 内資金への不利な取引まで。出金不可。オーナーウォレット本体は無事 | **Bot ウォレット内全額の直接送金が可能**（鍵＝全権）。被害は即時・全額になりうる |
| 止める手段 | `revoke_trade_cap` で権限剥奪＋出金で退避（Worker が死んでも可能） | 鍵自体が全権のため、止めるには資金を別アドレスへ移すしかない（Bot プロセスとの競合になる） |
| 資金の置き場 | オーナー配下の BM（オーナーが常時管理） | Bot ウォレット（サーバー常駐の鍵の管理下） |
| ガス | Bot アドレスの SUI（両経路で共通に必要） | 同左（取引資金とガスが同一ウォレットに混在する点に注意） |
| 監査 | digest＋BM イベントで追跡可能 | digest＋コイン移動で追跡可能（同等） |
| 実装の単純さ | Cap の発行・失効・検証ぶん複雑 | 単純（通常のウォレット取引） |

### 9.4 推奨

**まず TradeCap 主軸＋Bot ウォレットはガス専用で開始する。** 方式1 の資金執行は、アダプタの差し込み口（§5.1）と記録の `executionSource` 区分だけを今の設計で開けておき、実装は将来の別判断とする。理由：

- 田嶋の目的（自動実行）は TradeCap 経路で満たせる。
- 方式1 の追加で増えるのは利便性ではなく「鍵漏洩時の被害上限」であり、TradeCap 経路の運用実績（Phase 1/2）を見てから判断しても遅くない。
- 差し込み口さえ開けておけば、後から方式1 を足す変更はアダプタ 1 個の追加で済み、先行投資が無駄にならない。

---

## 10. 段階導入

### Phase 1：testnet で一巡（実資金なし）

前提：testnet の SUI／DBUSDC／DEEP はフォーセット等で入手する。プールは `SUI_DBUSDC`（§2.3）。

チェックリスト（一巡＝全部を通すこと）：

1. ダッシュボードでウォレット接続 → BM 作成 → テスト資産を入金
2. TradeCap 発行 → Bot アドレスへ移転 → Worker 側の起動時検証（§4.1-5）が通る
3. REAL 設定（network=testnet、executionSource=TRADECAP、上限はテスト用に極小）で Worker 起動
4. 戦略シグナルまたは手動相当の経路で発注 → 約定確認 → `real_trades` に digest 付きで記録される
5. 指値（未約定）を出してキャンセルが効くこと。一括キャンセルも確認
6. 緊急停止：新規停止＋未約定一括キャンセルが連動すること
7. 照合：Worker を送信直後に落とす等の異常系で、再起動後に §6.5 の照合で状態が復元される（または HALTED で止まる）こと
8. 失効ランブック：`revoke_trade_cap` 後に Bot の発注が失敗すること、出金で全額戻ること
9. ガス枯渇：Bot の SUI を抜いた状態で発注停止＋表示が出ること
10. PAPER 回帰：モードを PAPER に戻し、従来の検証（テスト全件＋PAPER サイクル）が無傷であること

Phase 1 の完了条件は上記 1〜10 の証跡（digest 一覧）が残ること。金額・回数の目安は §11 要判断。

### Phase 2：mainnet 少額

1. プールを `SUI_USDC` に切り替え、BM を mainnet で新規作成（testnet の BM・Cap は流用できない）。
2. 上限は「失っても問題ない額」の範囲で田嶋が設定（§11）。スキーマのハードキャップもここで確定する。
3. 初期は稼働時間を限定し（例：日中のみ等、運用判断は §11）、実況・履歴・照合の表示が実績と一致することを目視確認する。
4. 数日〜数週間の少額運用で、ガス実績・手数料実績・約定率を PAPER の想定と比較し、拡大可否を判断する。

### やらないこと（本設計の範囲外）

- マージン（信用）取引、レバレッジ、フラッシュローン
- SUI/USDC 以外のプール展開
- 複数 BM・複数 Bot の運用
- 方式1（Bot 資金執行）の実装（§9.4 の通り、口だけ開ける）

---

## 11. 要判断事項（田嶋の決定が必要）

| # | 事項 | 備考 |
|---|---|---|
| 1 | Phase 2 の投入額と、REAL の 1 回上限・日次上限・スキーマのハードキャップ値 | 金額は本書では決めない。Phase 1 の実績を見て決める想定 |
| 2 | 手数料の支払い方：DEEP 常備（安い）vs 入力資産払い（+25%、DEEP 不要） | §2.3。少額では簡便さ優先も合理的 |
| 3 | 注文種別：成行相当（placeMarketOrder）vs 価格上限付き IOC 指値 | §6.2。Phase 1 の約定・スリッページ実績で決める |
| 4 | REAL 設定画面の置き場所（運用検証タブ配下／戦略タブの設定セグメント内） | オーナー操作と Worker 制御の画面上の距離感の判断 |
| 5 | TradeCap 発行と移転を 1 tx にまとめるか 2 段にするか | SDK ヘルパーの挙動確認後に実装側で決められるが、UX（署名回数）が変わるため共有 |
| 6 | REAL の成績集計（成績表・振り返り）への含め方 | §8.2。分離が前提だが、表示の粒度は判断が要る |
| 7 | Phase 2 の稼働時間帯の限定有無 | 初期の安全策として |
| 8 | Bot 鍵の生成・保管方法の最終確認（ウォレットアプリで生成し env へ、等） | §5.2 の運用手順の確定 |

---

## 12. リスク一覧

| リスク | 内容 | 緩和策（本設計内） |
|---|---|---|
| Bot 鍵の漏洩 | BM 資金の不利な取引による流出（出金は不可） | §7.1 上限、§7.5 失効＋退避、BM は少額に保つ |
| Worker の暴走・バグ | 意図しない発注の連打 | 直列化キュー、上限の多層化、署名前チェック、HALTED 状態 |
| 約定不明のまま再発注 | 二重発注・状態の不整合 | §6.5 照合完了まで次を出さない。digest 必須記録 |
| Equivocation | 共有 BM／owned Cap の版数競合で tx 失敗 | 送信の単一キュー化（§6.4）。失敗はリトライ可能だが連打しない |
| 通信基盤の不安定さ | 既知の gRPC 遅延（Windows 検証で観測）が実注文では約定確認の遅延に直結 | finality 確認を必須化し、タイムアウトは「失敗」ではなく UNKNOWN→照合へ回す |
| ProfitGuard の過小見積もり | 実ガス・実手数料が想定を超え、薄利で約定する | §5.4 実値ベースの見積り、見積り不能時は棄却 |
| スキーマ移行ミス | REAL 設定の追加で既存 Settings 読み込みが壊れる | REAL 設定は別キー・別スキーマで分離（§5.3）。既存 `settingsSchema` は不変更を原則とする |
| 表示の誤認 | PAPER と思い込んで REAL 稼働に気づかない | §8.3 モードバッジ常駐＋有効化の専用確認操作 |
| DeepBook 側の変更 | SDK／コントラクトのバージョン更新で挙動が変わる | SDK バージョン固定、Phase 1 を testnet で常設の回帰手順として維持 |
| 法規制・税務 | 実売買の損益は記録・申告の対象になりうる | 本書の範囲外。`real_trades` の実績記録（digest・日時・損益材料）は将来の集計に使える形で残す |

---

## 13. 代替案（方式1 単独）との差分メモ

田嶋は当初方式として「Bot 専用ウォレット（方式1）」も検討し、最終的に TradeCap 方式（方式2）を主軸に選んだ。記録として差分を残す：

- 方式1 単独は実装が単純（Bot ウォレットが資金と鍵を持ち、通常のウォレット取引として執行）だが、**鍵漏洩＝資金全額の即時流出**であり、止める手段も「残資金の奪い合い」しかない。
- TradeCap 方式は Cap の発行・移転・失効ぶん設計と実装が増える代わりに、資金の置き場（オーナー配下）と実行権限（Bot）を分離でき、**失効という正規の kill switch** が存在する。
- 両方式とも Bot 鍵とガス用 SUI は必要であり、その点の運用負担は変わらない（§9.1）。
- 方式1 は排除されたわけではなく、§9 の通りアダプタとして将来追加できる形にしてある。

---

## 出典

1. DeepBookV3 公式ドキュメント「BalanceManager」― https://docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information/balance-manager （TradeProof の生成方法、TradeCap 保有者は発注のみ可・入出金不可、Cap 上限 1,000、`revoke_trade_cap` の存在、equivocation の注意）
2. DeepBook v3 Move ソース `packages/deepbook/sources/balance_manager.move`（github.com/MystenLabs/deepbookv3）― `mint_trade_cap`（owner 検証）、`revoke_trade_cap`（`allow_listed` から ID を除去、owner のみ）、`generate_proof_as_trader`（`validate_trader`）
3. DeepBookV3 SDK 公式ドキュメント（docs.sui.io/onchain-finance/deepbook/deepbookv3-sdk）― マーケットメイカー例：`BALANCE_MANAGER_ADDRESS`／`BALANCE_MANAGER_TRADE_CAP` を Bot 側クライアントに設定し Bot keypair で署名・実行する構成、`createAndShareBalanceManager`
4. TS SDK ソース `packages/deepbook-v3/src/transactions/balanceManager.ts`（github.com/MystenLabs/ts-sdks）― `mintTradeCap`、`revokeTradeCap`、`generateProofAsTrader`、`createAndShareBalanceManager` 等のヘルパー
5. TS SDK ソース `packages/deepbook-v3/src/utils/constants.ts`（同上）― mainnet プール `SUI_USDC`（quote：ネイティブ USDC）、testnet プール `SUI_DBUSDC`（quote：DBUSDC）と既定コイン
6. DeepBookV3 公式ドキュメント「Fees and Funding」― http://docs.sui.io/onchain-finance/deepbook/deepbookv3/fees-and-funding （`pay_with_deep`／`payWithDeep` 既定 true、入力資産払いは +25%、testnet 資産の入手に言及）

注：出典 URL は調査時点（2026-10-25）のもの。実装着手時に SDK バージョンと合わせて再確認すること。
