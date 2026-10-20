# LIVE基盤：Phase 1〜3

このブランチは**未署名PTBの構築・検証・シミュレーションまで**です。実売買、承認UI、署名、送信、自動売買は有効にできません。通常の `pnpm dev` は従来通りPAPER専用で、`MODE=LIVE` は引き続き起動拒否します。既存の `.env`、稼働中Worker、仮想残高は変更しません。

## 追加した構成

- `packages/shared/src/execution.ts`：PAPER / LIVEでリクエストと結果の型を分離した共通実行契約。既存のPaperTrading.fillは維持し、prepareを追加。
- `LiveTradingExecutor`：明示的なプレビュー初期化、別途 `armPreview('SIMULATION_ONLY_NO_SIGNING')`、1件ずつの予約、検証、シミュレーション、終了後の再検証。戻り値は `SIMULATED_ONLY`。署名・送信可能なオブジェクトや秘密鍵を返さない。
- `TransactionBuilder`：Cetus Aggregator V3 SDKを使って実際のスワップ用PTBを作成。ルートの許可検証後、入力を正確な数量でsplitし、`routerSwapWithMaxAmountIn` に渡す。受取先は送信元のみ。
- `TransactionValidator`：最終BCSをデコードし、独立した固定テンプレートから生成したPTB全体と完全照合。入力参照・pure値・型引数・Move関数・Package ID・結果参照・送金先・ガス設定・追加コマンド・不足コマンドの違いを拒否。
- `TransactionSimulator`：gRPC `simulateTransaction` に検証済みbytesのコピーを渡す。`checksEnabled=true`、`doGasSelection=false`、実ガス参照必須。成功・効果・入力減少・最低受取・ガス・受取先・取引内容・受取後の保有比率を確認。
- `WalletSigner`：将来のKMS向け契約と、必ず署名を拒否する実装。PAPERはsecret providerを呼ばない。LIVEの明示的なプレビュー初期化時のみEd25519鍵からアドレスを照合し、キーオブジェクトを保持しない。アドレス確認のたびにproviderを再読込し、変更・消失・不正キーを検出。
- `GrpcWalletReader`：Mainnet識別・SUI/Native USDC実残高・Coinの所有者と型・ガス単価・共有オブジェクトの型/初期バージョンを検証。SDKのキャッシュ済みchain identifierに依存せず、初期化用transportではservice infoを毎回読む。
- `TransactionReconciler`：Phase 5用の明示的な未実装境界。未解決状態があれば新規作業を止める。オンチェーン照合・再送は実装しない。
- `SqliteLiveStore`：既存DBアクセス層に追加。`live:`名前空間で注文予約・結果・停止・固定ウォレットを永続化し、PAPERの残高・注文・設定と分離。トランザクション内で重複と同時予約を拒否。

## 許可範囲と初期化

対応するのは**CETUS、単一プール、単一経路、exact-input、SUI/Native USDC**だけです。複数経路、中間トークン、他DEX、追加DEEP費用、overlay fee、外部からのPackage差替えは拒否します。Aggregator内の全DEXを無条件に使える実装ではありません。

`initializeLivePreview` はサーバー専用ライブラリです。通常Worker・管理API・ダッシュボードから呼び出していません。利用にはコード上で `mode:'LIVE'` と `previewEnabled:true` を明示し、サーバー側の秘密プロバイダーと、レビュー済み `LivePolicy` を供給する必要があります。初期化しても未アーム状態で、署名・送信は不可能です。設定画面や `.env` の値を変えるだけでLIVE売買が有効になることはありません。

`LivePolicy` は専用ウォレットの許可アドレス、Aggregator/Cetusの固定Package ID、globalConfig/partner/clock/poolの正確なID・Move型・初期共有バージョン・mutableフラグ、ガスbudget/reserveを要求します。**外部ルートから許可リストを生成してはいけません。** SDK更新やPackage更新で形が変わったら拒否し、個別レビューが必要です。

