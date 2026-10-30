# Linux常駐・PAPER停止配備 / rollback v1

対象はLinux x86_64の単一VPS、単一worker、既存SQLite。Node `>=24.22.1 <25` かつ**runtime patch/archがartifactと完全一致**する構成。今回はsystemd設定とローカル配備controller・検証を追加する。VPS契約、実hostへのinstall/配備、DB移行、公開、LIVEは行っていない。

## 配置と権限

| path | 所有・用途 |
|---|---|
| `/opt/suiba/runtime/bin/node` | root所有の固定Node。今回の検証は24.22.1。勝手にlatestへ更新しない |
| `/opt/suiba/releases/<40桁SHA>/` | root所有・group/other書込禁止の不変Linux artifact。コード、Linux node_modules、静的build、release.json。DBや.envを含めない |
| `/opt/suiba/manager` | root管理の固定controller artifactへのlink。mutableなcurrentを指さない。controller更新は別のレビュー/手順で行う |
| `/opt/suiba/tools/start-paper.sh` / `release-paper.sh` | root:root 0755。サービス起動/保守の入口。suiba以外をNodeコードload前に拒否 |
| `/opt/suiba/tools/apps/worker/src/linux-release-artifact.ts` と `/opt/suiba/tools/scripts/verify-node-version.mjs` | root:root 0644。releaseのtsxをloadする前に使う独立した検証helper。Node24のtype strippingで実行 |
| `/var/lib/suiba/` | suiba:suiba 0700。全pair DB、選択、chart-history、validation出力。releaseから独立し削除しない |
| `/var/lib/suiba-release/` | suiba:suiba 0700。current link、配備lock、active.json、transaction記録、処理中のprivate staging |
| `/var/backups/suiba/` | suiba:suiba 0700。transaction ID別の認証付き暗号化snapshot。外部への保存は別工程 |
| `/etc/suiba/` | root管理。paper.envは非秘密設定のみ。admin-tokenはroot:suiba 0640、backup.keyはsuiba:suiba 0600の32byte binary |

suibaはlogin shellを持たない専用ユーザーとする。必要時は管理者が `sudo -u suiba` で保守入口を実行する。releaseのコード/依存をrootとして実行しない。systemd unitとsudoersはroot所有でユーザーから編集不可にする。service内はNoNewPrivileges/ProtectSystem等を使い、backup keyとbackup保存先もInaccessiblePathsで隠す。ただし同一UIDの保守とserviceを完全に別の信頼主体へ分離する保証ではない。

## 初期構築（将来、別途承認後に実hostで行う）

1. 管理者がOS更新・firewall・SSH鍵・console回復経路を準備し、専用userと上表のdirectory/所有権を設定する。3100はloopbackのみ、Internetへ直接開かない。HTTPS/gateway認証は別PRで完成するまで公開しない。
2. 固定Node runtimeをroot管理で設置し `node --version` を確認する。Linux CIで同じpatch/archの依存をfrozen-lockfile installし、typecheck/build/test後にartifactを作る。tsxは実行時に必要なためdevDependenciesを機械的に削らない。
3. 下記packageコマンドはLinux CIでだけ実行する。Windowsのnode_modulesを転送せず、VPSでinstall/buildしない。artifactは通常ファイル/内部相対symlinkのみで、private file・外部link・特殊file・setuid/setgid/stickyを拒否する。全file/linkのdigestをrelease.jsonへ記録する。

```sh
# cwd: Linux CIのsui-ai-trading-bot。SHAは検証したmainの完全SHA。
pnpm release:linux package <40桁SHA> /ci-output/<40桁SHA>
sha256sum /ci-output/<40桁SHA>/release.json
```

