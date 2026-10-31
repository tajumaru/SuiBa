# さくらVPS: 最小権限・停止状態配備broker

対象: Ubuntu 26.04 / x86_64 / RAM 2GB / SSD100GB。基準main `aaebc0f`。
VPSの実SSH確認成功はユーザー報告。**今回はVPS接続・設定変更・実配備を行わない。**
本書のホストコマンドは後日の別途承認後に1つずつ実行する例で、一括実行用ではない。

## 採用方式と比較

| 方式                                     | 評価                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| root所有・固定引数なしの限定sudoラッパー | **採用**。短時間のbrokerだけがDockerへ到達。SSH主体はJSON要求と候補提出だけ。sudoグループへ追加しない                                              |
| systemd管理の限定配備サービス            | 常駐/queue/peer認証の管理が増える。既存native systemdのroot-owned launcher・固定unit許可は参考にするが、同じcontrollerを重複実装しない             |
| rootless Docker                          | host rootリスクを下げるが、SSH UIDにそのsocket全権を与えてもアプリ/volumeの権限限定にはならない。UID mapping、cgroup制限、既存volume移行が別途必要 |

`suiba-deploy`にはdockerグループ、sudoグループ、Docker socket ACL、汎用sudoを与えない。
許可するsudoは `/usr/local/sbin/suiba-deploy` **引数なしの1命令だけ**。stdinのJSONも厳密に検査する。
SSH/TLSでDockerへ接続するだけでは、daemonの操作範囲を限定できない。

## 配備の意味と安全境界

この実装の成功状態は **prepared_stopped**。
停止ラッチ→旧コンテナ正常停止→DB確認/backup/復元演習→候補コンテナ作成までで、
`up/start/restart` は実行しない。新しいWorkerプロセスもPAPER取引ループも起動しない。
restart policyはno。maintenanceは残す。起動・health受入は別途承認後の後続タスク。
従来deploy-vps.shの自動upとは意図的に異なる。legacyスクリプトをsudo実行してはいけない。

既存 `compose.vps.yaml`、非root/1GiB/V8 640MiB/PID128/loopback/管理認証/既存DB必須を再利用する。
`vps-data.mjs` のmaintenance、全DB integrity/foreign key、clean receipt、停止runtime、
instance lock、WAL/SHMコピーと復元検証を**管理者が固定したhelper image**で実行する。
候補imageのhelper・候補Compose・候補shell・候補.envをhost rootとして実行しない。
アプリ、Profit Guard、RiskEngine、安全停止、PAPER/LIVE拒否のコードは変更しない。

## ファイルと主体

