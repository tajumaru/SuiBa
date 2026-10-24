# Node 24.22.1適用・独立Docker事前確認 最終報告

対象: tajumaru/SuiBa / main / sui-ai-trading-bot。2026-10-24 JST。

- [原因調査](NODE_RUNTIME_INVESTIGATION.md)
- [要求Nodeでの検証記録](NODE_24_OFFLINE_RESULTS.md)
- [実行パス・binary/config/test reportのhash証拠](NODE_RUNTIME_EVIDENCE.json)
- [Docker事前確認と承認後30分手順](NODE_DOCKER_30M_PREFLIGHT.md)

## 最新ソースと既存作業の保全

開始時 `git fetch origin main`を実施し、最新origin/mainと対象main HEADはともに`f4c616fb25759488afa10513c2396939807b19db`。対象main worktreeはcleanだった。別の親worktreeはperf/display-aggregationにあり、未追跡MSI/ログ/tools/レポート等を保持した。checkout/reset/clean/stash/既存作業の破棄はしていない。

今回のcode/test/treeは`03edd2c9323897ea746451dad04d330fd0c89a7a`でコミット済み。最終報告コミットSHAとpush結果は最終応答に記載する。pnpm-lock.yaml、既存.node-version（24.22.1）、依存version指定は変更なし。

## Nodeが反映されなかった原因

Windows PATHの先頭は旧Node24.14.0、後方のCodex同梱Nodeも24.19.0だった。既存MSI更新は管理者権限不足のError1730/exit1603で失敗していた。.node-versionとenginesは宣言だけで、バージョン管理のないPowerShellでは切替しない。pnpm shimもPATHのNodeへ依存し、実行前guard/engine-strict/CI固定もなかった。Dockerのタグ指定はホストのNodeを更新しない。

公式24.22.1 Windows x64 ZIPを公式SHASUMSと照合して、プロジェクトのGit/Docker対象外`.runtime`へ展開。ホストOSのNode、永続PATH、Codex同梱runtimeは更新していない。

## 各環境の確認結果

| 環境 | Node / 実行パス | platform / arch / pnpm | 確認範囲 |
| --- | --- | --- | --- |
| Windows通常PATH / Codexのshell初期値 | v24.14.0 / C:\Program Files\nodejs\node.exe | win32 / x64 / pnpm shimはAppData\Roaming\npm | 旧版のまま。今回の検証には使用せず、guardが拒否 |
| Codex同梱runtimeのbinary | v24.19.0 / C:\Users\yuake\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe | win32 / x64 / 同梱pnpmは未確認 | binary実行で確認。SuiBaのshellやDockerと同一視しない |
| SuiBa専用runtime / 実テスト | **v24.22.1** / 下記絶対パス | **win32 / x64 / pnpm9.12.3** | 型検査/build/全offlineの実行に使用 |
| WSL Ubuntu | 未確認 | distroはWSL2 / Stopped、Node/arch/pnpm未確認 | 起動せず一覧のみ |
| Docker Desktop / 既存container | Node・実application image ID未確認 | docker-desktop distroはRunning、内部arch/pnpm未確認 | Docker daemon/CLI未操作 |
| 新base image候補 | 24.22.1 tag / OCI index digest確認済み | linux/amd64 manifestも確認。コンテナ内execPath/pnpm実測は未実施 | Registryのみ。pull/build/runなし |
| GitHub Actions | setup-node24.22.1、Windows/Linux matrixを新設 | 実run結果は未確認 | workflow設定のみ |

実際の検証Node:

```text
D:\Source\SuiBa\.worktrees\validation-ux\sui-ai-trading-bot\.runtime\node-v24.22.1-win-x64\node-v24.22.1-win-x64\node.exe
v24.22.1 / win32 / x64
SHA256 d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5
```

pnpmは`C:\Users\yuake\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs`を上記Nodeで直接実行し、9.12.3を確認。launcherは子process用PATHを一時固定して復元し、run-projectはprocess.execPathでtsc/vite/vitestを起動する。通常の`node --version`が旧値でも、実テストで使用したbinaryとは異なることを区別する。

## 修正した設定と使用方法

- package.json: engines >=24.22.1 <25は維持。typecheck/test:offline/verify:node追加、既存task名/引数を維持して共通guard付きdispatcherへ変更。
- .nvmrc新設、.node-version既存24.22.1維持。.npmrcにengine-strict=true。
- verify-node-version.mjs: 実processのversion/execPath/platform/archを検証・出力。24.22.1未満、25以上、prerelease/不正値は拒否。Windowsの大文字小文字/リンクをrealpathで解決。production用のversion上書きenv/skip flagは設けない。
- run-project.mjs/project.ps1/setup-project-node.ps1: 専用portable選択、公式hash検証、同一Nodeでpnpmと子taskを実行。MSIやホスト全体の変更なし。
- worker入口とDocker runtimeにenforce preload、default/offline Vitest configとoffline setupにもassertionを追加。CI/type/build/testでエラーを無視するcontinue-on-errorやguard後の無条件続行なし。任意の直接tsc起動を公認検証経路とはしない。
- .github/workflows/suiba-offline.yml: 明示24.22.1、pnpm9.12.3、guard→frozen install→type/build/offline。WSLのversionを暗黙に流用しない。
- Dockerfile: 公式確認済みdigest固定、単一stage、guard/scripts COPY、build/runtimeの両方でguard。
- compose.preflight-30m.yaml: 新規project/image ID/SHA/secret必須、3105、新volume、restart=no、read-only root、停止状態で観測。
- .gitignore/.dockerignore: portable archive/binaryを除外。