4. 承認したCIのmanifest digestを独立に確認し、信頼したartifactだけを採用する。manifest/hash/SHA宣言だけでは出自の署名にならず、payloadとmanifestの両方を変更された場合は外部の信頼値が必要。archiveのrootでの無検査展開や、upload先での任意root script実行は行わない。安全な転送・展開の自動化はActions/SSH実装の後続範囲。採用後はroot所有・非書込にし、独立helperの `verifyLinuxRelease(path, SHA, true)` で再確認する。
5. reviewed controller artifactを `/opt/suiba/manager` に固定し、tools/helperを上表のpathへ設置する。`deploy/linux/start-paper.sh` と `release-paper.sh` はLFを維持して0755でinstallする。
6. `deploy/linux/suiba-paper.service`、`paper.env.example`、`suiba-release.sudoers` を確認してそれぞれ `/etc/systemd/system/suiba-paper.service`、`/etc/suiba/paper.env`、`/etc/sudoers.d/suiba-release` に設置する。`systemd-analyze verify` と `visudo -cf` が成功してからdaemon-reloadする。sudoersの許可は固定unitのstop/start/showのみ。
7. admin tokenとbackup keyは管理者が別途安全に生成・保管し、値をCI/画面/ログへ渡さない。今回のテストは使い捨てfixtureのみ。鍵を失えば暗号化backupを復元できない。Windows旧系を停止・再起動不能にし、既存DB一式を整合backupから移し、履歴/残高/guard/選択pairを照合する。DB欠落を新規初期化で隠さない。
8. initial currentを承認SHAへ向け、最初はmaintenanceを置いた状態で起動する。ラッパーがPAPER/loopback/port/DB/token path/既存DB必須を固定する。bootはrunning=false。初回の既存履歴移行と管理者による手動PAPER開始はこのcontrollerの自動操作にしない。

systemdはRestart=on-failure、10秒間隔/5分3回制限、停止猶予35秒。プロセス復旧と取引再開は別。workerの25秒強制終了はcleanではなく、復旧後も手動確認が必要。NodeのJIT等を壊すMemoryDenyWriteExecuteや未検証syscall filterは設定しない。実VPS上でsandbox/cgroups/DNS/TLS/権限とresource消費を検証してから常駐運用する。

## 通常更新：prepare → 外部保存確認 → activate → unlock

各操作はsuibaユーザーでroot所有の保守入口から実行する。UUIDはprepareが返したtransaction。CLIはservice名・path・localhost originを固定し、任意command/URL/shellを受け取らない。root実行も拒否する。以下は将来の実host用runbookであり、今回実行していない。

```sh
sudo -u suiba /opt/suiba/tools/release-paper.sh prepare <40桁SHA>
sudo -u suiba /opt/suiba/tools/release-paper.sh status <transaction UUID>
# /var/backups/suiba/<UUID> を承認した別障害領域へ保存し、認証付き復元を確認する。
# 次のflagは操作者の確認宣言であり、remote保存を自動証明するものではない。
sudo -u suiba /opt/suiba/tools/release-paper.sh activate <UUID> --offhost-backup-confirmed
sudo -u suiba /opt/suiba/tools/release-paper.sh status <UUID>
# VERIFIEDを確認してから監視を再開する。取引は開始しない。
sudo -u suiba /opt/suiba/tools/release-paper.sh unlock <UUID>
```

- prepare: current/候補artifactの全file・runtime・contractを検査し、transactionとmaintenanceを永続化。systemd stop後に状態とinstance lockの解放を確認する。clean receiptとrunning=falseを要する整合snapshot→暗号化→復号/integrity/履歴照合がすべて成功したらPREPAREDとなる。一時の平文copyは成功時に削除し、旧版は停止したまま。
- activate: PREPARED、旧current、外部保存の確認、承認時のmanifest digest、DB/schema/financial history fingerprintを再確認し、暗号化snapshotも再認証する。同一FSのsymlink renameでcurrentだけを切り替え、新版をmaintenance付きで起動する。
- verify: 無認証APIが401、認証済みprobeがPAPER/running=false/maintenance=true、期待SHA/lock hash、DB health・ledger okを示し、全pairのschemaと金融履歴/portfolio/settings/guard・緊急/errorが維持される場合だけVERIFIED。healthz 200だけでは成功にしない。
- unlock: 一度正常停止し、状態を再照合してからmaintenance fileを除去・再起動する。sticky gateを再起動で解除するが、boot stoppedは維持。COMPLETED後に人間が市場鮮度・接続・会計・緊急/error等の全start条件を確認し、必要な場合だけ正規UIから手動startする。ネットワーク/相場鮮度はこの配備probeのGO条件には含めず、取引開始の別gateで必ず検査する。

