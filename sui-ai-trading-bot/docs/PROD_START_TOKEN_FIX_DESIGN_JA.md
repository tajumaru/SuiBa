# 本番開始トークン不整合の修正設計（2026-11-11）

## 1. 障害の確定事項

2026-11-11 の本番切替で prod-start が `failed_requires_review` で
停止した。切り分けで以下が確定した。

- 本番コントローラ（ProductionController）は開始前チェック
  （preflight）で、ワーカーコンテナの env
  `PAPER_CHECK_MODE == 'sui-prod'` を要求する
  （`session_mode = 'sui-prod'`）。
- 配置される compose（`docker/compose.vps.yaml`）は
  `PAPER_CHECK_MODE: sui-30m`（検証用トークン）を固定する。
  broker はホスト側にピン留めされた policy compose
  （`/etc/suiba-deploy/compose.yaml`、policy.json の
  `compose_sha256` で検証）を使い、配置経路のどこにもトークンを
  本番用へ切り替える仕組みが無い。
- したがって現行の配置では prod-start の preflight が構造的に
  必ず失敗する。設計書（VPS_PRODUCTION_JA §6）の「配置時に
  compose を選ぶ」は未実装で、切替手順書の当日手順にも
  含まれていなかった。本番開始経路の初回実行で初めて表面化した。
- ワーカーは起動していない（診断で runtime error なし・
  コンテナ未稼働を確認）。台帳は seq 18 / prepared_stopped で
  正常。検証の記録にも影響はない。
- 副次的な発見：preflight 前（admitted=False）で失敗した本番
  レコードは、現行の prod-stop では閉じられない。
  stop_checks が未 admission のレコードに
  `PREFLIGHT_INCOMPLETE` を無条件に積み、cleanup の完了条件
  （errors なし）を満たさないためである。prod-start は前任
  レコードの completed を要求するので、この状態はソフトウェア
  経路では解消できない（wedge）。

failure.json の stage は既存の描画経路では読み出せないため
「preflight で失敗」は構成からの論理確定であり、直接観測では
ない。本設計の復旧条件は fail-closed に作り、想定と違えば
停止して再切り分けする。

## 2. 修正方針（推し：A + R1）

### A. compose の本番版を用意し、配置時の選択を setup で行う

設計書 §6 の本来の意図どおり、compose の選択をホスト側の
policy compose の差し替えとして実現する。broker.py・
コントローラ・ワーカーのコードは変更しない。

- `docker/compose.vps-prod.yaml` を新設する。検証用 compose と
  差分は `PAPER_CHECK_MODE: sui-prod` と説明コメントのみ。
- broker 用 setup スクリプトにバリアント引数を追加する
  （引数なし＝従来どおり検証用、`prod`＝本番用 compose を
  policy compose として配置し、policy.json の compose_sha256
  をその digest に更新）。両 compose の sha256 ピンをスクリプト
  内に持ち、compose を変更するコミットでピンを一緒に更新する
  既存の規律を両ファイルに適用する。
- テストで次を固定する：(1) 2つの compose の差分がトークン行と
  コメントだけであること、(2) スクリプト内の両ピンが各
  compose の実 digest と一致すること。
- 本番稼働中の配置（prod-stop → 配置 → prod-start）は、policy
  compose が本番版の間は自動的に本番トークンで作り直される。
  検証に戻すときは検証用 compose に戻して再配置する
  （設計書 §6 の記述どおり）。
- 本番版 compose が入っている間、検証ランは preflight の
  トークン不一致で fail-closed に開始できない。これは
  「本番稼働中は検証ランを回さない」の運用制約と一致するが、
  prod-stop 後も同様であることを手順書に明記する。

却下した代替案：

- broker 側でトークンを書き換える：最もセキュリティ境界が
  厚い broker に、ピン留めした成果物と実効モデルを乖離させる
  変更が入る。
- コントローラが開始時にコンテナを作り替える：コントローラに
  作成権限が無く、broker の台帳整合とも衝突する。
