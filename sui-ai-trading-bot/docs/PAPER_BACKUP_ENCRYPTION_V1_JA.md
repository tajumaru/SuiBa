# PAPERバックアップの認証付き暗号化 v1

PR #29のSQLite snapshotを外部へ保管する前に、ローカルで暗号化する保守機能。Node `>=24.22.1 <25` の標準crypto/streamだけを使用し、外部契約・ネットワーク通信・取引用鍵・LIVEを必要としない。workerや元の取引DBを操作せず、既存の停止backup手順で作成・検証したsnapshotだけを入力にする。

## コマンド

cwdは `sui-ai-trading-bot`。入力・鍵ファイルと出力先の親ディレクトリが存在すること。出力ディレクトリは毎回新しい名前を指定し、既存の保存物・DBを上書きしない。

```sh
# 既存手順で正常停止後に作成したsnapshotを検証する
pnpm maintenance verify /secure-staging/snapshot-001

# 鍵ファイルのpathだけを指定する。鍵本体を引数・環境変数・ログへ渡さない
pnpm maintenance encrypt /secure-staging/snapshot-001 /encrypted/snapshot-001 /secure-keys/backup-v1.key

# 隔離された新規ディレクトリへ復号し、hash/schema/integrity/DB一覧を再検証する
pnpm maintenance decrypt /encrypted/snapshot-001 /restore-staging/verified-001 /secure-keys/backup-v1.key
pnpm maintenance verify /restore-staging/verified-001

# 復元演習も別の新規ディレクトリへ。自動で本番DBへ戻したり取引を開始したりしない
pnpm maintenance restore-rehearsal /restore-staging/verified-001 /restore-staging/rehearsal-001
```

新しい暗号化鍵を用意する場合は、管理者が安全な環境でCSPRNGから**32バイトのバイナリ**を生成して権限制限ファイルへ保存する。パスワード文字列やhex表記64文字のファイルではない。CLIは鍵を生成・表示・アップロードしない。本改修のテストは使い捨てfixture鍵のみを使用する。

Linuxでは鍵は実行ユーザー所有の通常ファイル、mode 0600等（group/other権限なし）を必須とし、symlink/hardlinkは拒否する。Windowsでは通常ファイル/32バイトは検査するが、ACLの適切さは管理者が別途確認する。鍵は入力snapshot・暗号化archive・復号出力のどのディレクトリ内にも置かない。暗号化データと復旧用の鍵を別のアクセス制御・障害領域で保管し、復元演習で両方を確認する。鍵を失うと復号できず、漏洩するとその鍵の保存物は読まれ得る。

## 保存形式と検証境界

- AES-256-GCM、各fileにCSPRNGの12バイトnonce、16バイトtagを使う。圧縮はせず、大きいSQLiteも固定サイズstream処理する。
- 公開headerは8バイトASCII `SBPAPER1`＋12バイトnonce。続くciphertextの末尾に16バイトtag。headerと用途識別子をAADに含め、version/用途を拘束する。
- `manifest.enc` は元manifest、DBサイズ、ランダムbundle IDを含むJSONの暗号文。用途識別子は `SuiBa/PAPER/manifest/v1`。復号前サイズを64KiB以下に制限する。
- 各DBは `db-0.enc` 等の固定名で保存。AAD `SuiBa/PAPER/data/v1/<bundle ID>/<index>` により別bundle/位置のciphertextを流用できない。元DB名・schema・履歴等は暗号化manifestの中に置く。
- 元snapshotのverifyに加え、暗号化streamの入力サイズ/hashを元manifestと照合する。読み込み中に内容が変われば完了しない。
- 全暗号文fileを保存・同期した後にのみ `COMPLETE` を作る。COMPLETEは完了目印であり暗号認証の代替ではない。各fileのGCM認証と元manifestのDB検査も必須。
- 復号ではまずmanifestの認証を完了し、version/安全なDB名/一覧/サイズを検査する。その後新規directoryを0700で作り、maintenanceラッチを置く。DBごとに0600の `.part` へstream復号し、GCM認証成功後だけDB名へ変更する。最終的に既存のverifyを通し、manifestとdirectoryを同期して完了する。
- 復号先へlifecycle clean receipt・セッション・自動再開の許可は発行しない。認証済みsnapshotであっても、本番復元・旧版互換・会計照合・手動startの判断は別。

AES-GCM認証は**鍵を保持していない相手による改ざん検出**であり、公開署名や第三者による出自証明ではない。鍵を持つ主体は保存物を作り直せる。正当な古いbundle全体のreplayや誤世代選択は防がないため、外部の保存台帳で日時/版/保存先を追跡し、復元対象を人間が確認する。

## 中断・失敗時

- 誤鍵、tag/header改ざん、切断/欠落、異なるbundleの混入、容量不足はエラーとし、成功を表示しない。元snapshot/archiveは変更しない。
- 通常例外とSIGINT/SIGTERMによるAbortはstreamを閉じ、この処理が新規作成した出力directoryだけを削除する。既存directoryは作成時に拒否し削除しない。CLIログは許可したエラー名/操作名のみで、鍵やDB内容/pathを出さない。
- SIGKILL、OS停止、電源断ではcleanupを保証できない。暗号化中の残り物はCOMPLETEなし、復号中はprivate directoryの `.part` 等が残り得る。途中成果物を本番へコピーしない。作業プロセス不在と対象pathを確認して管理者が隔離・削除し、新規pathで再実行する。
- 復号中の未認証bytesがprivateな一時fileへ書かれるため、復号先も暗号化disk等の適切な保存領域を使う。通常削除はSSD/backupを含む安全消去の保証ではない。既存の平文snapshotも自動削除しない。

## 範囲と残る作業

実装するのは暗号化・認証付き復号・障害検証のみ。off-hostへの転送、保存先credential、世代/保持/容量管理、鍵ローテーション台帳、validation/reportの追加inventory、RPO/RTO監視は後続。Internet公開、VPS契約/配備、LIVE、取引自動再開は行わない。

テストは一時DB・使い捨て鍵で、往復/nonceランダム性、誤鍵、tag改ざん、truncation、bundle入替、未完了archive、既存path保護、鍵分離、Unix権限、書込み中Abort、ENOSPC、CLIのPAPER限定を検証する。ENOSPCは実diskを埋めずstreamの書込み失敗を注入する。実際の電源断/物理disk障害/鍵保管サービスは検証しない。