| path                                                              | 所有と用途                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/usr/local/sbin/suiba-deploy`                                    | root:root 0755、引数なしwrapper。環境を消して固定Pythonを-Iで起動                                     |
| `/usr/local/libexec/suiba-deploy-broker.py`                       | root:root 0755。root-ownedな親を含め、SSH主体から変更不可                                             |
| `/etc/sudoers.d/suiba-deploy`                                     | root:root 0440。NOSETENV、引数なし限定                                                                |
| `/etc/suiba-deploy/{policy.json,compose.yaml,approvals/,docker/}` | root管理、ディレクトリ0700。固定helper ID、Compose hash、管理者承認。Docker configは空/管理者所有のみ |
| `/var/lib/suiba-incoming/<SHA>/image.tar.gz`                      | suiba-deploy所有0700のincomingへ転送する唯一の候補ファイル。**実行しない**                            |
| `/var/lib/suiba-deploy/`                                          | root 0700。lock、単調sequence、transaction、凍結Compose、receipt。SSH主体に変更権限なし               |
| `/opt/suiba/shared/runtime.env`                                   | root所有0600、既存の非秘密runtime設定。候補から上書きしない                                           |
| `/opt/suiba/shared/admin-token`                                   | UID1000所有0400等、親root0700。値はログ/Actionsへ出さない                                             |
| `/opt/suiba/backups/`                                             | root0700。cold tarをpartial→確定し、hash/metadataをroot receiptへ保存                                 |
| `suiba-vps-data`, `suiba-vps-reports`                             | 既存external volume。自動作成/削除/DB初期化をしない                                                   |

旧 `/opt/suiba/current` symlinkはbrokerから参照・更新しない。
現在の採用情報はroot ledgerとtransactionの凍結Composeで管理する。
既存のuser-owned releases内のコードをroot実行する経路を廃止する。

## 脅威と拒否条件

| 攻撃/誤操作                     | 拒否・固定する内容                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 任意引数/パス/image/root命令    | CLI引数禁止。JSONはoperation=deploy/rollbackと小文字40桁SHAだけ。余剰/重複キー・513byte以上を拒否                                               |
| 環境注入                        | wrapperがenvを消し、Python-I。Docker実行もPATH/HOME/DOCKER_CONFIG/DOCKER_HOSTを固定。shell=True/evalなし                                        |
| 偽装Compose/secret/volume/mount | root-owned ComposeのSHA256と展開モデルを検査。候補にある同名ファイルは無視。User/entrypoint/restartもroot policyで固定                          |
| symlink/hardlink/FIFO/親差替え  | openat/O_NOFOLLOWで各階層を開き、所有者・mode・regular/nlinkを確認。候補の親もリンク拒否                                                        |
| 検査後の差し替え                | root専用snapshotへ最大2GiBをコピーしてhash照合し、凍結コピーだけをDockerへ渡す。元を開き直さない                                                |
| 偽のSHA/label/checksum          | root管理者が別経路で用意する承認が必要。archive hash、image ID、image revision、platformを照合                                                  |
| 古いrun/再送/失敗後の再利用     | 単調sequenceと期限。変更前に承認を消費し、失敗時も同sequenceを再利用させない                                                                    |
| 不完全入力/DoS                  | stdin5秒/512byte、候補2GiB、同時flock、採用試行30秒間隔。incomingのディスクquotaはホスト側で別途必須                                            |
| 停止失敗/timeout/OOM            | exit0だけでなくRunning/OOM/clean receiptを確認。変更段階の失敗ではrestart禁止・stop/kill。確認不能はfailed_state_unknown                        |
| broker/CLI切断                  | helperに一意名を付け、CLI timeout時はそのhelperを削除。SIGTERM/HUPを捕捉。SIGKILL/電源断は処理不能なのでin_progressを残し管理者確認を必須にする |

入力不正・未承認等の**変更前拒否では既存サービスに触れない**。
承認を消費した変更段階からの失敗では、安全停止を優先する。
Docker/ディスク自体の障害時は停止やreceipt保存を保証できないため、固定エラーで中止しコンソール対応する。

## 管理者承認の仕様（自動署名検証ではない）

`approval.json.example` は故意にexpires=0/ci_run=0で、そのままでは拒否される。
信頼するubuntu管理者が、Actionsとは別の管理経路でroot-owned承認ファイルを作成する。
SSH提出主体は承認を発行/変更できない。Environment承認だけをroot承認の代わりにしない。

承認にはrepository/ref/main完全SHA、成功したci_run、**実際に採用するarchiveのSHA256**、
loaded image ID、operation、単調sequence、有効期限を記録する。
brokerはこのroot記録を信頼する。GitHub上のCI成功/main到達性を自動照会したり、
attestation署名を検証したりする実装ではない。管理者が独立に照合する責任が残る。
SHA labelやuploaderのimage-id.txt/checksumだけを根拠に承認しない。

承認対象archiveはCI生成の単一PAPER imageだけとし、未知のimage/タグを含むarchiveを承認しない。
Docker loadはroot daemonのパーサーを使う。承認済み成果物/daemon/OSの侵害まで無害化する保証はない。
承認コード自身はアプリのDB/管理トークンにアクセスできるため、アプリの悪意は別の信頼問題となる。

## Ubuntuで後日行う設定（今回は全て未実施）

### 1. 既存管理セッションと権限を確認

ubuntuのTera Term/コンソールで1行ずつ確認する。管理セッションを閉じない。

```bash
whoami
id -nG suiba-deploy
sudo -l -U suiba-deploy
```

ubuntuであること、suiba-deployがsudo/dockerグループに入っていないことを確認する。
既存の広いsudo許可が見つかったら、この手順で勝手に削除せず管理者レビューで止める。

### 2. 信頼できる管理者所有のstagingから固定コードをinstall

レビュー済みコミットを別途取得・照合したstagingで実施する。
suiba-deployのincomingやuser-owned releaseからrootコードをinstallしない。
以下のcwdはレビュー済み `sui-ai-trading-bot`。既存パスの所有者/用途を先に確認し、再帰chownしない。

```bash
sudo install -d -o root -g root -m 700 /etc/suiba-deploy /etc/suiba-deploy/approvals /etc/suiba-deploy/docker /var/lib/suiba-deploy
sudo install -d -o suiba-deploy -g suiba-deploy -m 700 /var/lib/suiba-incoming
sudo install -d -o root -g root -m 755 /opt/suiba /usr/local/libexec
sudo install -d -o root -g root -m 700 /opt/suiba/shared /opt/suiba/backups
sudo install -o root -g root -m 755 deploy/broker/broker.py /usr/local/libexec/suiba-deploy-broker.py
sudo install -o root -g root -m 755 deploy/broker/suiba-deploy /usr/local/sbin/suiba-deploy
sudo install -o root -g root -m 600 docker/compose.vps.yaml /etc/suiba-deploy/compose.yaml
sudo visudo -cf deploy/broker/suiba-deploy.sudoers
sudo install -o root -g root -m 440 deploy/broker/suiba-deploy.sudoers /etc/sudoers.d/suiba-deploy
sudo visudo -c
```

### 3. helperとpolicy、runtime/secret、既存volumeを準備

既知の成功CIのhelper入りimage archiveを管理者が別途照合してloadする（コンテナは起動しない）。
helperには初期化・backupのNode依存が含まれるが、brokerはmaintenance/verify/backup以外を呼ばない。

```bash
sudo docker load -i <独立照合済みhelperのarchive>
sudo docker image inspect --format '{{.Id}}' <helperの承認済みimage>
sudo sha256sum /etc/suiba-deploy/compose.yaml
sudo install -o root -g root -m 600 deploy/broker/policy.json.example /etc/suiba-deploy/policy.json
sudoedit /etc/suiba-deploy/policy.json
```

helper_imageに上の完全image ID、compose_sha256にroot設置ファイルのhashを設定する。
runtime.envは既存設定をroot管理にし、値をログへ表示しない。admin-tokenはUID1000読取可・親root管理を確認する。
この手順では管理トークンを生成・表示・コピーしない。DB/volumeも作成・初期化しない。

```bash
sudo stat -c '%u:%g %a %n' /opt/suiba/shared/runtime.env /opt/suiba/shared/admin-token
sudo docker volume inspect suiba-vps-data suiba-vps-reports
sudo test -S /var/run/docker.sock
sudo -u suiba-deploy test -w /var/run/docker.sock
sudo -l -U suiba-deploy
```

socketの存在確認は成功、suiba-deployのwrite確認は**失敗（終了コード1）**が合格。
sudo一覧は固定wrapper引数なしだけであること。値やDBファイルの内容は表示しない。
既存DBとclean receiptがない初回環境ではbrokerは拒否する。移行/初期化は別途承認する後続作業であり、
今回のPRは既存台帳を新しいPAPER残高で上書きしない。
incomingを別filesystem/ホストquota等で制限する設計も先に行う。brokerの2GiB上限はSFTPの総使用量制限ではない。

## GitHub Actionsと初回配備の順序（将来の別承認後のみ）

既存のworkflow_dispatch/main/DEPLOY-PAPER/Environment条件を維持し、さらに
Repository variable `SUIBA_BROKER_ENABLED=true` を要求する。今回は設定しない。
5つのSSH Secretsを再利用し、追加Secretsは不要。Environment Required reviewersを設定/確認する。
自己承認禁止の場合は別の承認者が必要。承認ルールを黙って緩めない。

1. このPRのレビュー/専用CI成功を確認し、別途承認後にmainへマージする。
2. ホスト側の限定sudo/policy/quota/既存DBを上記手順で別途構築・確認する。
3. 実Workerを含むフルCIを許可できる段階になってから、DEPLOY-PAPERをmainで手動実行する。
   現行の通常validateにはWorkerテストがある。禁止中はVERIFY-NO-WORKERのみを使う。
4. validateが作るimage.tar.gz、checksum、image-id.txtを、Environmentのdeploy承認前に管理者が確認する。
   GitHub上のmain SHA、成功run、artifactを独立照合し、root-owned承認を作る。
5. root承認ファイル名は `<完全SHA>.json`。sudoeditで例のschemaを記入し、root:root 0600にする。
   expiresはUTC epoch秒、sequenceは失敗分も含むledgerより大きい整数、ci_runは実際の成功run ID。
6. Environmentを承認すると、Actionsはimage archiveだけを非特権incomingへ転送し、
   stdin JSONで固定sudo wrapperを呼ぶ。Composeやshellは転送/実行しない。
7. `prepared_stopped` を確認し、root側ledger/receiptを管理者が確認する。Workerは作成済み・未起動。
   `SUIBA_BROKER_ENABLED` をfalseへ戻す。起動やmaintenance解除は行わない。

手順5で管理者が行うコマンド例（将来の承認後のみ）。SHAの文字列は独立照合した完全SHAへ置き換える。
既存の同名承認がある場合は上書きせず、原因を確認する。JSONの値や管理トークンをログへ表示しない。

```bash
RELEASE_SHA='ここを独立照合した小文字40桁SHAに置換'
[[ $RELEASE_SHA =~ ^[a-f0-9]{40}$ ]]
sudo test ! -e "/etc/suiba-deploy/approvals/$RELEASE_SHA.json"
sudo install -o root -g root -m 600 deploy/broker/approval.json.example "/etc/suiba-deploy/approvals/$RELEASE_SHA.json"
sudoedit "/etc/suiba-deploy/approvals/$RELEASE_SHA.json"
date -u -d '+1 hour' +%s
```

各行で失敗したら先へ進まない。最後の数値はexpiresの記入例であり、承認ファイルに自動反映しない。
編集時は全項目を実成果物と照合する。ci_run欄の数値だけで成功を証明したことにはならない。

例の要求形式（現在は実行禁止）:

```json
{ "operation": "deploy", "sha": "<40桁の承認済みmain SHA>" }
```

再実行で再buildしたartifactはhashが変わる可能性がある。古い承認を流用せず、同じrun/artifactを対象にする。
失敗後の再試行は新たなroot承認sequenceが必要。ledgerのin_progress/failed_state_unknownは、
管理者がコンソールで停止・helper残留・DB整合性・backupを確認し、同sequenceを維持した
reconciled_stopped等へ明示的に復旧するまで新しい要求も拒否する。ledgerを削除/sequenceリセットして回避しない。

## ロールバック

自動rollbackはしない。管理者が旧版と現DBのschema/JSON/会計互換性を確認し、
旧main SHA・旧archive/image IDに対するoperation=rollback、新sequence、新期限の承認を作る。
同じ固定wrapperへrollback要求を送ると、現DBの新しいcold backupを取って旧版コンテナを**未起動で作成**する。
DBを自動巻き戻し/削除せず、maintenanceも残す。

互換性が不明/破壊的変更があるなら、コードrollbackも中止して停止を維持する。
本番DB復元が必要な場合は別途承認し、現状退避・全ペア比較・独立した復元演習を行う。
このbrokerにrestore/init/delete/unlock/startのoperationは存在しない。

旧archiveを既定incomingへ転送し、管理者のrollback承認後にsuiba-deployが送る要求は次の形式。
通常ActionsのDEPLOY-PAPERはdeploy専用なので、rollbackの承認やoperationを自動変更しない。

```json
{ "operation": "rollback", "sha": "<独立承認済み旧mainの40桁SHA>" }
```

同じ固定wrapperへstdinで渡し、成功後もprepared_stoppedを確認する。

## 検証と残るリスク

- unit: 引数/JSON/パス/image/Compose、symlink/hardlink/FIFO、snapshot差替え、期限/sequence、失敗停止を偽Dockerで検証。
- Ubuntu26.04使い捨てcontainerでvisudo、固定sudo、追加引数/任意root命令/環境注入拒否を検証。
- 実Docker結合は単純HTTPプロセスとSQLite fixtureだけ。brokerの停止→WAL backup/復元→create-only、非root、1GiB/無swap/restart=noを検証。
- 既存WorkerなしCIとPAPER/認証/Profit Guard/RiskEngineのユニットを維持。実VPS/実Workerは今回使わない。
- root wrapperは新しい特権境界。独立したセキュリティレビュー、実ホストのsudo/PAM/ACL/cgroup/SSH/FW/quota確認が必要。
- root承認は手動照合であり署名/attestation検証ではない。誤承認・承認済み悪意あるアプリ・Docker/kernel脆弱性は残る。
- helper/Compose policyの更新も管理者の別レビューが必要。入力拒否でVPSが全くDoSされない保証はなく、SSH/UIDのresource制限も必要。
- SIGKILL/電源断/daemon障害ではcleanupと停止を保証できない。receipt欠落も含めてコンソール復旧が必要。
- 実Worker起動・health・停止/OOM復旧、2GBの長時間安定性、実データ量のbackup/restore、off-host暗号化保管は後続受入。
- helperの各Docker操作は180秒上限。大容量DBで不足する場合は停止のまま中止するため、実データ量で時間と空き容量を事前評価する。
- 実デプロイ/Worker開始/maintenance解除/LIVE有効化の許可を、このPRから推定しない。

仕様: [Docker socket](https://docs.docker.com/engine/security/protect-access/)、
[Rootless](https://docs.docker.com/engine/security/rootless/)。既存設計はPR #34、
既存運用は [SAKURA_VPS_JA.md](SAKURA_VPS_JA.md) と [LINUX_PAPER_RELEASE_V1_JA.md](LINUX_PAPER_RELEASE_V1_JA.md) を参照。

承認期限は受付時とsequence消費直前に再確認する。Docker出力は実行中に両pipeを並行排出し、stdout/stderr各1MiB（backup stdoutのみ8GiB）で拒否する。超過・timeout・例外時はCLIプロセスグループを終了・回収する。daemon側helperは既存の名前指定cleanupを併用する。quota・空き容量・backup保持管理は別途必須であり、この上限は容量予約ではない。
