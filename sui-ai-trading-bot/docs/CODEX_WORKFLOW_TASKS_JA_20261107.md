# Codex 作業指示（2026-11-07 第2弾）：証拠の自己説明化とデータ持ち出し経路

宛先：Codex。成果物は PR 作成まで。CI 確認とマージ判断はシロが行う。
作業に先立ち `AGENTS.md` の「出力とトークンの規律」を守ること
（成功ログは件数だけ、フルログはファイルへ、差分は stat から）。

## 背景（事実のみ）

- 本日、検証ランの開始が2回「記録なしで消失」した。原因は
  `admit_session()` の `quiescent()` が、前任ランの armed のままの
  cutoff タイマーを理由に開始を拒否していたこと。admission より前で
  落ちると run レコードも preflight も failure.json も残らず、
  切り分けに約1.5時間を要した。タイマーの状態は診断出力にはあったが、
  拒否理由そのものはどこにも記録されなかった。
- 再試行承認も、未消費の permit が残っていると `PAPER_RETRY_FAILED`
  とだけ出て理由が伏せられていた。
- PR #101（学習モデル導入に向けた読み取り専用データ監査）がマージ
  された。VPS ランの保存コピー（バックアップ＋manifest）に対して
  監査を回したいが、ホストからファイルを持ち出す経路が存在しない。
  監査でも障害調査でも、証拠・データの取得が毎回ボトルネックになる。

## 作業1：admission 段階の証拠記録

目的：開始が admission 前に拒否されても、「どの関門で・何を見て」
落ちたかが記録から分かるようにする。

要件：

- `admit_session()` の各関門（policy／start-request 取得／
  abort-inhibit／quiescent／retry 分岐の各チェック／fresh 分岐）で
  失敗したら、固定の理由コードと観測した状態（対象タイマーの
  ActiveState、permit の有無など）を、開始レコードとは別の小さな
  証拠ファイルに残す。書式は `record_preflight` の流儀（固定文字列
  中心、秘密情報を含めない）に倣う。
- diagnose／status の出力に、その証拠（直近の admission 失敗）を
  含める。
- ssh スクリプト側で一律に伏せている op の失敗理由について、固定
  コード（SCREAMING_CASE の形をしたもの）だけを通す allowlist 方式
  にする。
- 関門の判定そのもの・順序・安全条件は一切変更しない。記録の追加
  のみ。
- 単体テスト：quiescent 拒否と permit 既存の2ケースで、証拠が残り
  診断に出ること。

## 作業2：検証済み保存コピーの export op

目的：PR #101 の監査と将来の調査のために、VPS ランの保存コピーを
GitHub Actions 経由で取得できるようにする。

要件：

- 対象は「直近の終了済みラン」の開始前バックアップ（DB コピー＋
  manifest）。生の現行 DB ではない。manifest の sha256 を export
  前に検証し、不一致なら固定コードで失敗する。
- 内容は監査に必要な範囲に絞った抽出にする（判断・指標・候補・
  注文・約定・停止イベントと、run の manifest 情報）。設定値や
  トークン類を含めない。
- 配送は Actions の artifact とし、retention は最短（1日）。この
  repo は public で artifact は誰でも取得できる前提で設計し、
  その旨をドキュメントに明記する。
- 他の recover op と同じ作法（sakura-vps 環境の承認＋有効化変数＋
  固定 wrapper）。Bot の稼働には触れない（ラッチを書かない、停止を
  要求しない）。稼働中ランに対しては開始前バックアップのみを対象
  とする。
- 単体テスト：manifest 不一致の拒否、抽出範囲（対象外テーブルが
  含まれないこと）。

## 作業3：admission 拒否証拠の履歴化（作業1・2 のマージ後に追加）

PR #102 で入った admission 拒否の証拠記録を、最新1件だけから
最新5件の履歴に拡張する。別種の拒否が続くと先の証拠が上書きで
消えるため。

- `admission-failure.json` は最新1件のまま残し、status／diagnose の
  既存の `admission_failure` の形は変えない。
- 別ファイル `admission-failures.json` に同じ形の証拠を最新5件まで
  append-only で保持し、status／diagnose に `admission_failures`
  として出す。
