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

### R3. prod-stop が admission 後失敗の本番レコードを閉じられるようにする（2026-11-11 追補）

A と R1／R2 の反映で本番切替は完了し（seq 19）、初回本番ランは
2026-11-11 07:38 JST に開始した。同日午前、そのランは上流の
HTTP 500 でハードストップした（429／500 の即時停止は既定の
安全条件どおり）。レコードは admitted=True の
failed_requires_review となり、STOP-PROD（run 42950937586）は
PROD_STOP_FAILED で、このレコードも閉じられなかった。

原因は R1 と同じ wedge が1層深くにあったこと。admission 済みの
失敗は R1 の対象外で通常の stop 経路に落ちるが、その経路は
既に終了したコントローラを持つレコードを閉じられない。
stop() は死んだコントローラの terminate に失敗すると
`CONTROLLER_EXIT_UNCONFIRMED` を fault し、stop_checks は
fault が既にあるレコードへ `LATCHED_FAILURE` を追加する。
cleanup の完了条件（errors なし・fault なし）には構造的に
到達できず、prod_start も当該レコードを永久に拒否する。

修正は、prod_stop の failed_requires_review 分岐で R1 の
判定の後段に、admission 後失敗の閉じ条件
（admitted_closeout_eligible）を追加する。次の全部を満たす
場合に限り、R1 と同じ確定処理（receipt clean_stopped、
fault ファイルと state/failed.json の片付け、
completed／stage stopped）で閉じる。failure.json は失敗の
証拠としてフォルダに残す。

- record.admitted == True
- failure.json が存在し、その id が当該レコードと一致する
- コンテナが未稼働で、ExitCode == 0、OOMKilled でない。
  かつ inspect の StartedAt がこのセッションで実際に起動した
  ことを示す（レコード開始の60秒前以降。ゼロ時刻・解釈不能は
  拒否）——「このセッションのランが、きれいに止まった」ことの
  証明であり、別セッションの残骸や強制終了を閉じないため
- DB 検証が通る（stop_checks の admission 側と同一の
  maintenance ＋ helper verify ＋ verify_sui）——台帳と DB が
  無傷であることを、通常停止と同じ強さで確認するため
- mutation.json に未完了の変更がない
- 記録上のコントローラが終了している
- 存在する fault のコードが
  {`LATCHED_FAILURE`, `CONTROLLER_EXIT_UNCONFIRMED`,
  `STOP_LOCK_OR_STATE_UNKNOWN`, `CLEANUP_LOCK_OR_STATE_UNKNOWN`}
  のみ。これらはいずれも stop 機構自身が「既に死んだランを
  閉じる」ときに生むコードで、ラン自体の独立した失敗情報を
  持たない（ランの失敗そのものは failure.json・コンテナの
  clean な終了・DB 検証で別途証明される）。DB やコンテナの
  検証失敗を示すコードが1つでも混ざれば拒否する
- state/failed.json がある場合は当該レコードを指す

1つでも満たさなければ従来どおり拒否する（fail-closed）。
クラッシュ（終了コード非0）・OOM・DB 検証失敗・未知の
fault は対象外で、従来の手動切り分けに残る。

却下した対案：(a) fault の有無を cleanup の完了条件から
外す——検証なしにラッチを消すことになり、DB 破損や未完了
mutation を見逃す。(b) ホスト上で fault ファイルを手作業で
消す——R1 で採らないと決めた経路。(c) 500 を episode 扱いに
して止まらないようにする——安全停止条件の変更であり、
本件の範囲外（既定どおり変えない）。

実装は R1 と同じ形（コントローラ変更＋ setup ピン更新を
同じコミットに、本番系テストに閉じられるケースと拒否
ケース群を追加）。配布は setup-paper-check.sh の再実行で、
復帰は STOP-PROD → START-PROD の順に行う。

### R4（2026-11-11）：ライフサイクル監査フォローアップ

本番ライフサイクルの状態機械を総当たりで監査した結果
（F-1〜F-9）のうち、F-1 は R3 で閉じた。本節は残りのうち
今回まとめて閉じる分（F-2／F-3／F-7／F-9 と F-8 の最小の
可視化）と、常設の回帰網である状態行列テストを定める。
F-5（クラッシュ／OOM に対する本番 reconcile op の新設）は
本節の範囲外で、別途設計する。方針は従来どおり
fail-closed：疑わしければ現行の拒否のままにする。

**F-3（preflight 境界）**：形状——admission フラグの永続化
（admitted=True）が先に行き、ProductionController.preflight
の stage='backup' 書込みが失敗すると、admitted=True かつ
stage='preflight' のレコードが残る。R1 の close-out は
admitted=False を条件にしていたため、この形状は「作業者が
一度も起動していない」のに閉じられなかった。修正——R1 の
判定を admitted フラグでなく証拠側へ付け替える：
failure.json の stage が 'preflight' であること＋コンテナが
このセッションで起動していないこと（StartedAt ゼロ時刻、
またはセッション開始より前）。他の条件（fault 集合
{PREFLIGHT_INCOMPLETE, LATCHED_FAILURE}、pending mutation
なし、ラッチが本レコードを名指ししていること、コンテナが
Running でないこと）は不変。根拠——二つの書込みの間にある
死に方が本物の境界であり、境界をまたぐ判別子はフラグでは
なく「作業者が走ったかどうか」の観測可能な事実である。
なお PREFLIGHT_INCOMPLETE は未 admission のレコードにしか
fault されないため、境界形状は LATCHED_FAILURE のみ、あるい
は fault ゼロでもありうる。許容集合は両形状をそのまま
囲っている。

