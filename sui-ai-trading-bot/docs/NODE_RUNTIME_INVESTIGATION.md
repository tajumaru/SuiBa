# Node.jsバージョン不一致の原因調査

対象main取得結果（2026-10-24 JST）: `f4c616fb25759488afa10513c2396939807b19db`。GitHub origin/mainと対象worktree HEAD一致、対象worktreeの変更なし。親worktreeの別ブランチ・未追跡MSI/ログ等は保全。

## 確認した原因

- Windows/Codexのshell PATH先頭のNodeは `C:\Program Files\nodejs\node.exe` **v24.14.0** (win32/x64)。pnpm 9.12.3 shimは `%AppData%\npm\pnpm.cmd` にあり、隣接node.exeがなければPATHのnodeを使用する。
- PATH後方のCodex同梱Node `C:\Users\yuake\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` も **v24.19.0**。Codexの内部runtimeと、shellで起動するNodeは別。両方とも要求未達で、Codex同梱ファイルは更新しない。
- 親worktreeに残るMSI更新ログで **Error 1730（旧版除去に管理者権限が必要）→Return value 3→exit 1603** を確認。以前のホスト更新は成功していなかった。MSI再実行やホスト全体の変更はしない。
- `.node-version`は既に24.22.1、package enginesも>=24.22.1 <25だが、shellは自動切替しない。nvm/fnm/VoltaはこのPATHで見つからず、.npmrcにengine-strictや実行前guardもなかった。直接tsc/vitest実行もguardを通らなかった。
- Dockerfileは単一stageの24.22.1タグで、build/runtime stage差はなし。digest未固定・実行時guardなし。実コンテナのNode/使用image/build cacheは今回は未確認。既存環境のNodeとローカル検証のNodeを同一視しない。
- GitHub Actions workflowは追跡済みソースに存在しなかった。lockfileはv9、pnpm固定9.12.3。Node固定はlockfileから自動適用されない。
- WSL一覧のみ読取: UbuntuはStopped、docker-desktopはRunning。Ubuntuは起動せずNode/pnpmは未確認。Docker distroには入らない。

## ホストを変更しない解決

公式 `https://nodejs.org/dist/v24.22.1/SHASUMS256.txt` とWindows x64 ZIPを取得しSHA256照合。ZIP hash: `d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5`。

プロジェクト内 `.runtime/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe` に展開し、実体の `process.version=v24.22.1 / platform=win32 / arch=x64` を確認。ホスト/PATH永続設定/Codex同梱runtimeには変更なし。実検証はこの絶対パスを使う。portable環境の自動選択と、間違ったNodeを拒否するguardを別々に実装する。

Docker Hub registryで `node:24.22.1-bookworm-slim` のOCI index digest `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`、linux/amd64 manifest `sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae` を取得確認。Docker CLI/daemonの操作・image pull/buildは行っていない。

Windowsの待受メタデータだけを確認し、3100/3101は待受あり、3104/3105は確認時に待受なし。サービスへ接続せず、Docker container/volume/secret/DBを読み書きしていない。3105が将来も空いている保証ではないため、承認後の開始直前に再確認する。