- 履歴ファイルの破損は、当該エントリを落とすか履歴を [最新] に戻す
  扱いにし、拒否ゲートと status を壊さないこと。
- 例外文・パス・設定値は記録しない（作業1と同じ規則）。
- 1件約200〜300バイトで5件なら既存の read_trusted 上限4096に
  収まる想定だが、超えるなら上限を上げるのではなく件数を減らして
  収めること。
- `test_admission_evidence.py` に、異なるコード2件が順に残る・
  6件目で最古が落ちる・履歴破損でも admission と status が
  壊れない、の3テストを追加する。
- controller.py を触る PR はこれ1本だけ直列で進める（作業1・2の
  並行で競合しリベースが1往復増えた教訓）。判定条件と順序は
  変えない。

## 作業4：リセットの範囲限定（PR #97 優先事項、A案で決定）

2026-11-07、オーナーが A案を採用した。

現状：POST /api/control の reset は runtime.error と api cooldowns
に加えて emergency（手動の緊急停止）まで解除する。再試行承認つき
開始の stale リセット再送（PR #92／#96）が、窓の中で立った手動
emergency や新規の 429 ハードストップを消しうる（実発生の事例は
なし。契約の穴としての指摘）。

決定（A案）：

- リセットの対象を「前任由来のエラーと cooldown」だけに限定する。
  emergency は絶対に解除しない。開始後に新規に立ったエラー
  （429 を含む）は保持する。
- 世代チェックで競合を閉じる：開始側が想定する前任のエラーと
  一致する場合だけ消し、一致しなければ開始を中止して証拠を残す。
- 429 即停止の合意（2026-11-04）は不変。自動再開は入れない。
- worker 側の変更＋controller 側の送信条件の整合＋統合テスト
  （窓内で emergency が立ったら開始が中止されること／新規 429 が
  消えないこと／前任由来のエラーは従来どおり消えること）。
- 反映は worker イメージの配置に乗る。本番切替までに land させる。
- controller.py を触る場合は直列・ピン更新（恒例、作業3とは
  並行にしない）。

## 作業5：CANDLE_STALE の回復待ち化（B案、2026-11-07 決定）

根拠（2026-11-07 の実測）：同日の STALE_CANDLES ハードストップ
2件（11:22ごろ／16:10ごろ）は、どちらも DeepBook Indexer の
5分足が末尾で1本だけ欠けたタイミングと一致した（欠落スロットは
11:15 と 16:05。16時台〜18時台は欠落が4本）。足が1本欠けると
失効ライン（終値＋60秒）までの猶予の大半をそれだけで使い切り、
次の足の発行遅延と回復エピソード上限（約3分）でハードストップ
になる。Bot 側の故障ではない。

決定（B案）：

- `MARKET_DATA_STALLED` のうち reasonDetail が `CANDLE_STALE` の
  ものは、回復可能パス（PAPER_NETWORK_PAUSED 系）で扱う。stale
  専用のエピソード上限は30分とし、鮮度が戻れば既存の回復条件
  （健全サイクル2回・60秒以上）で自動再開する。30分を超えて
  stale が続けば従来どおりハードストップする（終端のエラーは
  STALE_CANDLES のまま）。
- stale の間は売買しない（pause の意味論は現行どおり）。古い
  データで判断を再開しない。
- HTTP 429／500 の即時ハードストップは不変。stale の pause 中に
  429 が来たら即時ハードストップする（相互作用をテストで固定）。
- `CANDLE_GAP`（系列内部の欠け）の扱いは変えない。CANDLE_STALE
  以外の MARKET_DATA_STALLED（予算枯渇など）のエピソード上限も
  現行のまま。広げるのは CANDLE_STALE だけ。
- エピソードの内訳記録（episodeTally）に stale の継続が残る
  こと。
- テスト：10分間の stale を生き延びて鮮度回復で再開する／30分超
  でハードストップ／pause 中の 429 で即時停止／再開時に stale な
  データで判断しない。
- 判断の記録として `docs/DECISIONS_JA.md` に本決定を追記し、
  振る舞いの変更点は `docs/VPS_RECOVERY_AUTOMATION_JA.md` にも
  書く。
- worker 変更なので反映はイメージ配置に乗る。PR はこれ1本。

## 共通の約束

