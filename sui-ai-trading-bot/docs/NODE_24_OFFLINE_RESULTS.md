# Node 24.22.1 オフライン検証記録

基準main `f4c616fb25759488afa10513c2396939807b19db` にNode guardを追加した作業ツリーで実行。最終報告コミットで全SHAを整理する。

実行日: 2026-10-24 JST。ホストの旧Nodeを変更せず、以下の実体を使用した。

```text
version: v24.22.1
execPath: D:\Source\SuiBa\.worktrees\validation-ux\sui-ai-trading-bot\.runtime\node-v24.22.1-win-x64\node-v24.22.1-win-x64\node.exe
platform: win32
arch: x64
pnpm: 9.12.3
pnpm entry: C:\Users\yuake\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs
```

`./scripts/project.ps1` が専用Nodeを選び、pnpm自体もそのNodeで起動。pnpm実行中の子PATHだけに同じNodeを先頭追加し終了時に復元。run-projectも子をprocess.execPathで直接起動するため、tsc/vite/vitestがPATH上の旧Nodeへ戻らない。NODE_VERSION_VERIFIEDのJSONで実行パス・version・platform・archを出力した。

| 実行 | 結果 |
| --- | --- |
| `./scripts/project.ps1 typecheck` | tsc --noEmit成功 |
| `./scripts/project.ps1 pnpm --version` | guard成功、9.12.3 |
| `./scripts/project.ps1 pnpm run build` | tsc成功、Vite本番build成功（190 modules）。既存Zod注釈警告のみ |
| `./scripts/project.ps1 pnpm run test:offline` | **38ファイル、500成功、7skip、失敗0** |
| 実際のC:\Program Files\nodejs\node.exe(v24.14.0)でrun-project typecheck | NODE_VERSION_REJECTED / NODE_VERSION_UNSUPPORTED、exit非0。tsc未開始 |

前回は37ファイル488成功。新規`node-version.test.ts`12件（要求5境界を含む8判定、実runtime情報1、開始前拒否2、設定整合1）が増分。テスト内の24.14.0/25.0.0拒否の2件は子process内のversions値を注入した模擬試験であり、実Node25をインストール/実行した主張ではない。実旧Node拒否は上記の別実行で確認した。

SQLite lock11件、BotEngine recovery25件、Sui health14件、観測12件、既存会計/注文整合の回帰を含む。新規一時DB/メモリDBのみ。保存BUSY/READONLY/COMMIT失敗、fail-closed、追加retry抑制、手動停止維持、注文ゲート拒否が要求Nodeでも成功。実注文・実送金は0。既存会計テストの一時DB上の模擬fillは実取引ではない。

offline configはsocket connect/listenを禁止し、loopbackを使う7件をskip、settings-api/deepbook-transportの2ファイルを除外。実Sui/DeepBook、Docker、既存3100/3101、PAPER運転には接続していない。CIのWindows/Linux matrixは設定追加だけであり、GitHub Actions実行結果とWSL/Linux実測は今回まだ未確認。
