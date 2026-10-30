# PAPER配備安全性：第1段階の実装と保守手順

PR #28の[移行・リリース設計](WALRUS_SITES_CLOUD_ARCHITECTURE_20261030_JA.md)の段階1を実装する。契約・デプロイ・LIVE・取引の自動再開は含めない。初回導入時も旧workerを停止してから適用する。既存プロセスや既存DBに本開発作業を適用したわけではない。

## 実装した安全策

- workerは管理トークン等の起動検査後、取引/選択DBを開く前に、`DATABASE_PATH + .instance.sqlite` の専用SQLite接続で排他transactionを取得する。同じrootの2プロセス目とbackupは即時拒否される。OSによるプロセス終了で解放され、PIDの再利用やstale fileを自動削除する方式に依存しない。
- この接続はexit listenerで参照を保持し、GCによる早期解放を防ぐ。lockファイルは残し、稼働中に削除/置換しない。親ディレクトリの実pathを正規化し、既存DBとlockのsymlink/hardlinkを拒否する。異なるDB rootは別instanceとして動く。
- `DATABASE_PATH + .maintenance` の存在で変更APIとPAPER注文を拒否する。認証後の `GET /api/deployment` で状態を確認できる。start/reset/settings/pairs/backtest/validation開始を閉じ、認証済みstop/emergencyは維持する。session login/logoutは従来の認証経路を維持する。
- engineも取得前、分析後、非同期quote検証後、約定直前にgateを検査する。gate検査エラーも停止。観測後はプロセス内で停止を保持し、ファイルを消すだけで解除されない。再起動しても従来どおり取引はboot stoppedで、手動startを要する。
- bootごとに `.lifecycle.json` を新boot IDの `running` に置換する。SIGTERM/SIGINTではscheduler、取得、chart threadを止め、activeTick・HTTP応答・thread終了とDB close後にのみ `clean` を記録する。25秒強制終了/保存失敗はexit 1、cleanを記録しない。Linuxではreceipt fileと親ディレクトリをfsyncする。
- 保守CLIはworkerと同じinstance lockを使う。clean終了証跡、maintenance file、全取引DBのrunning=false、SQLite integrity/foreign key検査を必須とする。未知の同root SQLite DBは黙って除外せず拒否する。
- SQLite backup APIでWAL内容を含む自己完結snapshotを作り、保存先は新規ディレクトリ限定。manifestは最後に書き、各DBのSHA-256、schema hash、user_version、boot IDを記録する。大きなDBのhashは固定サイズbufferで計算する。
- verifyはpath traversal、symlink/hardlink、重複/未知DB、hash/schema不一致、注入されたWAL/SHM/journalを拒否する。restore-rehearsalは新ディレクトリだけに復元し、先にmaintenance fileを置く。元DBや既存ディレクトリを上書きせず、sessionや再開許可のreceiptを復元しない。
- 選択DBのselected_pairと実DB一覧を照合し、選択ペアの欠落・不正な選択・親取引DBのないchart-history・DB本体のないWAL/SHM/journal・manifestに列挙されない既存snapshotを拒否する。runtime/portfolio/settingsレコードの欠落も拒否する。snapshot/manifest/復元ファイルをfsyncし、Linuxでは新規ディレクトリと親もfsyncしてから完了する。
- VPS等の既存データを維持する起動には `REQUIRE_EXISTING_DATABASE=1` を指定できる。選択DB・選択中およびTRADING_PAIRで指定したDB・初期化済みのruntime/portfolio/settingsを、BotDatabaseによる自動作成より前に読み取り検査する。欠落/空DBで起動しない。既定0（未指定も同じ）は従来の初回DB作成を維持する。これは起動時の検査であり、新旧JSONの意味互換性・会計照合の代替ではない。

設計時のホストflockに代えて、Windows/Linux共通の専用SQLite排他lockをアプリ入口に実装した。取引DBの通常writer lockとは別で、取引DBの複数schedulerによる順次書込みを許してしまう問題を防ぐ。将来の配備helperには別途「配備transaction全体」の排他が必要である。

## Linuxでの保守手順（実際の適用は別途承認後）

コマンドはプロジェクトディレクトリをcwdとする。Node `>=24.22.1 <25`、pnpm/依存はreleaseと一致させる。下記pathは例であり、実環境に合わせて明示する。CLIはsystemd/Dockerの制御をしない。

