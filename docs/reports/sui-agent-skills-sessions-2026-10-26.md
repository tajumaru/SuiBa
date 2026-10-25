# Sui Agent Skills導入とDeepBook Sessions Testnet PoC

確認日：2026-10-26（日本時間）。作業ブランチ：`codex/mysten-skills-testnet-sessions`。開始時のmain：`6c775c0`。mainへの直接コミット・マージは行わない。

## 導入前の状態

リポジトリには`deepbook-sdk`と`deepbook-overview`、そのCLI形式の`skills-lock.json`、既存の`ui-ux-pro-max`があった。追跡済みAGENTS.md、Codex専用設定、Sessions PoCは見当たらなかった。グローバルには同名スキルがある場合もあるが、別マシンで再現できるプロジェクト内の構成を優先した。既存UIスキルは保持し、第三者Skillsは新規導入していない。

## 公式一覧とインストールの確認

ユーザー指定の`npx skills add mystenlabs/skills --list`を実行し、31件の一覧に指定7件が存在することを確認した。Windowsの既存Node設定を変えず、同じnpx entrypointをNode24.22.1で起動した。使われたCLIは`skills@1.7.4`、配布元は[Vercel Labsの公式CLIリポジトリ](https://github.com/vercel-labs/skills)。これはインストール用のutilityであり、第三者Skillを追加したという意味ではない。

実行前にnpm配布物のpackage metadata、SRI、bin、lifecycle scripts、一覧表示分岐とtelemetryの無効化条件を静的に確認した。npmの`prepare: husky`等は`ignore-scripts=true`で無効化。監査対象tarballのSHA-512は`.agents/mysten-skills.json`に記録した。CLIの全コードや全依存の完全なセキュリティ監査を行ったとは扱わない。

一覧取得・公式取得・インストールは、必要なWindows実行環境だけを許可した子プロセス環境で行った。トークン・秘密鍵・mnemonic等の環境変数、既存npm認証設定、Git credential helper、Git hooks、telemetryを渡さない/無効にする設定を使用した。秘密ファイルやwallet/keystoreは読んでいない。インストールは通常ユーザーのファイル取得・コピーのみで、OS設定・グローバルSkills・PowerShellポリシー・Nodeのインストールは変更していない。

公式Skillsは[固定コミットe31b38016723e2dcee36161d59c50e028e13b52a](https://github.com/MystenLabs/skills/tree/e31b38016723e2dcee36161d59c50e028e13b52a)を使用。Codexのskill-installer helperを`--method download --ref <SHA> --dest .agents/skills`で実行し、不足5件だけを追加した。既存2件は公式と本文が一致した。全43ファイルはMarkdown/評価用JSONのみ、symlinkや実行プログラムはなく、評価用JSON自体は実行していない。Apache-2.0の既存`LICENSE.mystenlabs`を保持した。

## 導入結果とCodexへの適用

| Skill              | 状態               | PoCでの役割                                           |
| ------------------ | ------------------ | ----------------------------------------------------- |
| deepbook-sdk       | 既存を確認して保持 | SDK入口、従来のTradeCapとSessionsの区別               |
| deepbook-overview  | 既存を確認して保持 | account/custody・委任権限の理解                       |
| sui-ts-sdk-backend | 追加               | v2のTransaction構築と署名/実行の分離                  |
| sui-sdks           | 追加               | インストール版・exports・同梱資料の照合               |
| ptbs               | 追加               | object/pure入力、sender、BCS、未解決参照              |
| sui-client         | 追加               | Testnetと公開アドレスの準備。秘密鍵管理は今回使わない |
| accessing-data     | 追加               | 後続のTestnet参照/シミュレーションでgRPCを検討        |

配置先は`.agents/skills/<name>/SKILL.md`。新しいルート`AGENTS.md`が7件をルーティングし、Sessionsは最新SDK/公式資料も必ず照合すること、Testnet限定、秘密情報を渡さないこと、既存実行設定を変えないことを明記する。公式Skill自体にローカル方針を追記せず、原文を保持した。

`skills-lock.json`のCLI互換hashと`.agents/mysten-skills.json`の上流SHA/各ファイルSHA-256を検証する`node scripts/verify-mysten-skills.mjs`を追加した。改変・未知のファイル・symlink・異なるsource・壊れたfrontmatter・欠落した相対参照は失敗する。Windows/Linuxで一致するよう、指定7件だけLFを固定する`.gitattributes`も追加した。旧2件の本文は変更せず、改行正規化に伴いlock digestを再計算した。

監査済みCLIのローカル`skills list --agent codex`でも、7件すべてがCodex向けに検出された。この作業ではCodex自身が配置済みSKILLと必要なreferenceを読み、その方針をPoCに適用した。自動選択を強制する独自プラグインやglobal登録は追加していない。PRを取り込んだ作業コピーでは、次のターンからその`.agents/skills`とAGENTSの案内を利用できる。新規GUIセッションで自動トリガーを観察したという検証ではなく、配置・frontmatter・参照・agentによる読込・実装適用の確認である。

## Sessionsの最新公式情報との照合

SkillsのDeepBook説明は従来のspot操作が中心で、SessionsのAPIを推測して補わなかった。[公式Sessions SDK](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict-sdk/sessions)、[契約仕様](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict/contract-information/sessions)、[デプロイ情報](https://docs.sui.io/onchain-finance/deepbook/deepbook-predict/contract-information)を確認した。

2026-10-26のnpm registryで最新だった`@mysten/deepbook-v3@2.8.0`と、そのpeer条件に合う`@mysten/sui@2.37.0`をPoC専用package/lockに固定した。既存Bot側のpackage/lockを変更していない。

実装は導入済み公式SDKの`src/sessions.ts`、生成済み`src/contracts/deepbook_sessions/sessions.ts`、型定義と照合した。Sui側は同梱`docs/llms-index.md`から`docs/transactions/offline.md`等を確認した。DeepBook2.8.0の当該配布物には同じ場所のLLM indexがなく、source/typesと公式webを代替にした。公式webの一部の埋め込みにはmanifest未収録表示や古いversion説明があり、埋め込みコードを唯一の証拠にしていない。

PoCはSDKの`getSessionsConfig('testnet')`と`getDeployment('testnet')`からcall target/original ID/chainIdを取得する。既存BalanceManagerを都度作るような処理は追加しない。セッションはaccount全体の取引権限であり、特定pool・notional・損失額の制限やSuiBaの売買上限を自動保証するものではない。SDKの契約上限は期間30日、保存先20アドレスだが、PoCは期間のみローカル検証し、枠数はチェーン状態なしでは判定しない。

## PoCの到達点

`sui-ai-trading-bot/tools/deepbook-sessions-testnet`に独立したツールを追加した。通常起動は計画表示、公開owner/sessionアドレスを指定した場合だけ、次の未署名PTB設計データを構築する。

- ownerによる`authorize_session`（既定5分、正の整数かつSDK最大期間以下）
- ownerによる`revoke_session`
- `session_expiration_ms`の照会用PTB

実際のSDK builderが出すTestnet package、sender、BCSのアドレス/期間、wrapper/account/fieldの導出をテストした。Mainnet/Devnet/独自endpoint、秘密鍵・sign/executeオプションを拒否し、network関数を禁止した子プロセスでも動く。

`Transaction.getData()`には未解決objectと未指定gasが残る。完全なtransaction bytesでも、オンチェーンシミュレーションでも、所有権/口座存在/registry認可/期限切れ/失効/約定成功の証明でもない。参照versionや残高を捏造してbuildしていない。Testnetを含む署名・送信は0件で、key生成・faucet・wallet読み込みもない。

## テストと退行確認

導入前後で同じNode24.22.1・ネットワーク無効の使い捨てコンテナを使用。既存テストDBはコンテナ内tmpfsだけで、実稼働コンテナ/DB/volumeには触れていない。

| 検証                 | 導入前                    | 導入後                                     |
| -------------------- | ------------------------- | ------------------------------------------ |
| 既存typecheck        | 成功                      | 成功                                       |
| 既存build            | 成功                      | 成功                                       |
| 既存CIのtest:offline | 54ファイル・803成功/7skip | 54ファイル・803成功/7skip                  |
| Skills整合性         | 既存2件の内容一致確認     | 検証2件成功、7件43ファイル                 |
| 新規Sessions PoC     | なし                      | Windows/Linuxで7件成功、通信禁止下でも成功 |

上記は既存CIのオフライン範囲であり、実際の外部通信検証や既存の接続試験を実施したという意味ではない。追加CIはWindows/UbuntuでSkillsの固定元・整合性とPoCを検証し、インストール時は`--ignore-scripts`を指定する。

## 次の手順と未解決事項

1. 専用の少額Testnet accountと公開owner/sessionアドレスを確認する。秘密鍵はSkills/チャットへ渡さない。
2. 明示操作だけで行うTestnet read/simulationを別段階で追加し、network/chainIdを確認する。既存gRPC通信設定を流用・変更しない。
3. owner署名の許可、session操作、期限切れ・失効・未許可アドレス拒否を検証する。署名経路は別途安全に用意する。
4. Spot注文を実装する場合、Predict builderで代用せず、最新の`sessionsMoveCalls`・account/registry仕様を照合する。

既存のNode、Docker、gRPC、通信期限、安全停止、PAPER/LIVE、注文・約定には変更なし。mainへのマージは行わず、レビュー待ちとする。
