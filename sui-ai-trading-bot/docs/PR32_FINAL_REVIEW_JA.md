# PR #32 マージ前レビュー（2026-10-31）

判定対象は環境準備PR。**最終HEADの専用「Workerなし検証」CI成功を条件にマージ可**。
実運用開始の承認ではない。実Workerの初回起動・移行起動・OOM復旧の結合検証と
2GB VPSでの長時間検証は、起動禁止の解除後に行う運用開始前の条件として残す。
既存のフルCIを代替したと解釈せず、必要なブランチ保護チェックも迂回しない。
実際の最終HEADと専用CI結果URLはPR本文に記録する。

## 検出した問題と修正

- **P1: maintenance作成失敗時に既存Workerが残る。** 失敗ハンドラーを作成前に登録。
  Compose設定に依存しないラベル検索で再起動を禁止し、40秒停止→失敗時kill→停止状態確認。
  Dockerデーモン自体が応答しないときの停止保証は不可能なので、CRITICALと非0終了で
  状態不明を明示し、運用者対応を要求する。
- **P1: バックアップがtar成功だけで確定される。** instance lock、clean lifecycle、
  停止済みruntime、全DBのintegrity/foreign key検査、WAL/SHM付きディスクコピーの
  復元検証を追加。終了コード0だけでなくRunning=falseとOOMKilled=falseも要求。
  不完全アーカイブは.partialとし、成功時にSHA256とfsyncを行う。
- **P2: 空の初回ボリュームを既存DB必須設定で起動できない。** 明示確認付きの
  オフライン初期化を追加。既存データを上書きせず、PAPERの既定残高と停止状態を保存する。
  デプロイスクリプトは初期化を自動実行しない。
- **P2: read-onlyヘルパーのtsx一時キャッシュ。** 実コンテナ検証で書き込み失敗を検出。
  データ操作ヘルパーにもサイズ制限付きtmpfsを追加し、UID1000とメモリ/PID制限を明示。

## 項目別の証拠と限界

| 項目                    | 確認内容                                                                                                                   | 残る制約                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1. maintenance          | 実イメージ・外部ボリュームでUID1000作成。fsync、symlink/hardlink拒否。read-only時の拒否も検査                              | 本番ディスクの所有権は未確認                           |
| 2. 作成失敗             | 本物のデプロイシェルを偽Docker CLIで実行し、restart=no・停止・killフォールバック・新規up禁止を検査                         | 実Workerでの異常注入は未実施。Docker停止時は運用者対応 |
| 3. SIGTERM              | 実Compose上のHTTPプロセスが0終了。SIGTERM無視プロセスは40秒後に137終了。シェル回帰で0のみ許可、1/137/OOMを拒否             | 実WorkerのSIGTERMはコードレビューと前回CIの結果        |
| 4. コールドバックアップ | オフラインSQLite書込プロセスをSIGKILLしてWAL/SHMを残し、raw tarに両方を含め、別ボリュームへ復元。WAL内の行とDB整合性を検査 | 実運用データ量/空き容量での時間測定なし                |
| 5. 初回・移行           | 空ボリュームのオフライン初期化・再初期化拒否・復元ボリュームの既存DB検査                                                   | 実Worker起動は両経路とも禁止により未実施               |
| 6. Compose結合          | 本番Composeを基礎に、ネットワークnone・ランダムな専用ボリューム・単純HTTPプロセスでhealth、停止、再作成、データ維持を検査  | HTTPテスト用プロセスであり実Worker結合ではない         |
| 7. メモリ/OOM           | inspectで1GiB RAM/合計1GiB RAM+swap、40秒停止、read-only、非rootを確認。1GiB上限下の割当プロセスを実際にOOMKillし137を確認 | 2GB VPSの長時間安定性、実WorkerのOOM復旧は未実測       |
| 8. CI                   | bb73e4fの既存Windows/Linux CIと追加VPS CIは成功。最新HEADには別のWorkerなし検証を実行                                      | 実Workerを含むフルCIは今回未実行。両者を混同しない     |

## 再現する検証

以下はWorkerを起動しない。実イメージbuildには型チェック・ダッシュボードbuildを含む。

```bash
docker build -f docker/Dockerfile -t suiba-vps-review:local .
node docker/verify-vps-config.mjs
node --import tsx --test docker/vps-data.node.mjs docker/vps-deploy.node.mjs
node docker/verify-vps-offline.mjs suiba-vps-review:local
bash -n docker/deploy-vps.sh
shellcheck docker/deploy-vps.sh
```

追加データ/シェル回帰はLinuxで実行する。11件成功。
既存の安全なユニットテスト78件（VPS設定、Docker設定、OperationMonitor、PAPER recovery）も成功。
実Docker検証はローカルDocker DesktopのLinuxカーネルで行い、使い捨て資源のみを削除する。
本番ボリューム・VPS・実Workerには触れない。

最新の全CIを再実行すると、既存 `suiba-offline.yml` のdeployment-api、
linux-release-process等が実Workerを起動するため、起動禁止の解除後にのみ実施する。
今回既存CIを無効化/削除する変更は行わない。

前回CI: [Windows/Linux](https://github.com/tajumaru/SuiBa/actions/runs/41168438003)、
[VPS検証](https://github.com/tajumaru/SuiBa/actions/runs/41168438096)。
停止・制限の仕様: [Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/)、
[メモリ制限](https://docs.docker.com/engine/containers/resource_constraints/)。

## Workerを起動しない専用CI

`.github/workflows/suiba-no-worker.yml` は型チェック、build、監査済みユニット、
データ/シェル回帰、ShellCheck、Compose展開、Docker build、ダミープロセスの
結合検証を行う。SSHステップ、VPS secrets、deploy jobは持たない。
`vitest.no-worker.config.ts` は対象ファイルを明示し、Worker entrypointの読込、
ユニットテストからの全子プロセス起動、実ネットワーク接続を拒否する。
新しいテストは監査してリストへ追加する。

既存 `suiba-offline.yml` は変更しない。既存VPS workflowにも通常の検証・デプロイ条件を
残し、手動入力が `VERIFY-NO-WORKER` の場合だけ専用workflowを呼ぶ経路を追加する。
この経路では従来validateとdeployはskipされる。通常push/PRの既存CI動作は維持する。
起動禁止期間中のpushは `[skip ci]` を付けて既存CIの自動Worker起動を避け、
その後、登録済みVPS workflowを対象ブランチに対して明示的にdispatchする。

```bash
gh workflow run 402469596 --repo tajumaru/SuiBa --ref codex/sakura-vps-deploy \
  -f confirmation=VERIFY-NO-WORKER
```

専用CIのsuccessは、実Workerを含むフルCIのsuccessを意味しない。
フルCIは起動禁止の解除後に別途実施する。既存CIの削除・無効化は行わない。
