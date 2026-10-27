# 復旧導線・モバイル表示の検証記録

実行日: 2026-10-27 / Windows x64 / Node.js **v24.22.1** / pnpm 9.12.3。
最終基点main: `f03f7be869a28c7d4ab81dbcb2605dc852551ae3`。
作業中に入った設定画面の更新へrebaseし、全検証を再実行した。

| 検証                                 | 結果                                                         | ログ                                               |
| ------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------- |
| Nodeの要求バージョン・実行パス       | `>=24.22.1 <25` に適合                                       | [runtime.log](runtime.log)                         |
| 型検査・本番ビルド                   | 成功                                                         | [build.log](build.log)                             |
| 単体・実HTTP API・認証・PAPER限定    | 74ファイル、1,038件成功。別途Node標準テスト45件成功          | [unit-and-api.log](unit-and-api.log)               |
| 既存CIと同じオフライン検証           | 72ファイル、1,008件成功、8件除外。別途Node標準テスト45件成功 | [offline.log](offline.log)                         |
| 最終UI・実況の回帰検証               | 7ファイル、210件成功                                         | [final-ui-regression.log](final-ui-regression.log) |
| WebKit / Chromiumの復旧・モバイルE2E | 56件成功、終了コード0                                        | [e2e-mobile-recovery.log](e2e-mobile-recovery.log) |

プロジェクトディレクトリでの再実行コマンド:

```powershell
node scripts/verify-node-version.mjs
node scripts/run-project.mjs build
node scripts/run-project.mjs test
node scripts/run-project.mjs test:offline
node node_modules/@playwright/test/cli.js test --config playwright.mobile-recovery.config.ts
```

E2EはWebKitの375×667、375/390/430×844、844×390と、Chromiumの390×844、1280×900を対象とする。
通信異常→安全確認→復旧、手動開始待ち、自動再開の取消、開始拒否409、状態取得失敗、GETだけの再取得・診断、停止解除を行わない診断遷移を検証した。
吹き出し・キャラクター・状態表示の非重複、横はみ出しがないこと、各復旧操作がスクロールで到達でき44px以上のタッチ領域で下部ナビに隠れないことも測定した。

実APIテストは認証済みリクエストを通して、診断GETを繰り返しても復旧確認が進まず、`PAPER_RECOVERY_REQUIRED` の409が継続することを確認した。
手動停止後は自動再開意図が消え、安全確認が完了しても自動再開しない。

表示確認: [通信異常](webkit-375-communication-failure.png) / [手動開始待ち](webkit-375-manual-stop.png)。
画面外の操作は縦スクロールで到達する。実機iPhone Safariの確認は含まない。

Windows sandbox内ではloopback通信・一時ファイルrenameが制限されたため、該当検証は同一コード・Nodeでsandbox外から再実行した。
本番ビルドは成功し、Rollupの注釈と500KB超チャンクの警告が出ている。