今後のWindowsでの公認検証例:

```powershell
# fresh checkoutでportableがなければ、公式配布へのアクセスが許可された時だけ実行。
./scripts/setup-project-node.ps1
./scripts/project.ps1 pnpm --version
./scripts/project.ps1 pnpm run typecheck
./scripts/project.ps1 pnpm run build
./scripts/project.ps1 pnpm run test:offline
```

これらのコマンドはworker/PAPERを起動しない。WSL/Linuxでは別途その環境に24.22.1を用意し、公認package taskのguardを通す。dev/smoke/verify:runtime等は起動・ネットワークを伴い得るため今回実行していない。

## 実検証結果

| 項目 | 結果 |
| --- | --- |
| 実Node24.22.1で型チェック | 成功 |
| 実Node24.22.1で本番build | 成功。190 modules、既存Zod注釈警告のみ |
| 実Node24.22.1で最終offline | **40ファイル / 506成功 / 7skip / 失敗0** |
| 旧Node24.14.0でtypecheck開始 | guardがexit1で拒否、tsc未開始 |
| 要求5境界 | 24.14.0/24.22.0/25.0.0拒否、24.22.1/24.23.0許可をunitで確認 |
| SQLite安全性 | lock11件、BotEngine recovery25件、Sui health14件/観測12件ほか会計/注文整合が成功 |
| 受動計測/隔離設定 | 各3件のmock/staticテスト成功、実Dockerロードは未検証 |

前回37ファイル488成功から、Node12件 + 受動計測3件 + Docker静的設定3件を追加して+3ファイル/+18件。境界値の24.23.0/25.0.0等は模擬version判定であり、その実Nodeをインストールした主張ではない。今回の実検証は24.22.1。旧24.14.0は実binaryでも拒否を確認した。

socket connect/listen禁止setupを使用。実socketの7件はskip、settings-api/deepbook-transportの2ファイルとE2Eは未実施。新規一時/メモリDBのみで、既存DB/volume/稼働Botに触れていない。実注文・送金・LIVE有効化は0。既存会計回帰に含まれる一時DB上の模擬fillは実取引ではない。

JSONテスト結果の実値から証拠JSONを生成し、実Node binary hash・report hash・主要source hashを記録した。raw JSONはGit対象外の新規dataディレクトリに保持。source hashはWindows作業ツリーのバイト列であり、Linux checkout/imageのCRLF差を無条件に同一と扱わない。

## Docker事前確認と未確認事項

公式Node配布とDocker Hub Registryの存在確認だけを行い、Docker CLI、pull/build/run/compose/execは一切実行していない。既存imageを上書き・削除していない。

固定base: `node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`。既存3100/3101は待受あり、3104/3105は確認時待受なし。これはcontainer識別や将来のport確保を保証しない。

新composeのYAML構文・guard COPY・単一stage・保護port非参照・新volume/secret必須・restart=noを静的確認。Dockerによるconfig解決、cache、mount生成、権限、実application image ID、コンテナ内Node、WSL Ubuntu Node、CI実行結果は未確認。承認後に新imageだけをbuildし、network noneの新コンテナで実Nodeを検証してから起動構成を照合する。

## 30分準備状況・残存リスク・判定

必要な設定・手順・受動計測コード・停止条件を作成済み。既存RPC経路だけでSui HTTP/gRPC/metadata、DeepBook、取得周期、event loop、SQLite時間/BUSY、DB fault、注文/約定0を記録する。DeepBook成功時の詳細phaseなど現経路が公開しない値は未計測として扱い、追加RPCや推定値で補完しない。

受動metricsはprototypeの同期戻り値/例外を保ち、新RPC/SQLを追加しない。histogramは累積/固定メモリ、timerを解除可能、stdout backpressureは無視せず異常終了へ伝播させる。独立構成だけがロードし、通常workerの挙動には追加しない。既存observerのローカルread/JSONL記録とmetricsのCPU/I/O負荷は実環境で未実測。ログ末尾欠落や計測不能は正常値に補完しない。

SQLite busy_timeout=0とsticky DB fault、Sui同期証拠保存、通常のtimeout/retry/TTL、手動停止/復旧条件を維持。fsync/巨大SQL/OSの停止まで解消したとは主張しない。

**要求Nodeでのローカル検証・静的準備はGO。Docker実行/30分実通信開始はNO-GO（未承認、実image確認未完了）。** 次の承認範囲は新image build、network noneでの実Node確認、隔離構成の照合、停止状態での30分観測とその専用環境停止/証拠保全。30分では長時間安定性を証明しない。24時間PAPER、Bot開始、LIVEは別承認。

## コミット

1. `0077791` 原因調査
2. `1dfacf6` Node固定・自動検証
3. `a48eea8` 要求Nodeオフライン回帰
4. `03edd2c` Docker独立構成・受動計測・静的確認
5. 最終報告/実行証拠（本コミット、SHAは最終応答）

ユーザー指定に従いmainへpushする。外部アクセスはGitHub取得/push、公式Node配布、公式Docker Registryの読み取りに限定し、実Sui/DeepBook/既存サービスへの接続、Docker操作、PAPER運転は行っていない。