- トークンを runtime.env（env_file）へ移す：ピン留めされない
  可変のホスト状態に安全関連の値が移り、compose environment の
  優先で固定する現行の保証が弱まる。

### R1. prod-stop が preflight 前失敗の本番レコードを閉じられるようにする

ProductionController の閉じ条件を、未 admission の失敗に限り
拡張する。prod-stop が次の全部を満たす場合に限り、対象
レコードを completed（receipt clean_stopped）として確定し、
state の failed.json と fault ファイルを確定処理の一部として
片付ける。

- record.admitted == False
- failure.json が存在し、その stage == 'preflight'
- mutation.json に未完了の変更がない
- コンテナが未稼働で、このセッションでは一度も起動していない
  （inspect の StartedAt がレコード開始前）
- 存在する fault のコードが `PREFLIGHT_INCOMPLETE` のみ

1つでも満たさなければ従来どおり拒否する（fail-closed）。
admission 済みの失敗、未知の fault、stage 不一致は対象外で、
従来の手動切り分けに残る。

これにより、今回 wedge したレコードも、新コントローラを
ホストへ配った後の通常の STOP-PROD で閉じられる。ホスト上の
ファイルを root 手作業で動かす復旧は行わない。万一 R1 の
条件に合わず STOP-PROD が再度拒否した場合は、レコードを
無傷のまま残して再切り分けする（ファイル操作でごまかさない）。

実装時の注意：コントローラを変更するので、setup-paper-check.sh
内の controller.py ピンを同じコミットで更新する（既存の
テストが強制）。本番系テスト（test_controller）に、閉じられる
ケース／admission 済みは拒否／未知 fault は拒否、の3ケースを
追加する。

### 手順書と設計書の直し

- 切替手順書 §2 に「本番用 compose の配置（setup の prod
  バリアント）」を配置の前段として追加する。今回の seq 18 は
  検証用 compose で作られたため、本番用で再配置が必要。
- 診断（CHECK-PAPER-DIAGNOSTICS）の container env チェックは
  検証用トークンを前提に描画する（表示のみ・ゲートではない）。
  本番構成の間は env=ng と出るが想定どおりであり、本番の
  正規の読みは本番モニター（prod-status）であることを手順書に
  注記する。診断側の修正はしない。
- DECISIONS_JA に本障害と修正方針を記録する（承認後）。

## 3. 実施順序

1. PR-1：compose.vps-prod.yaml ＋ setup バリアント ＋ テスト
   （§2-A）。
2. PR-2：コントローラ R1 ＋ 本番系テスト ＋ setup ピン更新。
3. CI 全緑でそれぞれマージ（承認は従来どおり）。
4. ホスト作業（Tera Term、既存の自己検証つきスクリプトの
   再実行が2回）：(a) setup-paper-check.sh を新 main で再実行
   （R1 コントローラを配る）、(b) broker setup を prod
   バリアントで実行（本番用 compose を policy に配置）。
   どちらも置換前のバックアップを残し、digest 検証で失敗
   すれば止まる。
5. STOP-PROD：wedge したレコードが completed で閉じることを
   確認する。閉じなければ §2-R1 の注記どおり再切り分け。
6. DEPLOY-CYCLE-PAPER：seq 19 が本番トークンのコンテナで
   prepared_stopped になる。
7. START-PROD → 開始後チェック（prod-status が in_progress、
   worker の running / databaseHealthy / ledgerOk、
   /api/deployment が expires=null で armed、初回サイクルが
   無事）。本番モニターが正常を観測し、警報 Issue #183 が
   自動で閉じること。
8. REVIEW-PROD-DAILY のスモーク（ゲート変数は有効化済み。
   当日分の初回投稿として Issue #121 に出ること）。
9. WireGuard での閲覧確認 → Windows 側を最後に停止 →
   集中観察週間へ。

## 4. 変えないもの

- 取引ロジック、安全停止条件（429/500 の即時停止を含む）、
  エピソード制限。
- broker.py、ワーカー、ダッシュボードのコード。
- 検証ラダーの卒業状態（24h 卒業は有効なまま。再検証は
  不要：本修正は取引・通信経路に触れない）。