```sh
# 1. 稼働中にも設定できる停止ラッチ。取引開始を許可する操作ではない。
pnpm maintenance maintenance-on /var/lib/suiba/bot.sqlite

# 2. 管理画面の正規stopを実施し、選択pairとrunning=falseを確認する。
# 3. 既存serviceを正常停止し、process/thread消滅とexit codeを確認する。
#    systemd使用時の例（実際のunit名を確認する）:
sudo systemctl stop suiba-paper

# 4. worker停止中だけ成功するローカルSQLite snapshot。
pnpm maintenance backup /var/lib/suiba/bot.sqlite /secure-staging/snapshot-001
pnpm maintenance verify /secure-staging/snapshot-001

# 5. 本番の上書きではなく、別の空きpathへ復元演習。
pnpm maintenance restore-rehearsal /secure-staging/snapshot-001 /secure-staging/restore-001
```

対象DBは基底SUI、WAL_USDC、pairs選択、各pairのchart-history。存在する全対象を同じ停止窓で保存し、取引DBが少なくとも1つ＋pairs DBが必須となる。snapshotにはPAPER履歴・設定・残高・Profit Guard等のDB内容が丸ごと入る。復元先のDBで全pairの残高/履歴/guard/選択を照合し、現行DBへ接続して試しにrollback互換を判定しない。

**保存物はローカルの平文stagingであり、off-host backupの完成品ではない。** Linuxはdirectory 0700 / files 0600、Windowsは適切なACLが別途必要。外部転送前の暗号化、復号鍵保全、report/validation出力を含めたbundle、保存先/世代管理/通知/容量/RPO/RTOは後続実装で必須。manifestのhashは破損検査であり、攻撃者によるmanifestを含む改ざんの認証署名ではない。未検証のarchiveを信頼して実運用へ戻さない。

復元演習の完了は本番復元・DB巻戻し・取引開始の承認ではない。実際のrestore/cutoverは現DB追加backup、schema/JSON意味互換性と差分履歴のレビュー、ユーザー承認を要する。

```sh
# 6. 手順レビュー後、workerが停止していることを確認してラッチを解除する例。
#    生存中ならinstance lock取得に失敗する。取引は開始しない。
pnpm maintenance maintenance-off /var/lib/suiba/bot.sqlite
# 再起動後もrunning=false。認証した人間が全安全条件を確認してから手動startする。
```

メンテナンス中にworkerを起動しても注文/変更操作は閉じるが、監視用DB更新は発生し得るのでbackup前には必ずプロセスを停止する。boot stoppedは従来と同じであり、maintenance解除は既存error/emergency/会計/接続gateを解除しない。Windowsのchild.killはPOSIXの正常SIGTERMではないため、強制終了後はbackupを拒否する。

## 限界と後続PR

- 専用lockを取らない旧binaryや手作業SQL、別root、共有FS/別hostを排他する機能ではない。初回導入・DB移行時は旧系を停止し再起動不能にする。NFS/ネットワーク共有上で使わない。
- このPRはDBスキーマを変更せずschema fingerprintを記録するが、新旧アプリのJSON意味互換性や逆migrationは保証しない。自動rollbackと本番in-place restoreは実装しない。
- メンテナンス観測までの既に完了した約定を取り消さない。SIGTERMはactiveTick完了を待つ。backupはinstance不在＋clean証跡＋停止DBが揃うまで拒否される。
- validation/reportや将来の認証DBのbackup inventory、暗号化off-host保存、配備helper/承認Environment/SSH、release artifact署名と世代照合は後続。
- 管理session失効・自動ロック・OIDC/gateway・Walrus portal/TLSは本PRでは未実装。現在のAPIをそのままInternet公開する承認にはならない。

## 検証

一時DB・一時workerだけを使用する。実ユーザーDB・既存稼働Bot・VPSは操作しない。Node 24.22.1のtypecheck/build、既存全テストと追加テストを確認する。

追加テストは、別プロセス競合/kill後再取得、lock接続の保持、停止ラッチ、遅延quote中の注文防止、全pair復元/履歴保持、clean/unclean/running検出、未知DB/改ざん/sidecar/path traversal拒否を扱う。実APIのテストは認証・保守中変更拒否・安全停止・二重workerを検証し、Linuxでは正常SIGTERM→clean→backup、Windowsでは強制終了→unclean→backup拒否を確認する。

既存offline suiteはloopbackテストを除外するため、GitHub ActionsのUbuntu/Windows双方で `deployment-api.test.ts` を別stepとして実行する。CIは公開/秘密情報を使わないfixtureのみで、デプロイ処理は追加しない。