全操作は別のSQLite配備lockで直列化し、transactionはfsync/atomic renameで記録する。未完了transaction、古い承認、別current、削除された記録、改ざんartifact、DB変化を拒否する。例外時は可能な限りmaintenanceを維持してservice stopを試みFAILEDを記録する。ディスク/権限/systemd自体の障害では停止・記録が保証できないため、外部監視とconsoleでserviceの実状態を確認する。

## 失敗・rollback・cancel

```sh
# 新版の問題。DBを戻さず、互換条件がそろう場合だけ旧コードへ戻す。
sudo -u suiba /opt/suiba/tools/release-paper.sh rollback <UUID>
# ROLLED_BACK後もmaintenance付き。監視再開だけを許可する場合:
sudo -u suiba /opt/suiba/tools/release-paper.sh unlock <UUID>
# まだcurrentが旧版のままの失敗/prepare中断を、安全に取り消す場合:
sudo -u suiba /opt/suiba/tools/release-paper.sh cancel <UUID>
```

rollbackは完了前だけ。旧/新artifactのcontract/digestが同一前提、現在のserviceが正常停止、schema/全金融履歴等のfingerprintが配備前と一致する場合に限る。DB schemaや履歴が変わった場合は停止維持で拒否し、勝手な逆migration・backup巻戻し・履歴mergeをしない。JSON意味互換性はcontractの宣言だけでは証明できず、変更PRでの互換試験・人間レビューが必要。今回のcontrollerはschemaを変更するreleaseを自動適用するための機能ではない。

cancelはcurrentが旧版のまま、正常停止とDB検査が成功した場合だけ。履歴が配備前から変わっていれば取り消しも拒否する。CANCELLED後は必要に応じunlockで旧版の監視をstoppedで再開できる。FAILED/STOPPING等の記録を手作業で書き換えて進めない。

SIGKILL/電源断ではprocess lockはOSが解放するが、transaction/maintenanceは残る。再実行で未完了状態を見つけ、旧currentならcancel、新currentなら互換条件付きrollbackを検討する。途中のprivate平文stage/checkが残る場合は、実プロセスとpathを確認して管理者が隔離・削除する。コマンド切断を成功や取引再開とみなさない。

## 検証範囲と次段階

一時Linux container（Node24.22.1/Debian bookworm、networkなし）でunit/sudo構文、非root controller、packした実workerの停止・切替・rollback・履歴保持を試験する。root所有artifact＋専用userの本番launcherについても、誤MODE/host/port/path/Node optionsが上書きされ、認証・PAPER停止・clean終了を維持することを別containerで確認する。

container内のsystemdはPID1としてserviceを管理していない。systemdによるsandbox/cgroup/OS再起動、VPS地域の実通信、外部保存の実到達性、Windows旧系のfencing、iPhone/Safari/HTTPS/gatewayは実VPS/実機で別途受入が必要。GitHub ActionsのEnvironment承認・artifact出自証明・制限付きSSH転送は後続PRであり、今回のCIはテストだけで配備しない。

Node patch更新・ARM移行・schema/JSON契約更新は別計画とし、runtime/旧新artifactを同時に検証する。自動契約/公開/LIVE有効化/取引自動再開は一切追加しない。
