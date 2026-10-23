# 運用検証UIの検証結果

実施日：2026-10-23 JST。対象：main。操作対応と実際の開始手順は [VALIDATION_UI_FLOW.md](VALIDATION_UI_FLOW.md)。

## 結果

| 確認 | 結果 |
| --- | --- |
| TypeScript `tsc --noEmit` | PASS |
| Vite本番ビルド | PASS。依存ZodのPUREコメントに関する警告のみ |
| 全Vitest | 34ファイル・458件PASS |
| 運用・安全復旧・検証・操作E2E | 120件PASS（375/390/430/1280px） |
| 開始済みステップ短縮後の関連E2E再確認 | 64件PASS（上記120件の関連ケースを再実施） |
| `git diff --check` | PASS |

新規単体テスト15件：現リリースNO-GO、計測→Botの順序、RUNNING/異常停止/完了、状態未取得・古い状態、Profit Guard無効、Sui正常確認期限切れ、API backoff、台帳不整合、45秒超の取得、復旧確認中、緊急停止、PAPER以外。

新規E2Eは各画面幅で以下を確認：

- 現リリースNO-GOで計測開始とPAPER開始を禁止し、POSTを送らない。
- テスト内だけGOをモジュール応答に注入し、計測開始→Bot開始→停止が別の正しいAPI/bodyで送信され、既存Bearer認証ヘッダーが付くことを確認。
- キャンセルでは送信せず、RESETは確認後のみ送信。RESET後にBotは停止したまま。
- 手動停止後の複数回の更新で無断開始・RESETが送られない。
- 確認画面を開いた後に監視APIが失敗すると、確認実行も無効になる。状態不明時は停止操作を残す。
- 812×375の横向き、reduced-motion、キーボードフォーカス、Escape、横スクロールなし。
- 計測開始済みなら、再開始ボタンを残さず完了したステップとして短く表示する。

既存の検証シナリオは、未開始、停止、稼働、通信失敗、足欠損、安全停止、途中、条件未達、合格、再起動、計測前稼働、表示更新失敗を維持。診断のリンクが外側の折りたたみも開くこと、キーボードで診断を開けること、レポートと監査情報を保持することを確認した。

全単体テストには、実APIを隔離起動する認証/設定/停止ゲート回帰、PAPER専用制約、安全復旧、監査・約定会計、循環参照/署名・送信禁止の検査を含む。既存の実運用サーバーには接続しない。

## 確認画像

- [現リリースNO-GO・375px](images/validation-ui/no-go-mobile.png)
- [テスト専用GO・1280px](images/validation-ui/mock-go-desktop.png) — モックの計測中・Bot手動停止後。実環境のGO判定ではない。

## 環境と限界

Windows上の既存依存関係を分離worktreeから参照。Node v24.14.0、Vitest 3.2.7、Vite 7.3.7、Playwright Chromium。リポジトリのNode指定は `>=24.22.1 <25` のため、この結果は指定版での検証を保証しない。Nodeのインストール・更新は行っていない。

既存の作業ブランチと未コミット変更は保持。実Botの開始・停止・RESET、Docker再起動、既存DB/検証履歴の変更・削除、LIVE取引の有効化は行っていない。取引戦略とサーバー安全条件は変更していない。

初回の全回帰で見つかった型参照の循環は共通型ファイルへの移動で修正し、全458件を再実行して合格。初期のE2Eでは折りたたみ移動に伴う古いセレクタを更新した。最終実行中はソースを変更せず、120件すべて合格。その後の表示短縮は関連64件と型チェック・本番ビルドで再確認した。

再実行コマンド（プロジェクトディレクトリで実施）：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build apps/dashboard
node node_modules/vitest/vitest.mjs run
node node_modules/@playwright/test/cli.js test tests/e2e/validation-control.pw.ts tests/e2e/validation-ux.pw.ts tests/e2e/operations.pw.ts tests/e2e/paper-recovery.pw.ts
```