- 作業ごとに別 PR にする。push 前のローカル全回帰（typecheck／
  lint／全テスト／ビルド／描画スモーク＋Python スイート）は Codex
  側で実施し、結果を PR 本文に件数と成否だけ書く。
- 売買ロジック、安全停止条件、通信経路は変更しない。
- `controller.py` を変える場合は、setup の sha256 ピンを同じ
  コミットで更新する（恒例）。
- 振る舞いが変わる点は `docs/VPS_RECOVERY_AUTOMATION_JA.md` に
  同じ PR で追記する。
- 不明点は推測で埋めず、PR 本文に「未決」として列挙する。

## 作業6：approve-deploy の失効楔の恒久修正（2026-11-08 追加）

2026-11-08 の配置 seq 13 で踏んだ設計の楔。approve-deploy は
CI モードの配置承認レコード（policy/approvals/<sha>.json）を
「発行から1時間有効」で実体化するが、配置の実行がその窓を
過ぎると broker が PAPER_DEPLOY_EXPIRED で拒否し、失効した
レコードと未消費の permit（STATE/paper-deploy-<sha>.json）を
消す・更新する操作がどこにもないため、同じ sha では二度と
approve-deploy が通らなくなる（controller 側も expires チェック
で拒否する）。当面の回避は「新しい sha の配置対象にする」
こと（本節を追加した commit 自体がその回避を兼ねる）。

恒久修正の要件：
- approve-deploy は、既存の配置承認レコードが失効している場合
  に限り、同じ内容（sha／deploy）で再実体化できること。再発行
  はこの操作自体への人間の承認を前提とし、有効窓は従来どおり
  1時間。
- 未消費 permit が残っている場合の扱いを決めること：permit は
  承認レコードの sha256 を束縛しているため、再発行で digest が
  変われば古い permit は無効になる。再発行と同時に古い permit
  を置き換える（または作り直す）設計とし、消費済み permit が
  ある場合は従来どおり拒否すること。
- 一度消費された配置や、失効していない承認の上書きは不可
  （single-use の性質を変えない）。
- テスト：失効後に approve-deploy が再発行して配置まで通る／
  失効前の二重発行は拒否／消費済みは拒否／digest 不一致の
  permit は broker が拒否する（従来どおり）。
- controller 変更になるため setup のピンを同じコミットで
  更新し、`docs/VPS_RECOVERY_AUTOMATION_JA.md` に経緯と仕様を
  追記する。PR はこれ1本。

## 作業7：配置の1タップ化（2026-11-08 追加、オーナー発案）

現行の配置は「release-cutoff → approve-deploy → 配置」の3回の
dispatch＋3回の環境承認に分かれており、approve-deploy と配置の
間に1時間の permit 窓があるため、間が空くと失効楔（作業6）を
踏む。検証の CYCLE（PR #94）と同じ形で、配置も1ジョブに
まとめる。

要件：
- 新規 workflow（例：suiba-paper-deploy-cycle.yml）で、環境
  sakura-vps の承認1回の中に次を順に実行する：(1) cutoff
  タイマーが残っていれば release-cutoff（記録が終端でない等、
  解除が不要／不可能な場合はその理由で失敗させる。無言で
  読み飛ばさない）、(2) approve-deploy（対象は実行時点で
  checkout した main の sha）、(3) 配置（既存 suiba-vps.yml の
  validate＋deploy の中身を再利用し、artifact の受け渡しを
  ジョブ内に閉じる）。
- 前任ランが存在しない通常配置（ラッチなし）でも同じ
  workflow で通ること（release-cutoff と approve-deploy は
  「不要なら成功として読み飛ばす」のではなく、状態を確認して
  必要な場合だけ実行する分岐を workflow 内に明示する）。
- 失敗時は CYCLE と同様、同じジョブ・同じ承認のまま診断を
  添付する。
- 既存の個別 workflow（recover／vps）は残す（切り分け用）。
  README／運用ドキュメントの手順を新しい正規手順に更新し、
  `docs/VPS_RECOVERY_AUTOMATION_JA.md` に追記する。
- 作業6（permit 再発行）は本作業の後では優先度が下がるが、
  個別実行時の楔として残るため、実施するかどうかは PR 本文で
  未決として挙げること。
- workflow のみの変更なら CI の扱いは従来どおり。PR は1本。
