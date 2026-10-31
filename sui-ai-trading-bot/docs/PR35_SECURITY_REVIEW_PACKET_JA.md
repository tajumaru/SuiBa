# PR #35 第三者セキュリティレビュー資料

作成日: 2026-10-31（日本時間）。対象: tajumaru/SuiBa、Draft PR #35。
実装レビュー対象は **b25b258582afe92573a90df1b173a7265c473f91**。
この資料を追加した後続HEADでは、実装を変更せず資料のみを追加する。
本資料は独立レビューの結論ではない。同じ実装担当による説明・再監査を、第三者レビューの代わりにしない。

## 1. 変更ファイルと読む順番

以下のパスはリポジトリルート基準。対象実装HEADのmainとの差分は13ファイル。

| ファイル                                                 | 役割                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sui-ai-trading-bot/deploy/broker/broker.py`             | root特権境界。要求、承認、パス、Compose、成果物を検査し、停止・バックアップ・未起動作成を制御 |
| `sui-ai-trading-bot/deploy/broker/suiba-deploy`          | 引数なしwrapper。環境を消去し固定Pythonを-Iで実行                                             |
| `sui-ai-trading-bot/deploy/broker/suiba-deploy.sudoers`  | 固定wrapperの引数なし実行だけをNOPASSWD/NOSETENVで許可                                        |
| `sui-ai-trading-bot/deploy/broker/policy.json.example`   | root管理のhelper image ID・Compose SHA256の例。未設定値のままでは運用不可                     |
| `sui-ai-trading-bot/deploy/broker/approval.json.example` | root承認schema。期限0・CI run 0の例は拒否される                                               |
| `sui-ai-trading-bot/deploy/broker/test_broker.py`        | 偽Docker、入力攻撃、sudo拒否、障害停止の回帰テスト                                            |
| `sui-ai-trading-bot/deploy/broker/verify_docker.py`      | 使い捨てCI上の実Docker/HTTPダミー/SQLite結合テスト                                            |
| `sui-ai-trading-bot/deploy/broker/.gitignore`            | Pythonキャッシュを除外                                                                        |
| `sui-ai-trading-bot/docker/Dockerfile.broker-test`       | Ubuntu26.04使い捨てsudoテスト環境。実ホストの設定には使わない                                 |
| `sui-ai-trading-bot/.dockerignore`                       | Pythonキャッシュをビルドcontextから除外                                                       |
| `.github/workflows/suiba-vps.yml`                        | 非特権archive転送と固定broker呼出し。追加の有効化gate                                         |
| `.github/workflows/suiba-no-worker.yml`                  | 既存検証にbrokerのsudo・Dockerダミー検証を追加                                                |
| `sui-ai-trading-bot/docs/SAKURA_DEPLOY_BROKER_JA.md`     | 方式比較、Ubuntu設定、承認・初回配備・rollbackの運用手順                                      |

本資料自身は14番目の資料ファイルとなる。
変更しないが必ず併読する既存コード: `docker/compose.vps.yaml`、`docker/deploy-vps.sh`、
`docker/vps-data.mjs`、`docker/verify-vps-offline.mjs`、Workerのdeployment-safetyとDB inventory。
legacy deploy-vps.shは自動upを含むため、この限定sudoから呼び出さない。

## 2. 主体と権限境界

- Actions/SSH主体はsuiba-deploy。incomingへの提出とoperation/SHA要求だけを許す。sudo/dockerグループ、socket ACL、汎用sudoを与えない。
- root管理者はwrapper/module、policy、Compose、runtime、承認、ledger、backupの親ディレクトリを管理する。incomingのコードをrootとしてinstallしない。
- brokerだけがroot Docker daemonへ固定コマンドを送る。要求にパス・image・コマンド・Compose指定を持たせない。
- 信頼済みhelperは管理者がimage IDで固定。UID1000、network none、cap-drop、read-only、メモリ/PID制限でmaintenance/verify/backupのみ実行。
- 候補アプリは管理者承認されたコードでも、DB・管理tokenに接する信頼主体。承認済み悪意あるアプリを無害化する保証はない。

openat/O_NOFOLLOW、所有UID/mode/nlink、親ディレクトリ検査、root専用snapshotによりリンク/差替えを制限する。
snapshotのhash検査後はユーザー所有archiveを開き直さない。Composeはrootファイルのhashと展開modelを検査する。
ただし実ホストのACL、追加sudoers、Docker plugin、root所有親、管理者侵害はソース検査だけで確定できない。

## 3. Actionsから未起動作成まで

1. 手動workflow_dispatch、main、確認入力DEPLOY-PAPERを要求。通常validateは既存Workerテストを含むため、現在の禁止中には実行しない。
2. runnerでimageをbuildし、archive、checksum、image-id.txtをartifact化する。
3. deployはさらにSUIBA_BROKER_ENABLED=trueとEnvironment sakura-vpsを要求。管理者はdeploy承認前に下記の独立照合を済ませる。
4. pinned known_hosts、専用鍵、非対話SSHでarchiveだけをincoming/完全SHA/image.tar.gzへ転送する。
5. 引数なしsudo wrapperへstdin JSONを送る。秘密鍵、管理token、候補shell/Compose/envはhost rootへ実行させない。
6. wrapperは環境を消去。brokerはcaller・入力サイズ/期限・schema・承認・sequence・root policy・snapshotを検査する。
7. modelを凍結し、既存external volumeとhelperを確認、承認hash一致archiveをloadしてimage ID/platform/revisionを検査する。
8. ledgerへin_progressを永続化して承認sequenceを消費。maintenance、旧コンテナstop40秒、Running/OOM/exit0、DB検査を実施。
9. cold backupと復元演習が成功したらcompose create --no-build --force-recreateのみ実施。
10. created/Running=falseを確認しprepared_stoppedを記録。restart=no、UID1000、1GiB上限。起動・maintenance解除は行わない。

入力不正など変更前拒否は既存サービスに触れない。変更段階の失敗は緊急停止へ進む。
成功しても実Workerのhealthを確認したという意味ではない。

## 4. 独立した成果物承認

管理者はSSH提出者のchecksumやimage-id.txtだけを根拠にしない。

1. GitHub上で採用するmain完全SHA、workflow定義、成功runとcheckout SHAを確認する。
2. 同runが生成した実archiveを独立経路で取得し、SHA256を計算する。再buildした別archiveと混同しない。
3. 信頼できる隔離検査環境でarchiveの構成とimage ID/revision/platformを照合する。未知の複数image/tagを含むarchiveを承認しない。
4. root-owned approvals/完全SHA.jsonへrepository、ref、sha、archive_sha256、image_id、operation、sequence、expires、ci_runを記入する。
5. sequenceは失敗消費分を含めledgerより大きく、期限は有効なUTC epochとする。別の確認者が値を照合する。
6. Environmentを承認して採用し、完了後は有効化変数をfalseへ戻す。

brokerはこのroot記録を信頼し、archive hash、loaded image ID、revision SHAを関連付ける。
ci_runは正整数検査であり、GitHub成功状態/main到達性/attestationをオンライン検証しない。
SHA labelも単独では証明にならない。Docker loadはdaemonのrootパーサーへ達するため、承認工程が重要な信頼境界となる。

## 5. 停止・restart無効化と修正済みP1

通常の停止対象は固定project/serviceラベルで検索し、複数対象を異常として扱う。
緊急停止では複数対象すべてにrestart=no、stop40秒、必要ならkill、Running=false確認を試みる。
最初の対象のupdate/stop/kill/inspect失敗でも後続対象を継続し、いずれかの確認不能は失敗として返す。
これにより失敗receiptはfailed_state_unknownとなり、再要求を管理者確認まで拒否する。

旧HEAD98b1b30の「複数対象で全停止を放棄」「restart無効化失敗を無視」はb25b258で修正済み。
test_emergency_stop_all_duplicates_despite_first_failureとtest_restart_disable_failure_is_not_confirmed_safeが直接の回帰テスト。
ラベルの異なるWorker、daemon不通、処理中SIGKILL、別管理者による再起動までは防げない。
restart無効化前の電源断では旧policyが残り、VPS再起動で旧Workerが起動する可能性がある。

## 6. DB・WALと復旧

既存volume必須。brokerにinitialize/restore/delete/start/unlock操作はない。
停止後、既存vps-data helperがclean lifecycle、runtime停止、全対象DBのintegrity/foreign keyを確認する。
instance lockを保持してWAL/SHMを含むディレクトリをscratchへコピーし、コピー側で復元整合性を検査してtarを出力する。
root backupはpartialに書き、file fsync、rename、親fsync、hash/metadataを記録してから候補を作成する。
実Docker CIでは別volumeにtarを復元し、WALに書いた証拠行が残ることも確認する。

instance lockは協調するアプリの多重起動防止であり、無関係なSQLite writerを強制排除するOSロックではない。
tar作成後の全バイト比較・本番全量復元まで自動保証するものではない。第三者はこの差を評価すること。
容量不足やhelper timeoutでは失敗し停止を優先するが、receipt保存まで失敗したらコンソール対応が必要。
partial/backup/state/imageの保持により容量は増える。scratchコピー分も見込む。2GiB入力上限は総量quotaや展開容量上限ではない。

in_progress/failed_state_unknownは、管理者が残留helper、全対象停止/restart、DB、backupを確認するまで解除しない。
ledgerを削除せず、sequenceを維持した明示的なreconciled_stopped等への復旧を別承認で行う。
rollbackは旧SHAへの新しいrollback承認で、現DBを新規backupし旧コードを未起動作成する。DB自動巻戻しはしない。

## 7. テストの証拠と未検証

実装HEADの[WorkerなしCI成功run](https://github.com/tajumaru/SuiBa/actions/runs/41187146955)。
本資料追加後のHEADについても同じVERIFY-NO-WORKERを実行し、その結果はPR/作業報告で示す。

| 検証                          | 範囲と限界                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 型チェック/build/監査済みunit | 既存PAPER・認証・安全機能の回帰。実Workerプロセスは起動しない                                              |
| broker unit/sudo（20件）      | schema、引数、環境、sudo、リンク、snapshot、期限/replay、偽Compose、失敗停止。偽Dockerによる故障注入を含む |
| ShellCheck/Compose/SSH mock   | 設定・shell・SSH拒否経路。実SSH接続はしない                                                                |
| Docker HTTP/process dummy     | health、正常SIGTERM、40秒timeout、1GiB OOM。実Workerの停止検証ではない                                     |
| broker実Docker/SQLite         | stop→WAL backup→別volume復元→create-only、UID/メモリ/restart policy                                        |

未検証: 実VPS、ホストsudo/PAM/ACL/cgroup、実WorkerフルCI/起動/停止/OOM、2GB長時間安定性、
実データ全量・容量不足・電源断・SIGKILLの全タイミング、off-host暗号化backup復旧。
Ubuntu26.04のsudoテストcontainerと、GitHub runnerのDocker結合テストは同一ホスト環境ではない。

## 8. 第三者に求める判断

各指摘に対象SHA・ファイル/行・攻撃主体・必要権限・再現条件・影響・P0/P1/P2・修正案を付ける。

- 引数なしsudo/NOSETENV、env -i/Python-Iから汎用root実行へ迂回できないか。
- root親の所有/mode検査とACL、openat/fd、snapshot間に攻撃可能な差替えがないか。
- Docker config/plugin/.env、root runtime、image metadataから権限・mount・commandを注入できないか。
- 正常/緊急停止の検索範囲、restart変更失敗、複数対象、途中例外で取りこぼさないか。
- 承認の失効・期限・sequence・同SHA再承認、archive再生成、余分image/tagの扱いが十分か。
- backup中のwriter排除とWAL/SHM、復元演習の範囲が要求する整合性を満たすか。
- SIGKILL/SSH切断/停電/daemon不通/ENOSPCでledgerと実状態がずれた際の復旧は現実的か。
- Actions編集権、Environment承認者、root承認者の分離が運用上成立するか。
- 2GB/100GBでhelper・Docker load・scratch・backup・出力captureのDoS上限が許容できるか。

## 9. マージと実配備の条件を分離する

**マージ前:** 別担当者の独立レビュー、P0/P1解消、最終HEAD WorkerなしCI成功、差分/実行gate再確認。
同じCodexの再監査だけで独立レビュー完了にしない。Draft解除/マージは別途許可が必要。
通常push/PR CIはWorkerテストを含むため、禁止継続中のmerge方法とskip ciも別途確認する。

**実配備前:** Required reviewersと自己承認方針、main制限、成果物独立承認者、root固定install、
suiba-deployの全sudo/group/socket ACL、runtime/token/既存台帳、quota・空き容量・保管、コンソール復旧を確認する。
2026-10-31の読み取り確認ではEnvironmentはmain限定だがRequired reviewersは未設定だった。現在値は配備前に再確認する。
SUIBA_BROKER_ENABLEDを現時点でtrueにしない。新規空台帳の準備・移行も別承認。
実Worker入り通常validateが許可されるまではDEPLOY-PAPERを実行しない。

本資料作成・レビュー・環境準備マージは、VPS接続/設定変更/配備、Worker/Bot起動、maintenance解除、LIVE/実資金取引の許可を意味しない。
具体的なUbuntuコマンドは[既存運用手順](SAKURA_DEPLOY_BROKER_JA.md)を参照し、この資料のレビュー中には実行しない。
