# CI承認モード（approval_source: "ci"）

ブローカー（broker.py）の承認元を、管理者がホスト上で事前に作る承認ファイル
（`"file"`、従来どおり・既定）から、**管理者が GitHub の Environment 承認を
行った CI 実行が運ぶダイジェスト**（`"ci"`）へ切り替えるためのモード。
切り替えは root 所有の `/etc/suiba-deploy/policy.json` に
`"approval_source": "ci"` を書くだけで、コードの再配置は不要（broker.py は
両対応）。既定は `"file"` で、その場合 CI フィールド付きリクエストは拒否する。

## 信頼モデルの変更点

- 従来：提出者（SSH/CI）と承認者（ホスト root 側で承認ファイルを作成する
  管理者）が分離され、承認は sha・archive_sha256・image_id・sequence・
  有効期限を束ねた root 所有ファイルだった。
- ci モード：承認の発行者は「sakura-vps Environment を承認した管理者」と
  「その run の validate ジョブが出したダイジェスト」に移る。承認ファイルの
  事前作成は不要になる代わり、**Environment 承認と main への push 権限が
  実質の配置権限になる**。

## 変えていない検証（ブローカーがホスト側で再検証する）

- 転送されたアーカイブの sha256 が CI の archive_sha256 と一致すること
  （snapshot が全バイトをハッシュする）。
- アーカイブ内のイメージが image_id と一致し、リビジョンラベルが sha と
  一致し、MODE=PAPER であること（archive_identity / loaded_identity）。
- sequence はブローカー自身の ledger から導出する（呼び出し側からは
  指定できない）。ci_run は ledger の前回値より大きい値だけを許可し、
  消費済み・旧い run のリクエストは再生できない。
- compose モデル検証、ボリュームの事前存在、バックアップ、コンテナは
  「作成のみ・起動しない」、prepared_stopped の台帳記録は従来どおり。

## 配置結果の見える化（last-deploy.json）

broker は配置の成否を `/opt/suiba/last-deploy.json`（644、root 所有）
にも書く。中身は `status`（prepared_stopped / failed）と失敗時の
`code`（broker 自身の SCREAMING_CASE の拒否コードのみ。例外文・
パス・出力は形が違うため混入しない）、対象の release `sha` だけ。
root 専用の台帳・領収書が正本であることは変わらない。この写しを
SSH 接続チェックが `LastDeployStatus/Code/Sha` として表示するので、
拒否理由の当たりを root シェル無しで付けられる。書き込みは
ベストエフォートで、失敗しても配置結果は変わらない。同様に、
接続チェックの runtime.env / admin-token の前提フラグは3値化した
（1=ある、0=無い、2=shared がこのユーザーから辿れず不明）。

## 導入順序（順序を守らないと配置が拒否される）

1. 新しい broker.py をホストへ配置する（root 所有パスへ。policy はまだ
   `"file"` のままで、従来ワークフローのリクエストは従来どおり受理される）。
2. `/opt/suiba/shared/runtime.env` と `admin-token` を配置する（初回のみ）。
3. policy.json の `approval_source` を `"ci"` に変える。
4. リポジトリ変数 `SUIBA_BROKER_ENABLED` を `true` にする
   （stage モードと排他。`SUIBA_STAGE_ENABLED` は `false` のまま）。
5. suiba-vps.yml を `DEPLOY-PAPER` で dispatch し、Environment 承認する。
   validate → deploy ジョブが拡張リクエスト
   （sha / archive_sha256 / image_id / ci_run）を送る。

注意：
- ci モード有効中は、paper-check のレビュー付き配置（承認ファイルを
  前提とする permit 経路）は使えない。paper-check セッションが
  in_progress の間は切り替えないこと。
- `"file"` に戻せば従来運用に復帰する（ledger の sequence は共通で
  単調なため、モードを行き来しても再生耐性は保たれる）。
