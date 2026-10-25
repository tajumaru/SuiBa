# DeepBook Sessions Testnet PoC — phase 1

公式SDKのSessions APIで、許可・失効・有効期限照会の**未署名PTB設計データ**を構築します。通常起動・テストとも外部通信0件です。トランザクションの署名・送信・オンチェーンシミュレーション、口座作成、入金、注文、PAPER/LIVE運用は実装していません。既存BotのNode/Docker/gRPC設定と依存関係は変更しません。

## 準備と実行

Node >=24.22.1 <25 を使い、このフォルダーで実行します。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
node cli.mjs
node --test sessions.node.mjs
```

`node cli.mjs` はTestnet計画・SDK版・デプロイ情報を表示するだけです。構築する場合は、秘密鍵ではなく公開アドレスを渡してください。

```powershell
node cli.mjs --action authorize --network testnet --owner 0x1111111111111111111111111111111111111111111111111111111111111111 --session 0x2222222222222222222222222222222222222222222222222222222222222222 --duration-ms 300000
node cli.mjs --action revoke --network testnet --owner 0x1111111111111111111111111111111111111111111111111111111111111111 --session 0x2222222222222222222222222222222222222222222222222222222222222222
node cli.mjs --action expiry --network testnet --owner 0x1111111111111111111111111111111111111111111111111111111111111111 --session 0x2222222222222222222222222222222222222222222222222222222222222222
```

上のアドレスはオフライン試験用の架空値です。所有権や実在を確認した口座ではありません。`mainnet`、`devnet`、独自endpoint、秘密鍵・sign/executeオプションは拒否します。`durationMs`は正の整数で、SDKが示す最大30日以下のみ受け付けます。SDK単体ではこの検証をしないため、ローカルで追加しています。既定は5分です。

## Skillsと公式情報の適用

| Skill              | 今回使った内容                                                   |
| ------------------ | ---------------------------------------------------------------- |
| deepbook-sdk       | SDK統合の入口、既存BalanceManager操作とSessionsを混同しない      |
| deepbook-overview  | DeepBook/account/custodyの区別と権限の確認                       |
| sui-ts-sdk-backend | v2のTransaction構築、署名・実行との分離                          |
| sui-sdks           | 実際に導入したSDKの版・exports・同梱資料を確認                   |
| ptbs               | object/pure入力、BCS、sender、未解決objectの扱い                 |
| sui-client         | 公開アドレス・Testnet準備の区別。keystoreやCLI設定は読み込まない |
| accessing-data     | 後続の参照/シミュレーションはgRPCを検討。今はclientを生成しない  |

- 固定SDK：`@mysten/deepbook-v3@2.8.0` / `@mysten/sui@2.37.0`（2026-10-26に最新を確認）。PoC専用package-lockに固定。既存Bot側のlockは変更しません。
- [公式Sessions SDK](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict-sdk/sessions) と [契約仕様](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict/contract-information/sessions) を併用。
- APIは導入済み `node_modules/@mysten/deepbook-v3/src/sessions.ts`、`src/contracts/deepbook_sessions/sessions.ts`、`dist/sessions.d.mts`で照合。
- Suiは `node_modules/@mysten/sui/docs/llms-index.md` と `docs/transactions/offline.md` を確認。今回のDeepBook配布物には同じ位置のLLM indexがないため、収録source/typesと公式web資料を使用。
- `getSessionsConfig('testnet')` / `getDeployment('testnet')` からIDとchainIdを取得。package call targetとoriginal IDは区別し、IDを手書きしません。

## 検証できたことと、未検証のこと

できたこと：公式SDKの実際のbuilderで1件の正しいSessions MoveCallを構築し、sender・Testnet package・BCSの公開アドレス/期間・決定的なwrapper/account/field IDを確認しました。ネットワーク関数を禁止した子プロセスでも実行できます。

`getData()`の結果には未解決objectと未指定gasが残ります。**完全なtransaction bytes、シミュレーション結果、署名可能性や約定成功の証明ではありません。** 勝手なobject version・gas・残高を捏造して`build()`はしません。SDK最大20セッションの枠数、所有権、実在、registry認可、期限切れ・失効の実効性はチェーン状態が必要で未検証です。

Sessionsの権限はaccount全体の取引権限です。プール・notional・損失額の制限をこの権限が保証するわけではありません。SuiBaの運用上限が自動的に適用されるとも扱いません。[公式の権限説明](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict-sdk/sessions)に基づき、後続試験は専用の少額Testnet accountで行います。

## 次のPoC段階

1. Testnetに実在する専用accountの公開owner/sessionアドレスを確認する。秘密鍵はSkillsやチャットに渡さない。
2. 既存Botから独立したTestnet参照/シミュレーションを追加する場合、固定Testnet endpointとchainIdを照合し、別の明示操作にする。スクリプトのimport・testでは始めない。
3. owner署名の許可、session権限、失効/期限切れ、未許可アドレス拒否をTestnetで検証する。外部ウォレット等の署名経路は別途レビューし、最初に読み取り結果とシミュレーションを確認する。
4. Spot注文はSessionsContractのPredict builderで代用しない。公式`sessionsMoveCalls`と最新のspot/account/registry手順を確認してから別段階で実装する。

このPRではTestnetを含むトランザクション送信は0件です。既存の通信タイムアウトや安全停止条件を緩和しません。