現段階では実ウォレットを新規作成していません。実ウォレット鍵・資金・運用用の実プール許可マニフェストも設定していません。将来の専用ウォレットを許可リストで固定する構造を追加したものです。既存READ_ONLY_ADDRESSを署名ウォレットとして流用しません。

ガスは入力SUIと区別して留保します。上限budgetは0.1 SUI、reserveは最低0.1 SUI。SUI売却時は入力分に加えてbudget/reserveを残せるCoinが必須。USDCは1個の所有Coinで賄える場合のみ対応し、分散したCoinの自動統合やaddress balanceからの自動引出しはこの段階では実装しません。

注文5 USDC・日次買付20 USDC・日次損失1%・slippage 0.3%・保有20%の上限を独立に検証し、既存RiskEngineも通します。実残高はRPCから上書きします。日次カウンター・日初資産・取得費は今後のLIVE台帳からserverが供給する前提のため、**Phase 4ではクライアント入力として受け付けてはいけません**。現在は送信処理そのものが存在しないため、LIVEの約定台帳は更新しません。

見積もりの数量・価格・期限が変わったらプレビューを拒否します。新しい見積もりを黙って旧判断に付け替えません。Phase 4の承認更新は未実装です。15秒のTTLはローカル検証上の制限であり、オンチェーンの時刻有効期限ではありません。オンチェーンの受取保護はSDKの `new_swap_context_v3` に渡す引用出力/slippageと `confirm_swap_v3` の組合せを固定テンプレートで保持し、シミュレーション結果でも最低受取を確認します。

## SDKの確認記録

- `@mysten/sui 2.37.0`：`Transaction.build` / `Transaction.from` / `SuiGrpcClient.simulateTransaction`。インストール済み `docs/clients/executing.md`、`src/client/types.ts`、`src/transactions/data/v2.ts` を確認。
- `@cetusprotocol/aggregator-sdk 1.7.5`：`findRouters(FindRouterParams): Promise<RouterDataV3|null>`、`routerSwapWithMaxAmountIn(BuildRouterSwapParamsV3 & {maxAmountIn:BN}): Promise<TransactionObjectArgument>` を型定義と実装で確認。slippageはfraction、内部表現はfloor(fraction × 1,000,000)。サポートする値は整数ppmに限る。
- Cetusの依存SDKは2.31.2で、アプリの2.37.0とはTransactionのprivate型が異なるためpnpm overrideで2.37.0へ統一。実SDKによるBUY / SELL両方向のオフラインBCS構築をテストし、独立テンプレートとの一致を確認。Mainnet RPCでの実シミュレーション互換性は未検証。
- [Cetus公式：見積もりとPTB構築](https://cetus-1.gitbook.io/cetus-developer-docs/developer/cetus-aggregator/features-available)
- [Sui公式：シミュレーション](https://sdk.mystenlabs.com/sui/clients/executing)

## テストとPhase境界

`pnpm test` では全テストのfetchを禁止し、外部API/RPC/秘密プロバイダーをモックにしています。SDKによるローカルPTB/BCS変換とSQLiteは実装そのものを実行します。`pnpm smoke` / `pnpm verify:runtime` は別途明示的に実行するネットワーク診断で、この作業では実行していません。

未設定キー、network/coin/amount/slippage/gas、Move呼出し・送金先・pure引数・保護関数の改ざん、失敗/不明のシミュレーション、残高不一致、重複/同時注文、再起動、緊急停止、PAPER分離、鍵変更、署名/送信/自動化の拒否を検証します。実際の署名失敗・送信失敗・送信timeout後の照合は、機能がないため未実装です。拒否ゲートと未解決状態での停止をテストし、Phase 4/5の実装済みとは扱いません。

Phase 4（承認画面・最新見積もり再審査・署名送信）、Phase 5（Digest照合・実約定台帳）、Phase 6（条件付き自動売買）、Phase 7（LIVEダッシュボード）は、検証結果のレビューと明示的な承認後に進めます。
