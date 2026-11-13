# 影 runtime の受け渡し（有効化の前提）

この変更のマージだけでは影は動かない。kill switch は未設定では無効のまま。
compose は変更せず、既存の `env_file: /opt/suiba/shared/runtime.env` を使う。
従来の setup は既存 runtime.env を上書きせず、今回も同じ。新規作成にも影の空キーを追加しない。

## オーナーの操作順

1. マージ後、STOP-PROD を承認して停止し、検証 supervisor も静止している停止窓で、
   既存のオーナー実行手順で `deploy/paper-check/setup-paper-check.sh` を再実行する。
   sha256 ピン付き helper・固定 wrapper・sudoers が配置される。broker の自己更新は追加しない。
2. OpenAI の支払い・キー発行を済ませ、GitHub Environment `sakura-vps` の
   Secret `SUIBA_SHADOW_API_KEY` に保存する。workflow_dispatch の入力にはキーを入れない。
   キーをホストで手入力したり、コマンド引数・policy.json・ログ・export に入れたりしない。
3. main の `SuiBa shadow runtime configuration` を `UPDATE-SHADOW-RUNTIME` で dispatch する。
   `enabled` の既定は `false`。有効化するときだけ別の明示操作で `true` を選ぶ。
   既存の `SUIBA_PROD_CONTROL_ENABLED == true` ゲートと `sakura-vps` の Environment 承認が必要。
4. 承認後、runner は Secret とフラグを JSON にして SSH stdin のみで固定 helper へ渡す。
   helper は2キー以外・重複・不正値を拒否し、既存の他の行を保持して原子的に更新する。
   root:root / 0600 を検証し保持する。symlink・hardlink・書込可能な親ディレクトリを拒否する。
   broker と共通のロックを非待機で取得するため、稼働中・配置中なら失敗する。
   出力は固定の成功／拒否のみ。runner は remote の stdout/stderr を破棄する。
   キーは SSH stdin で渡し、コマンド引数には含めない。sudo-rs 互換性のため
   sudoers に NOLOG_INPUT / NOLOG_OUTPUT タグは指定しない。
5. 有効化は別ステップ。停止中のホストへ明示的にキーと `true` を渡した後、
   STOP → DEPLOY-PAPER → START-PROD の各承認フローでリリースする。
   env の更新だけでは既存コンテナの環境は変わらないため、START だけでなく DEPLOY が必要。

キーのローテーションも同じ Secret 更新→停止→承認付き更新→DEPLOY→START を使う。
無効化は同じ経路で `false` を渡し再配置する。キーは空値にせず、更新時には Secret を必須とする。
runtime.env のバックアップは作らない。途中失敗時は旧ファイルか新ファイルのどちらかが残り、
一時ファイルは削除する。OpenAI 側の Limits 設定はオーナーの別作業。
