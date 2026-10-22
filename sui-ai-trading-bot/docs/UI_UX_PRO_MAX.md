# UI UX Pro Max の導入

## 配置と配布元

- 導入日: 2026-10-22 (JST)
- 対象: `tajumaru/SuiBa` main、`D:\Source\SuiBa`
- 公式: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- README・CLIソースを確認したコミット: `623a9a9037d006ea727f8213f084d02a6b6f11b5`
- 実際の配布物: npm `ui-ux-pro-max-cli@2.15.0`。GitHub HEAD の CLI package.json は2.5.0表記であり、両者を同一成果物とは扱っていない。
- 配置: リポジトリルートの `.agents/skills/ui-ux-pro-max/`
- 追加: 公式CLI生成の `SKILL.md`、`data/` 39ファイル、実行用Python4ファイル、MIT `LICENSE`、キャッシュ除外 `.gitignore`、出典・LF正規化SHA-256を記した `upstream-manifest.json`。計47ファイルと本書。
- 既存の `skills-lock.json` は別CLI（skills）の形式のため変更しない。今回の固定版とハッシュは独立したmanifestに記録する。

## 導入方法と安全性確認

グローバルインストールは必要ないため実施していない。不可能と判定したわけではない。アプリの依存関係にCLIを追加せず、リポジトリ外の作業領域に固定版をインストールした。

```powershell
npm.cmd install --prefix <tool-dir> --ignore-scripts --no-audit --no-fund --package-lock=false ui-ux-pro-max-cli@2.15.0
# 空の隔離ディレクトリをcwdとして実行
node <tool-dir>/node_modules/ui-ux-pro-max-cli/dist/index.js init --ai codex --offline
```

`--ignore-scripts` でnpmライフサイクルスクリプトを実行しない。公式ソースの `init.ts`、`template.ts`、`extract.ts`、エントリポイントと、npmの実際の生成・コピー処理も確認してからCLIを実行した。通常のinitは同梱テンプレートを生成・コピーする。GitHubダウンロード・シェル展開を使うlegacy経路やupdate/uninstallは実行していない。同名配置先が存在しないことを確認し、`--force` や `--global` は使用していない。

npm 2.15.0 はREADMEにある `--dry-run` を認識せず、当該コマンドは書き込み前に終了した。そのため隔離ディレクトリで生成結果を調べた。CLIが同時生成する banner-design / brand / design / design-system / slides / ui-styling は今回の目的に不要で、SuiBaへ取り込んでいない。上流テスト・fixture・検証専用スクリプトも除外した。本体のSKILL.mdはこれらの兄弟Skillを参照せず、検索に必要な4スクリプトと全データを保持している。

npmのデータ・PythonをGitHub HEADと比較すると一部差分がある。導入物はnpm固定版を出典とし、GitHub HEADと完全一致するとは主張しない。検索用コードのimportとI/O、差分を確認し、ネットワーク通信・外部プロセス起動・eval/execによるデータ実行は見つからなかった。通常検索はローカルCSVを読む。`--persist` は明示的にデザイン文書を書き込む機能なので、今回使用していない。

本体はMIT（Copyright (c) 2024 Next Level Builder）で、著作権表示と許諾文をLICENSEに保持した。既存リポジトリや既存Skillsのライセンスは変更しない。データ内のフォント・アイコンの参照情報と出典メタデータは保持するが、フォントバイナリやアイコンライブラリは導入していない。今後それらの実素材を利用する場合は各素材のライセンスを確認する。

## Pythonと実行方法

検証環境はWindows / Python 3.13.0。Python標準ライブラリのみで、pip追加は不要。上流はPython 3.xを要件としているが全minor版の互換性を検証したわけではない。Windowsでは `python` を使用する。

リポジトリルートから:

```powershell
python -B .agents/skills/ui-ux-pro-max/scripts/search.py "focus not obscured" --domain ux -n 1
python -B .agents/skills/ui-ux-pro-max/scripts/search.py "keyboard focus" --stack react -n 1
python -B .agents/skills/ui-ux-pro-max/scripts/search.py "time series trend" --domain chart -n 1
```

アプリ配下 `sui-ai-trading-bot/` から直接実行する場合は `../.agents/skills/...` とする。SKILL.mdのコマンド例はリポジトリルート基準。CodexはSkillの絶対パスを認識するため、実行前にcwdに合わせてパスを解決する。

## Codexでの認識と利用検証

Codex CLI 0.161.0 のapp-serverへ `initialize` → `skills/list` (`forceReload=true`) を送信し、以下の両cwdで確認した。モデルへの追加タスク起動は行っていない。

| cwd | name | scope | enabled | errors |
| --- | --- | --- | --- | --- |
| `D:/Source/SuiBa` | `ui-ux-pro-max` | `repo` | `true` | `[]` |
| `D:/Source/SuiBa/sui-ai-trading-bot` | `ui-ux-pro-max` | `repo` | `true` | `[]` |

認識パスは `D:\Source\SuiBa\.agents\skills\ui-ux-pro-max\SKILL.md`。サンドボックス内では既存CODEX_HOMEへのアクセス制限で起動が応答せず、許可されたサンドボックス外の読み取り確認で上記結果を得た。既存のCodex設定は変更していない。

公式仕様: https://learn.chatgpt.com/docs/build-skills

CodexはcwdからGitルートまでの `.agents/skills/` を探索する。このチャットのcwdはOneDrive側なので、ここに提示済みのSkill一覧の自動更新まで検証したわけではない。今後は `D:\Source\SuiBa` またはその配下をCodexで開き、次のターンで利用する。表示されない場合はCodexを再起動する。

依頼例:

```text
$ui-ux-pro-max を使って、SuiBaのダッシュボードのキーボード操作とチャートの見やすさをレビューしてください。まずSKILL.mdを読み、UX・React・chartの必要な検索結果を確認してください。今回は改善案だけを提示し、UIコード、売買ロジック、API、DB、Docker設定は変更せず、稼働中のPAPER検証を停止しないでください。
```

SKILL.mdを読み、上のUX・React・chart検索を実行して、フォーカス可視性、モーダルのフォーカス管理、時系列チャートのアクセシビリティに関するデータが返ることを確認した。これは読込・検索の実測であり、自然文依頼からの暗黙のSkill自動選択をモデルで試験したわけではない。明示的な `$ui-ux-pro-max` 指定を推奨する。

`--design-system` の実行も成功したが、`fintech trading dashboard` は営業向けEnterprise Gatewayを返し、`trading platform` へ一度絞り直してもGeneralへのフォールバックだった。SuiBa用の妥当な全体デザインが得られたとは扱わず、提案は適用・永続化していない。実際の改善では対象を絞ったドメイン検索と既存UIの確認を優先する。

## 変更範囲

Skillと本書だけをコミットする。既存の未コミット変更は保持し、今回のコミットに含めない。mainは `8bbc164` まで早送り同期した。UI、売買ロジック、API、DB、Docker、アプリ依存関係に今回の変更はない。サービス・コンテナ操作は行わず、PAPER検証を停止していない。アプリコードを変更していないためアプリ全体の回帰テストは実行していない。

追加検証: manifest内46ファイルのハッシュ、全データJSON/CSVの構文、Python4ファイルの構文、全domain/stack参照先、SKILL frontmatterと未展開テンプレートなしを確認した。`git diff --cached --check` は上流の `design_system.py` に含まれる末尾空白を報告する。配布物との一致を優先して改変せず保持したため、このチェックを成功とは報告しない。