**F-2（guard 操作の pending 残留）**：形状——guard された
操作（backup／unlatch／worker-start／arm／paper-start）が
4xx 以外のエラーで死ぬと、mutation.json の pending が
残ったままになり、それを消せるのは死んだランナーだけ
だったため、どの close-out も
OPERATION_COMPLETION_UNCONFIRMED で拒否し続けていた。
修正——R3 の close-out に限り、次のすべてがそろう場合に
pending を許容する：(1) pending の値（操作名の文字列）が
failure.json の stage に対応する操作と一致する。guard は
操作名を記録し、失敗記録は run stage を記録するため、両者
の対応はコントローラ内の GUARD_STAGE_OPERATIONS が持つ
（食い違うのは maintenance-release ⇄ unlatch の一箇所
だけ）。(2) その操作が現在効いていないことが証明できる：
コンテナが Running でなく、backup と maintenance-release
（＝unlatch）の段階についてはコンテナがこのセッションで
起動していないこと（この二段階は作業者起動より前に走る）。
worker-start 以降の段階は R3 既存の「このセッションで正常
終了した」証明で足りる。(3) R3 の他の条件（DB 検証・
コントローラ終了・ラッチの名指し）がすべて成立する。
この部分ケースに限り fault コード
OPERATION_COMPLETION_UNCONFIRMED も許容集合に加える：
stop_checks は残留 pending を観測した停止試行のたびに
このコードを fault するため、pending そのものが上の証拠
で反証済みなら、このコードは pending の存在以上の情報を
持たない（R3 の派生コード四つと同じ扱い）。stage が
failure.json と食い違う pending、効いていないことを反証
できない pending は従来どおり拒否する。なお「backup 自体
は終わったが直後のレコード書込みで死んだ」形状は pending
を持たないため本修正の対象ではなく、開始証明が立たず
従来どおり手動照合のまま残る（F-2 の形状とは別物）。

**F-7（孤児ラッチ）**：形状——ランナーがレコードを公開
する前に死ぬと、production/state/failed.json だけが残り、
削除する者が誰もいないため、以後の prod_start が永久に
拒否されていた。修正——prod_stop がレコード不在を見た
場合に、ラッチを証拠として同じ state ディレクトリへ
failed-orphan-<id または unknown>.json に改名し（ディレ
クトリを fsync）、従来どおり {'status': 'not_started'} を
返す。これで後続の prod_start は孤児ラッチに阻まれない。
読めない／壊れたラッチはその場に残す：読めない証拠は
破棄せず、prod_start は拒否を続け、運用者は prod_status
（レコードなし分岐は既にラッチの存在を requires_review に
含む）でラッチを見られる。改名は証拠の保全であって削除
ではない。

**F-9（ロック競合の fault 化）**：形状——配置（デプロイ）
が deployment ロックを保持している間に停止が確定すると、
ProductionController.cleanup のロック取得失敗が stop() の
fault 経路に流れ、CLEANUP_LOCK_OR_STATE_UNKNOWN の fault
と failed.json ラッチが恒久化していた。競合は失敗の証拠
ではない。修正——本番 cleanup は deployment_lock の取得
失敗（BlockingIOError）を fault せず False を返すよう分け
た（保持側の処理は _cleanup_locked として不変）。停止は
失敗として報告されるが何もラッチされず、配置が終われば
同じ停止が通る。ロックファイル自体の形の異常は従来どおり
例外として上がる（競合ではなく状態の異常だから）。基底
Controller と検証（paper）側の挙動は変えない。

**F-8（abort-inhibit の可視化）**：リポジトリ内のどこも
production/abort-inhibit.json を書かないのに、prod_start
はその存在だけで拒否し、理由が外から見えなかった。最小の
変更として、prod_status の requires_review に inhibit の
存在を加えた（レコードあり分岐）。新しいフィールドは
増やさない。inhibit の書き手や解除手順は本節の範囲外。

**状態行列テスト（常設の回帰網）**：監査の最大の教訓は、
verify_prod.py が「failed へ到達すること＋開始が拒否
されること」までしか固定しておらず、「閉じられること」を
誰も検証していなかった点にある。本変更で
test_controller.py に ProductionMatrixTests を追加し、
監査行列の各形状（通常停止／完了済み／R1／R3／F-2／F-3／
準備完了失敗／クラッシュ／ゾンビ／孤児ラッチ／
abort-inhibit／post-stop intent）をフェイクで構築して
prod_stop の可否と後続の prod_start の可否を期待表で
固定する。「閉じない」行は意図の記録であり、将来の変更が
閉じられる形状を黙って楔化させたり、逆に手動照合である
べき形状を黙って閉じたりしたら、ホスト上ではなく CI で
落ちる。以後、新しい現場形状が出たら、その形状テストの
追加を修正の一部とする。

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
