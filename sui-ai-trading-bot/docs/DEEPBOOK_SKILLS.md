# DeepBook公式Agent Skills

## 導入記録

- 公式ソース: https://github.com/MystenLabs/skills
- 参照コミット: e31b38016723e2dcee36161d59c50e028e13b52a
- 導入CLI: skills 1.7.4
- 導入先: リポジトリルートの .agents/skills/deepbook-sdk と .agents/skills/deepbook-overview
- スコープ: project / Codex。グローバルには導入していない。
- skills-lock.json に配布元・各Skillのハッシュを記録。公式ファイルは編集していない。
- 2つのSKILL.md、関連リファレンス5件、評価用JSON2件の計9ファイルを公式コミットのGit blobと照合し一致を確認（CRLFをLFに正規化）。公式Apache-2.0ライセンスも同梱。

実行した導入コマンド（指定された2コマンドを1回に集約）:

~~~powershell
Set-Location D:\Source\SuiBa
npx skills add mystenlabs/skills --skill deepbook-sdk --skill deepbook-overview --agent codex --copy --yes
npx skills list --agent codex --json
~~~

インストール前に対象のプロジェクト配置先に同名Skillがないことを確認した。再導入時は上記listと配置先を確認し、既存ならaddを繰り返さない。

## Codexからの参照

CLIのlist結果で両方のscope=project、agents=[Codex]を確認済み。この作業でも両方のSKILL.mdと関連資料を読み込んだ。
Codexは作業フォルダからリポジトリルートまでの.agents/skillsを検索する:
https://learn.chatgpt.com/docs/build-skills

D:\Source\SuiBaまたはその配下のsui-ai-trading-botをCodexで開き、次のターンで利用する。表示されない場合はCodexを再起動する。
旧OneDrive側を開いているセッションの自動認識まで確認したわけではない。

依頼例:

~~~text
$deepbook-sdk と $deepbook-overview を使い、SUI_USDCの読み取り専用Provider設計をレビューしてください。署名・送信は行わず、既存の鮮度検証と安全停止を維持してください。
~~~

SDK初期化・読み取りはdeepbook-sdk/client-setup.md、板データはtrading.md、構造はdeepbook-overview/design.md、通貨・プールはcontract-info.mdを必要な範囲で読む。

## 既存調査への補足（再疎通試験はしていない）

1. 読み取り専用では鍵・BalanceManagerは不要。SuiGrpcClient.$extend(deepbook(...))とSDKのプールキーSUI_USDCを使用する。既存調査の接続方式と整合する。
2. trading.mdはgetLevel2TicksFromMid(poolKey, depth)からbid_prices / bid_quantities / ask_prices / ask_quantitiesを取得し、最良気配からmidを計算する例を示す。SDK 2.8.0には別途midPrice(poolKey)があり、既存調査で実測済み。資料に例がないことはAPI廃止を意味しない。midは約定可能価格や見積もりの代わりにはならない。
3. SDKのdepthはmid周辺の板取得引数。Indexerのorderbookのdepthと戻り値は別の契約なので、同じ数値で同じ段数とは仮定しない。実測ではSDKの5で売買各5段、Indexerの10で売買各5段だった。
4. この2 SkillsはOHLCVのURL・時間足・履歴上限・タイムスタンプ・欠損補完を詳しく規定していない。既存の公式Indexer仕様確認と実測を補う資料であり、置き換えるものではない。既存調査の/ohclvパス、実レスポンスのミリ秒、未確定足除外、5分足36か所の欠損という結果は撤回しない。資料を根拠に欠損補完や履歴切り詰めを許可しない。
5. contract-info.mdは23プールの固定表だが、既存実測のget_poolsは26件。SUI_USDCのpool IDとNative USDC型・decimalsは一致した。現在値はSDK設定と実データで確認する。
6. 固定表のSUI/USDC tick sizeは0.00001。一方、既存実測のtick_size=100をSDK 2.8.0のpoolBookParams式（baseScalar / quoteScalar / FLOAT_SCALAR）で換算すると0.0001。資料と取得値に差があるため、この表の値を運用設定へ転記しない。今回追加のRPC照会はしておらず、オンチェーン現在値の再確認は今後の実装時に行う。手数料・有効package versionも固定表を現在値として扱わない。
7. SDKの読み取りはSui RPC経由であり、既存調査のsimulateTransaction経路と整合する。Indexerへの移行とSui gRPCの通信障害対策は別。Skills導入だけでどちらの通信問題も解消しない。
8. trading.mdのリトライ例はlocalnet/sandboxの流動性再配置向け。SuiBaの429制御、即時停止、手動再開ポリシーへそのまま流用しない。

## 今回の範囲と検証

導入・ロックファイル・この説明書だけを今回のコミットに含める。前の調査で残っているコード差分は含めない。
GeckoTerminal、AI判断、環境変数、秘密情報、取引モード、実行中コンテナは変更していない。実注文・署名・資金移動は実行していない。既存実装のPAPER専用制約も変更していない。

検証: Codex指定のCLI一覧、SKILL.md/frontmatterと全リファレンスの読取、公式コミットとの全9ファイル照合、評価JSON構文確認、skills-lock.json確認。
同じ作業ツリーの直前の回帰結果はpnpm build成功、pnpm test 203件成功、pnpm test:e2e 64件成功。今回のSkills導入後にアプリ全テストは再実行していない（実行コードへの変更なし）。配布されたevals.jsonは仕様評価用であり、9ファイルの照合やJSON構文確認をeval実行成功とは扱わない。
