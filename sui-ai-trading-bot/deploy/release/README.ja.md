# 署名付き停止配備の初回設定

既存の配備broker、controller、Composeを利用する。ビルドとステージング後、独立したEnvironment承認を受け、承認ファイル作成・必要な復旧許可・停止配備・完了確認を実行する。

## 初回のみ必要な管理者作業

以下はレビューとVPS変更の承認後に実施する。ソースはレビュー済みコミットを使用する。既存ファイルがあればバックアップとハッシュ照合を伴う更新手順に切り替える。

1. 安全な管理者端末で、新しいEd25519署名鍵を作る。SSH鍵や管理tokenを再利用しない。

       umask 077
       test ! -e release-approval.pem && test ! -e release-approval.pub
       openssl genpkey -algorithm ED25519 -out release-approval.pem
       openssl pkey -in release-approval.pem -pubout -out release-approval.pub

2. 公開鍵だけを管理者用VPS stagingへ転送し、両端でSHA-256を照合する。root所有・600・上書き禁止で /etc/suiba-deploy/release-approval.pub に配置する。VPSに署名秘密鍵は配置しない。
3. deploy/release/release.py を /usr/local/libexec/suiba-stopped-release.py、deploy/release/suiba-stopped-release を /usr/local/sbin/suiba-stopped-release にroot所有・755で配置する。ソースSHA-256とPython構文を確認する。
4. deploy/release/suiba-stopped-release.sudoers をvisudo -cfで検証して /etc/sudoers.d/suiba-stopped-release にroot所有・440で配置する。sudo -l -U suiba-deployで追加権限が引数なし固定コマンド1件だけであることを確認する。brokerとcontrollerはPR #58以降の版が必要。
5. GitHub Environment sakura-vps に新しいSecret VPS_RELEASE_APPROVAL_KEYを登録する。内容は署名秘密鍵。安全な入力欄か標準入力を使い、画面・ログ・コマンド引数・Gitへ値を出さない。既存のSSH Secrets 5件は再利用する。
6. Environmentをmain限定、Required reviewers設定済み、Prevent self-review有効と確認する。同Environmentを利用するmain上のworkflowは署名鍵を参照できるため、workflow変更の独立レビューが必要。署名はSSH鍵流出への追加境界であり、承認者とGitHub main自体の侵害は保護範囲外。
7. 配置検証後にRepository variable SUIBA_RELEASE_ENABLED=trueを設定する。自動連携にはSUIBA_STAGE_ENABLED=trueが必要。旧直接配備経路のSUIBA_BROKER_ENABLEDはfalseまたは未設定とする。

## 通常の操作

SuiBa VPSをmainからDEPLOY-PAPERで開始する。ステージングのEnvironment承認後に転送する。続くstopped-releaseのprepare Summaryで対象SHA、Run、archive hash、config digest、manifest digestを確認し、独立承認者がreleaseジョブを承認する。

Actionsが対象と有効期限を署名し、VPSの固定ラッパーへ送る。VPSはroot所有公開鍵で署名を検証し承認ファイルを新規作成する。必要なら既存のapprove_deployを使い、brokerで停止配備する。終了時にCreated、Running=false、RestartPolicy=no、PAPER、SUI_USDC、maintenance、DB整合性・停止、バックアップハッシュとreceiptを確認し、結果をSummaryに表示する。

すでにステージング済みの成功RunにはSuiBa signed stopped releaseを使い、run_idとRELEASE-STOPPED-PAPERを入力する。既存の同じSHAの配備承認は上書き拒否される。キャンセル済み・失敗したソースRunは対象外。

## 失敗と復旧

SSH切断、Docker障害、DB検証失敗等では再実行せず、承認ファイル・復旧許可・ledger・receipt・バックアップを保持して管理者が確認する。既存承認がある要求は拒否し、異常時は自動再試行しない。既存brokerでのロールバックにも対象成果物と新しいsequenceの独立承認が必要。

ラッパーを戻すときはSUIBA_RELEASE_ENABLED=falseにし、進行中のreleaseとVPS操作の終了を確認する。root所有コードは保存済みバックアップとハッシュで復旧する。公開鍵・sudoersを外す操作は別途管理者承認を受ける。台帳、承認履歴、backupを削除して復旧しない。
