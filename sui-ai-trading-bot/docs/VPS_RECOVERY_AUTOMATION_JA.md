# VPS リカバリ自動化 — 運用メモ

これは設計書ではなく、2026-11-06 未明の初回配置リカバリで実地に確認した
paper-check／broker の状態遷移を記録する運用メモである。今後の自動化
（リカバリ用ワークフロー等）はこのメモの事実を前提にする。

## 確認した事実

### 1. 開いたままの paper-check セッションが配置を OS_ERROR で止める

- ホストに paper-check セッションが開いている（`/var/lib/suiba-deploy/paper-check.json`
  が `{"status": "in_progress"}`）間、broker は配置を paper-check 配置とみなし、
  その sha の許可証 `paper-deploy-<sha>.json` を読みに行く。
- 通常の CI 配置には許可証が無いため FileNotFound（OSError）になり、公開コードは
  名前付きコードではなく `OS_ERROR` になる。この段階では failure.json も台帳も
  書かれないので、Actions のログだけでは理由が分からない。
- セッションは「失敗した検証ランの後始末が終わっていない」だけでも開いたままになる。

### 2. 是正点は3点セット（fault ラッチ／停止レシート／台帳とコンテナの同一性）

- **fault ラッチ**：`/var/lib/suiba-deploy/paper-check-failed.json` と、ランの
  フォルダ内 `fault-*.json`。preflight 失敗でも cleanup が自動で付ける。
  ラッチがある限り再試行・配置許可のどちらの経路も開始できない。
- **停止レシート**：ランの `stop.json`。admission 前に死んだランは構造上
  `clean_stopped` を自己発行できない（cleanup が無条件に PREFLIGHT_INCOMPLETE を
  積む）。実態（コンテナ未起動・正常終了・未完了の変更なし）を管理者が確認した
  うえで是正する対象になる。
- **台帳とコンテナの同一性**：台帳の sha ＝ コンテナの image ラベル
  `org.opencontainers.image.revision`、台帳の transaction が指す凍結 compose の
  image ＝ コンテナの image、の両方が admission の照合対象。作成に失敗した配置
  （`failed_state_unknown`）はコンテナを作り替えないまま死ぬことがあり、その場合
  台帳だけが新 sha を指して実物と食い違う。台帳の是正は、最後に成功した配置の
  レシート（sequence・sha・transaction）を正として復元する。台帳ファイル自体は
  削除しない（PR35 設計どおり、管理者確認が解除条件）。

### 3. diagnose() は backup 前に死んだ現行ランを診断できない

- `diagnose()` の `diagnostic_backup` は現行ランの `record['backup']` を必須と
  するため、backup 段階より前に死んだランが現行記録だと KeyError で診断自体が
  失敗する（`PAPER_STATUS_FAILED` になる）。
- `approve-retry` も内部で diagnose を使うので同じ理由で到達できない。
  一方、run 自身の開始ゲートは backup を要求しない（ラッチ・停止レシート・
  permit の中身・コンテナ実在を再検証する）。

### 4. admitted 後に失敗したランは cutoff タイマーを armed のまま残す

- admission を通過したランは cutoff タイマー（`suiba-paper-check-cutoff.timer`）を
  起動する。ランが途中で失敗してもタイマーは解除されず、次の開始は
  `quiescent()` が「タイマー active」を理由に即拒否する（記録が作られる前に死ぬ）。
- 解除はタイマーの発火（cutoff 到達）か、管理者による
  `systemctl stop suiba-paper-check-cutoff.timer`。守る対象のランが停止済みで
  あることを確認してから止める。

### 5. market-freshness は worker 起動直後の初回取得と競合した（修正済み）

- 旧実装は worker 起動から約10秒時点で summary の `marketData.lastSuccessAt`
  が90秒以内かを**一回だけ**見ていた。エンジンの初回 GeckoTerminal 取得
  （プール発見＋OHLCV）が完了前だと `lastSuccessAt` は未記録（None）で、
  取得自体は健全でも数秒差で競合負けした（2026-11-06 に2回発生し、いずれも
  clean_stopped で停止。診断で段階が確定）。
- 修正（wait_market_fresh）：同じ鮮度条件を監視と同じ5秒間隔で最大2分間
  ポーリングする。None は「まだ成功なし」として待ち続け、2分経っても
  鮮度が来なければ従来どおり market-freshness 失敗とする。監視中の鮮度
  判定（5秒ごとの単発チェック）は変更していない。
- 証拠の追加：鮮度で落ちた場合に「初回取得が来なかった」のか「取得自体が
  失敗していた」のかを切り分けられるよう、コントローラが最後に見た市場
  状態（source / lastSuccessAt / コード形の reason のみ、自由文は落とす）
  を失敗記録に残し、診断とレポートに `Market at failure:` として出す
  （market-freshness と監視中の両方）。

## このメモに紐づく自動化

- `.github/workflows/suiba-paper-watch.yml`：paper-check ランの完走を
  GitHub Actions 側から監視する（承認1回で最大約40分ポーリングし、
  `completed`／`failed_requires_review` で早期終了）。状態取得は既存の
  `docker/ssh-paper-status.sh`（CHECK-PAPER-STATUS）をそのまま使う。
- `.github/workflows/suiba-vps-cleanup.yml`（confirmation `CLEAN-INCOMING`、
  専用変数 `SUIBA_CLEANUP_ENABLED`、Environment 承認必須）：配置の失敗・
  成功で `/var/lib/suiba-incoming/` に残ったアップロード残置を掃除する
  （`docker/ssh-clean-incoming.sh`、非特権 SSH のみ）。削除条件は厳格に
  固定：名前が40桁 hex の sha 形式の実ディレクトリで、中身が
  `image.tar.gz` と `.image.partial.*` だけ、最終更新から1時間以上経過
  したものだけ。それ以外は理由付きでスキップ表示され、消されない。
  初回配置成功（2026-11-06）時点で残置は5件。
- `.github/workflows/suiba-paper-start.yml`（confirmation `START-PAPER`、
  時間の選択入力 30m／6h／24h、専用変数 `SUIBA_PAPER_START_ENABLED`、
  Environment 承認必須）：検証ランの開始。`docker/ssh-paper-start.sh` が
  固定ラッパーへ `{"operation":"start","duration":...}` を送るだけ。
  watch（40分）は 30m ラン用で、6h／24h ランは status を都度確認する。
- 検証時間の持ち主は controller。開始リクエストの時間は root 所有の
  `start-request.json` として次回ランだけに渡り、ランが消費する
  （10分より古いメモは既定の 30m に落ちる）。cutoff・監視の長さ・
  cutoff タイマー（時間別のユニット）は全てレコードの `duration` から
  決まる。Worker の `PAPER_CHECK_MODE=sui-30m` はリースの名前として
  不変で、時間は開始時にだけ決まり、途中では伸ばせない。
- ホスト反映は `deploy/paper-check/setup-paper-check.sh`（root で1回。
  main から取得して sha256 ピンを検証し、実行中ランがあると拒否、
  旧ファイルはバックアップ。配置後は daemon-reload・
  systemd-analyze verify・全ユニットの LoadState・配置後ハッシュ・
  suiba-deploy 経由の status スモークまで自動で確認する）。
  対象ファイルを変更したらピンも同じコミットで更新する。
- broker 方式への一本化に伴い、旧 stage 経路を撤去した：
  `.github/workflows/suiba-vps-stage.yml` と suiba-vps.yml の `stage`
  ジョブを削除し、リポジトリ変数 `SUIBA_STAGE_ENABLED` も削除した。
  `deploy/broker/approval-ci.md` の導入順序にある stage の記述は
  切り替え当時の記録として残す。
- broker の `OS_ERROR` の名前付きコード化と、診断→再試行承認→開始→監視の
  一本化は未着手（tracked item「SuiBa VPSリカバリ自動化」）。
- 再試行承認の Actions 化と preflight の詳細化（2026-11-06）:
  起動後の段階で失敗して clean_stopped で止まったラン（例：
  market-freshness 競合）の再試行承認を、コントローラの
  `approve-retry` 操作として実装し、`suiba-paper-retry.yml`
  （確認フレーズ `RETRY-PAPER`、変数 `SUIBA_PAPER_RETRY_ENABLED`）
  から承認タップで実行できるようにした。承認条件は root CLI の
  approve-retry と同一（診断が読める・stop が clean_stopped・
  障害証拠なし）で、CLI とメソッドを共用する。preflight 死
  （failed_state_unknown）はここでは承認できず reconcile が担う。
  あわせて preflight の container 検査が、どの require で落ちたか
  （inspect/state/restart_user/env/ports/memory/label/transaction/
  image）を証拠の detail として記録し、診断とレポート表示まで
  通すようにした（2026-11-06 07:52 の container 死は全項目 ok で
  行が特定できなかったための改善）。
- 是正の Actions 化（2026-11-06）: 起動前チェックで死んだランの是正を
  コントローラの `reconcile` 操作として実装し、`suiba-paper-reconcile.yml`
  （確認フレーズ `RECONCILE-PAPER`、変数 `SUIBA_PAPER_RECONCILE_ENABLED`、
  モード retry/deploy、deploy 時は sha 入力）から承認タップで実行できる
  ようにした。証拠チェックと是正手順は `reconcile-preflight.sh` と同一で、
  シェル版は非常用として残す。あわせて CI モードで `approve-deploy` が
  前提とする `approvals/<sha>.json` を誰も書かない不整合を解消した:
  CI モードではコントローラが最小レコード（sha/operation/expires 1時間）
  を materialize する（配置自体の承認は GitHub Environment と ci_run の
  単調増加が担う）。
- 監視失敗後の回復操作の Actions 化（2026-11-07）: 監視段階で失敗して
  clean_stopped で止まったランの後始末で、root CLI でしか届かない操作が
  3つ残っていた。`suiba-paper-recover.yml`（確認フレーズ `RECOVER-PAPER`、
  変数 `SUIBA_PAPER_RECOVER_ENABLED`、モード選択）から承認タップで実行
  できるようにした。`release-cutoff` は終了済みランの残り cutoff
  タイマーを解除する（レコードが終端・本体/cutoff サービス停止が条件。
  タイマーは早期終了時の保険だが、quiescent 前提の承認が発火まで
  最大でラン時間分ブロックされていた）。`revoke-retry` は未消費の
  再試行承認を取り消す（配置承認とは排他のため、方針変更時に必要）。
  `approve-deploy` は既存メソッドをそのまま操作化したもので、
  reconcile（preflight 死専用）では届かなかった監視失敗後の再配置が
  Actions で完結する。
- 再試行開始時の stale リセット（2026-11-07）: 監視失敗で止まった
  ランは worker DB に runtime エラー（と API クールダウン）を残し、
  消せるのはダッシュボードのリセット操作だけのため、次回開始が
  worker-readiness（apiAccess／runtimeClear）で詰まることが実地で
  確認された。再試行承認を消費した開始に限り、コントローラが
  readiness 判定中にそのリセットを1回だけ送る（ラン記録に
  staleReset を残す）。再試行承認＝失敗レビュー済みの合図であり、
  本番（prod）の開始経路では送らない。リセット後も readiness は
  実状態で判定する。
- 市場プロバイダを DeepBook へ切り替え（2026-11-07、PR #85）:
  VPS の compose の `MARKET_DATA_PROVIDER` を geckoterminal から
  deepbook に変更した。経緯は GeckoTerminal 利用時に監視段階で
  UPSTREAM_HTTP_429 のハードストップが続いたため。コントローラは
  コンテナ env の値を期待ソースとして採用する（どちらでも可）ため、
  切替の成否は診断の「Market at failure: source」ではなく、配置後の
  コンテナ env と実行時ソースで確認する。
  なお DeepBook プロファイルは `DEEPBOOK_RECONSTRUCT_CANDLES=verified`
  との併用が前提（`docs/DEEPBOOK_24H_PAPER.md`）。当初この指定が
  compose に無く、Indexer の足系列の欠け（実測で 5分足1000本中2本）
  が全取得を CANDLE_GAP で落とし、market-freshness で2回停止した。
  PR #89 で compose に追加した。
- CYCLE の自動診断（2026-11-07、PR #100）: オーナー要望
  「watch が失敗を見たら診断まで自動で流してほしい」を実装。
  CYCLE ジョブは retry/start のステップ失敗時、または watch が
  failed_requires_review を観測したとき、同じジョブ・同じ
  Environment 承認のまま CHECK-PAPER-DIAGNOSTICS を実行し、
  出力を job ログとステップサマリに残す。失敗の理由を知るため
  だけの2回目の承認が不要になる。watch 窓（最大45分）より
  後で起きた失敗は対象外で、従来どおり status ワークフロー
  （同じ承認が必要）が要る。読み取り専用キーで status 自体を
  承認なしにする分離案は、この自動診断で当面の不便が解ける
  ため保留。
- 検証リース上限と長時間ラン（2026-11-07、PR #99）: 10:28 の
  CYCLE 30m で初めて記録上の completed を達成（30分検証は
  卒業）。続く 6h ランは arm で 409 拒否：検証セッション
  （sui-30m）の arm リース上限が「30分固定」で、6h の cutoff
  を送ると PAPER_CHECK_ARM_REJECTED になった。30m しか回して
  こなかったため未表面化だった設計の穴。上限を「コントローラ
  が要求しうる最長＝24h」（MAX_VALIDATION_LEASE_MS）へ変更。
  リースの有限性と run ごとの正確な cutoff の担保（タイマー＋
  監視＋arm 応答の一致確認）は不変。定期再 arm 案は不採用。
- cutoff 競合の第2入口（2026-11-07、PR #98）: PR #93 の委譲は
  「通常停止が見えている場合」だけが対象で、09:13 の完走ランは
  タイマー発火の瞬間にコントローラが監視ループを抜けた直後
  （intent 未書）で、cutoff が先に intent を取って健全な
  コントローラを終了させ、failed_requires_review に落ちた
  （レシートは clean、証拠は全て健全）。対策は2点。(1) cutoff
  の停止は、コントローラ生存中は最大60秒待って通常停止が
  見えるのを待ち、見えたら委譲する（死んでいれば即時、詰まって
  いれば60秒後に従来どおり強制停止する backstop のまま）。
  (2) コントローラは監視ループを抜けたら最初に 'normal' の
  intent を書く。verify_run の normal-cutoff 期待値は不変。
- 開始拒否の楔の修正とヒーリング操作（2026-11-07、PR #96）:
  CYCLE 初ラン（08:49）は readiness 通過後、起動サイクルが
  STALE_CANDLES（Indexer の足遅れ）で止まって runtime error が
  残り、paper-start が 409 で拒否された。guard は「中断時は
  pending を残す」設計のため、確実に実行されていない開始が
  OPERATION_COMPLETION_UNCONFIRMED になり、レシートは
  failed_state_unknown＋フォールトで、通常の RETRY ゲートが
  通らない楔になった。修正は3点。(1) guard はサーバが明確に
  拒否した操作（HTTP 4xx）では pending を消す（5xx・輸送失敗は
  従来どおり未確認のまま）。(2) 再試行承認時のみ、paper-start
  直前に readiness の開始ブロッカー（runtimeClear／apiAccess）
  を再確認し、残っていたらリセットを再送してから開始する。
  (3) 回復操作 heal-run を追加：停止レシートのエラーが
  OPERATION_COMPLETION_UNCONFIRMED（＋LATCHED_FAILURE）のみで、
  failure が arm／paper-start の 4xx 拒否、pending がその操作と
  一致し、診断の証拠（終了コード0・保守ラッチ・ライフサイクル・
  DB検証）が全てクリーンな run に限り、証拠を heal-* バック
  アップへ退避してからフォールト解除＋レシートを clean_stopped
  に直す。cutoff タイマーが残っていれば先に release-cutoff が
  要る（quiescent ゲート）。
- 承認回数の削減（2026-11-07、PR #94）: 検証サイクルのたびに
  RETRY／START／WATCH とステータス確認で環境承認が要り、今朝は
  数十回のタップになった。対策は2つ。新ワークフロー
  suiba-paper-cycle.yml は再試行承認→開始→監視を1ジョブに
  まとめ、環境承認は全体で1回（監視は観測のみで約45分上限、
  6h/24h の最終結果は後からステータスで読む）。ゲート変数は
  SUIBA_PAPER_START_ENABLED を共用する。読み取り専用
  （suiba-paper-status／suiba-paper-watch）を承認者なしの環境
  sakura-vps-read へ分離する案も同PRに入れたが、環境シークレット
  の値（書き込み専用で読み戻せない）の再登録が必要で、本人が
  設定値を失念していたため同日中に取り下げた（PR #95 で環境を
  sakura-vps に戻し、空の sakura-vps-read 環境も削除）。
  ステータス／診断は従来どおり承認つき。
- cutoff と正常終了の競合修正（2026-11-07、PR #93）: 同日の30分
  ランは監視とクリーン停止を完走した（runtime error 解消、
  starts +1、終了コード0、全DB正常）のに failed_requires_review
  で終わった。failure の記録もフォールトも無くレシートは
  clean_stopped。原因は終了処理の競合：正常終了は record を
  finishing にし、サービスの ExecStopPost（source=post-stop）
  だけが completed にできる。ところがバックストップの cutoff
  タイマーが30分ちょうどに発火して終了処理中に cleanup を実行
  し、post-stop 以外は completed にできないルールのため healthy
  なランを failed_requires_review に落とした（後から post-stop
  が来ても覆せない）。cutoff が「自前の正常停止が進行中
  （stop-request が normal、または status が finishing）」を
  見つけたら finalization に触らず post-stop に委ねるよう改めた。
  停止を始めていないコントローラへのバックストップは不変で、
  仮に停止途中で固まっても worker のセッションリースが cutoff
  で失効するため売買は続かない。
- stale リセットの再送化（2026-11-07、PR #92）: PR #91 の計器で
  seq 10 ランの内訳が確定した。DB の runtime error は開始前後で
  CANDLE_GAP のまま不変＝PR #88 のリセットは届いておらず、初回
  サイクルは取得成功（1555ms）後に MARKET_SOURCE_CHANGED（source
  文字列が verified-v1 に変わる初回だけの仕様動作）、続いて取得
  45秒デッドライン超過（MARKET_DATA_STALLED）が2回。リセットは
  冪等な状態クリアであり start/arm/order とは性質が違うため、
  送信失敗時は readiness が通るまでポーリング毎に再送するよう
  改めた（試行回数を failure に記録）。あわせて診断イベントに
  stall の reasonDetail を含めた。
- readiness 失敗の帰属計器（2026-11-07、PR #91）: 再構成フラグが
  正しく届いた seq 10 ランも worker-readiness で停止した。停止中の
  worker は最初の永続エラーを書き換えない設計のため、診断の
  runtime 行だけでは「リセットが届いたか」「その後のサイクルが
  何で失敗したか」が分からない。failure.json に stale_reset
  （送信と成否）を失敗時も残し、診断 DB 照会に operation_events
  直近10件と最終取得所要（operation_state）を追加した。ホストの
  DB に前回ランのイベントが残るため、次回診断だけで前回ランの
  内訳が読める。
- env プロファイル完全性の preflight 化（2026-11-07、PR #90）:
  上記の付け忘れを、開始後ではなく開始前の preflight で弾くように
  した。コントローラの env 照合（preflight と診断の container
  checks の両方）を `provider_profile_ok` に統一し、provider が
  deepbook のときは `DEEPBOOK_RECONSTRUCT_CANDLES=verified` の
  併記を必須とする。不完全なプロファイルは数秒で
  preflight（detail=env）として表面化する。
  なお初回の切替配置（seq 8）は、setup の取得がマージ直後で
  raw の旧内容（ブランチ URL のキャッシュ）に当たり、旧 compose の
  まま配置される事故があった。setup 系スクリプトはコミット固定の
  raw URL（`raw.githubusercontent.com/tajumaru/SuiBa/<sha>/...`）で
  取得し、配置後に compose の sha256 が想定ピンと一致するか
  setup の出力で必ず確認すること。
- 配置コンテナの環境変数（2026-11-06）: paper-check の env 検査が
  要求する TRADING_PAIR=SUI_USDC / PAPER_CHECK_MODE=sui-30m /
  MARKET_DATA_PROVIDER=geckoterminal を `docker/compose.vps.yaml` に
  固定した。broker の setup（setup-ci-approval.sh）が policy の
  compose.yaml もピン検証付きで配布し、`compose_sha256` を更新する。
- 市場プロバイダの切り替え（2026-11-06）: コントローラは
  geckoterminal / deepbook のどちらでも検証できるようにした
  （preflight で env から期待する summary の source を決め、鮮度・
  監視はそれと一致するかを見る。source が途中で入れ替わり得る
  `auto` は検証対象にしない）。切り替えは配置時：compose の
  MARKET_DATA_PROVIDER を変える（あわせて setup-ci-approval.sh の
  compose ピン更新）→ broker setup → 再配置、の順。既定は
  geckoterminal のまま。


## admission の拒否証拠（2026-11-07）

開始前のpolicy・start-request・abort-inhibit・quiescent・前任run・retry/freshの各関門が拒否した場合、run.jsonとは別のadmission-failure.jsonへ直近の失敗を記録する。再試行承認の未消費permit残留もRETRY_ALREADY_APPROVEDとして記録する。判定と順序は変更しない。

証拠は固定コード、時刻、対象cutoff unitのActiveState/job有無、permit/inhibit有無だけ。例外メッセージ、パス、設定、秘密値は保存しない。記録はbest-effortであり、記録失敗によって開始を許可することはない。成功後も「最後の失敗」として時刻付きで保持し、現在のrunの失敗とは区別する。

status/diagnoseにadmission_failureを追加し、初回のrun未作成時も確認できる。SSHスクリプトはPAPER_CHECK_REASON行の明示allowlistだけを表示し、任意のSCREAMING_CASEや生stderrは通さない。ホスト反映には既存手順でSHA固定のsetup更新が必要。


## 公開用の開始前バックアップ抽出（2026-11-07）

`SuiBa public pre-run snapshot export` はmain上の手動workflow。repository変数 `SUIBA_PAPER_EXPORT_ENABLED=true`、sakura-vps環境の承認、確認文字列 `EXPORT-PAPER-PUBLIC` が揃ったときだけ、既存の固定wrapperへ `{"operation":"export-snapshot"}` を送る。任意のパス・runId・SQL・コマンドは受け取らない。セットアップではcontrollerとexport_snapshot.pyのSHA256ピンを同時に検証して配置する。

**このrepoはpublicであり、Actions artifactは誰でも取得できる前提。抽出された経済データ・判断・取引時刻・数量・費用・run識別情報が公開される。保持は1日だが、第三者が取得したコピーの消去は保証できない。** 承認者はこの公開範囲を確認してから実行する。鍵・接続先・token・任意のstderrやrawバックアップはartifactに含めない。

対象は現在のrun.jsonが指す直近ランに紐づく**開始前バックアップのみ**。終了済みランに加え、オーナーの選択により稼働中/終了処理中ランも同じ開始前コピーを対象にできる。backup未記録ならEXPORT_BACKUP_MISSINGで拒否する。生の現行DBやvolumeを開かず、worker/API/systemctl/Dockerを呼ばず、停止・ラッチ・復旧操作をしない。

既存の開始前保存形式はtarで、独立したmanifest.jsonではなく、root所有run.jsonのbackup欄がfileとsha256を保持している。このtrusted manifest情報のSHA256を同じFDのtar全体と照合し、不一致はEXPORT_MANIFEST_MISMATCH。元のtarは公開しない。128MiB/4096メンバー/60秒/総10万行/抽出16MiBを上限とし、超過時は部分抽出を成功扱いしない。SQLite WAL回復は一時コピー内だけで行う。

新規SQLiteへ再構成する対象テーブルは strategy_decisions / technical_indicators / operation_candidates / paper_orders / paper_trades / operation_events / cycle_audits の7種類（存在するもの）。列はid/timestamp/jsonだけ。JSONも固定の数値・真偽値・enumのallowlistで再構成する。設定テーブル、runtime、認証、足、portfolio_snapshots、判断のthresholds、注文経路・HTTP headers、自由文は出さない。IDと相互参照は同じSHA256表現へ変換し、結合を維持する。未知のイベントコードはREDACTEDとする。

公開manifestにはscope=PRE_RUN_BACKUP_PUBLIC_EXTRACT、runの固定項目、元tarのSHA256、生成DBのSHA256・サイズ・件数と省略範囲を記録する。runner側でもファイル名/サイズ/ハッシュ/テーブル/JSON allowlistを検証し、検証済みのSQLiteとmanifestだけをartifact化する。取得したDBは `node --import tsx scripts/ml-data-audit.ts <PAIR.sqlite> <FROM_ISO> <UNTIL_ISO>` で監査できる。対象期間はバックアップに含まれる過去の時刻を指定する。

制約：開始前コピーには当該ラン中の新しい判断・約定・停止は入らない。今回の6時間ランの成績そのものを確定するデータ経路ではない。また、設定/thresholdsを意図的に省略するため監査のevidenceCompleteは完全にならず、公開抽出だけから当時の全設定や学習ラベルを復元できない。終了後DBの公開・非公開配送は本変更の対象外として未決。


## admission 拒否証拠の履歴（2026-11-07）

`admission-failure.json` と `admission_failure` は従来どおり最新1件の形を維持する。別ファイル `admission-failures.json` に同じ証拠を古い順で追記し、最新5件まで保持する。6件目では最古を落とす。既存エントリの内容は変更せず、更新はatomicに置き換える。

status/diagnoseのJSONには `admission_failures` を追加し、SSHの要約にも古い順の履歴を表示する。旧形式で履歴が無い場合は有効な最新1件を返す。個別の不正エントリは落とし、破損JSON・型不正・4096バイト超・全件不正の場合も有効な最新1件へフォールバックする。フォールバック先の最新1件も不正なら履歴は空配列にし、既存のADMISSION_EVIDENCE_INVALID表示を維持する。読み取りはファイルを書き換えない。次の拒否時に有効な履歴と新しい証拠だけで更新する。

履歴更新は専用のadmission-history診断ロック下で行う。最新1件の保存とは独立したbest-effort処理で、履歴読み書きの失敗によって拒否ゲートを変更しない。上限4096バイトは引き上げず、brokerと同じJSON表現に改行1バイトを見込んで、超過時は古いエントリから減らす。固定コード・時刻・既存allowlistの観測状態だけを保存し、例外文・パス・設定値は加えない。開始・再試行の条件と順序は変更しない。


## リセット範囲の限定（A案、2026-11-07）

POST /api/control のresetは、現在のworkerが起動時に読んだ「前任由来のruntime.errorと保存済みAPI cooldown」だけを対象にする。emergencyは前任・新規を問わず解除しない。起動後の新規エラー、同名の429再発、開始後のエラーは保持する。resetはstart/armを行わず、自動再開も追加しない。429の停止条件やSui/DeepBook通信経路は変更しない。

workerは、pairの初回起動前に前任エラーと対象API名を固定し、monitor.bootの後・scheduler開始前に世代を確定する。世代はbootId/pair/runtime書き込みrevision/API失敗revision/safety generationに束縛する。起動途中の新規失敗も、同じ文字列のerror再書き込みも、古い期待値で解除できない。pairの再訪時に同じworker内のエラーを新たな前任扱いにしない。

前任のハードエラー/有効なcooldownが残る間は、schedulerの市場ウォームアップを保留する。前任のAPIブロックによる起動直後の取得拒否を、新規上流障害に取り違えないためで、運用は停止のまま。scoped reset後は長いintervalをもう1周期待たず準備schedulerを起こし、通常のウォームアップと鮮度確認を行う。runtime.runningはfalseのままで、売買開始や発注権限を付与しない。エラーが無く期限だけで解消する旧cooldownは、期限後に通常の準備へ戻る。

GET /api/deploymentにresetScope（pendingを含む）を追加する。再試行承認つきcontrollerは、最初のscopeのversion/bootId/pair/generation/expectedErrorを固定し、resetのexpectedResetとして送る。後のGETで期待値を更新して再承認することはない。emergency、世代不一致、前任対象外、旧workerのscope未対応はその場で開始を中止し、failure.jsonのreset_refusalに固定コードを記録する。diagnoseとSSH要約も表示する。例外文、HTTP bodyやscopeの生データは証拠へ保存しない。

解除は同期処理とDB transactionで行い、API状態はDB commit後に対象の前任APIだけ更新する。新しい失敗が無い同じscopeに限り、応答を失ったresetの再送を200で確認できる。実行中のAPI要求はRESET_BUSYとして変更せず有限の既存待機窓で再確認する。409の世代不一致・emergency拒否は再送しない。

世代は保守的に扱う。起動後にruntimeの新しい書き込みやAPI失敗があれば、原因が古いcooldownに由来するように見えても、そのbootのscopeで再分類・解除しない。開始は拒否して証拠を残す。古い無条件resetへのフォールバックはない。ダッシュボード等のexpectedReset省略リクエストもworker自身が固定した同じ前任scopeに限定する。

反映順序：本変更はworkerイメージの配置とcontroller/setup更新の両方が必要。worker未対応の間、新controllerの再試行開始はRESET_SCOPE_UNAVAILABLEで拒否する。新workerは旧controllerの無条件resetでも新規エラーやemergencyを消さない。実機反映と本番切替は別の承認済み手順で行い、本PRから操作しない。

未決：emergencyおよび現在bootの新規ハードストップを人が解除する専用経路は、本変更では新設しない。従来のresetボタンによるそれらの解除はできなくなる。別途明示的な設計・判断が必要。

## CANDLE_STALE の回復待ち（2026-11-07）

6h 検証ランは 16:10 に STALE_CANDLES で安全停止した（failed_requires_review、停止はクリーン）。Indexer の5分足系列を実測すると、同日の STALE 停止2件（11:22ごろ／16:10）はどちらも末尾の足が1本だけ欠けたタイミング（11:15／16:05 スロット）と一致し、16時台〜18時台の欠落は4本だった。足が1本欠けると失効ライン（終値＋60秒）までの猶予の大半をそれだけで使い切り、次の足の発行遅延と回復エピソード上限（3分／9回）でハードストップになる。Bot 側の故障ではない。

対応として、エピソードの内訳が MarketData/CANDLE_STALE だけの間は専用の上限（30分／61回、失敗カウントは30秒間隔のスロットル前提で時間側が実質の判定）を使うよう変更した。鮮度が戻れば既存の回復条件で自動再開し、30分を超えれば従来どおり PAPER_RECOVERY_EXHAUSTED でハードストップする。他種の失敗が混ざったエピソードは一般の上限（3分／9回）に戻る。stale 中は売買しない不変条件と、429／500（pause 中に到着した場合を含む）の即時ハードストップは変更していない。反映は worker イメージの配置に乗る。

## STALE_CANDLES の入口統一（2026-11-08）

作業5（PR #106）反映後の6h再ラン（2026-11-07 20:37開始）は、20:56にSTALE_CANDLESでハードストップしfailed_requires_reviewになった。Indexerの20:50の足が欠けていた（20:45→20:55の穴）。鮮度切れの入口は2つあり、#106で直したのは監視（watchdog）が記録済みの最終確定足の経過で検知する入口だけだった。今回は取得した足そのものが古く、検証（validateCandles）がtick内で例外を投げ、エンジンの例外処理が即ハードストップした。境界（最終確定足の終値＋360秒）は両入口で同じで、どちらが先に触るかは周期のレースである。

対応として、tick内でSTALE_CANDLESが投げられた場合も、監視側と同じstallの仕組みへ合流させた（OperationMonitor.staleThrowToStall）。条件は、稼働中であること、既存のエラー／emergencyがないこと、監視側の鮮度記録でもCANDLE_STALEと判定できること。全て満たさなければ従来どおりハードストップする。回復局面で古い足が読めた場合は「回復の証明の失敗」として従来どおりハードストップする（既存テストで固定）。CANDLE_GAPと429／500の扱いは不変。

## 検証ランの読み取り専用モニター（2026-11-08）

オーナーの要望：検証ランが動いているか／止まっていないかを、承認タップなしで定期的に知りたい。既存の production monitor は本番専用で、かつ sakura-vps 環境の必須レビューのため schedule 実行も承認待ちになる弱点があった。検証用に、読み取り専用の監視経路を新設する。

- ホスト側の identity は `suiba-observe`。制限は三重：(1) authorized_keys の強制コマンド（status wrapper 固定、restrict 付き）、(2) sudoers は observe wrapper のみ、(3) controller 自身が SUDO_USER/SUDO_UID で呼び出し元を判定し、observe は `{"operation":"status"}` 以外を全て拒否する。鍵が漏れても開始・停止・診断はできない。公開鍵は setup-paper-check.sh にピン留めして配布し、setup のスモークで status の実読み＋status 以外の拒否まで検証する。オーナーの Windows ログイン（ubuntu）や CI の suiba-deploy 鍵には一切触らない（追加のみ）。
- GitHub 側は環境 `sakura-vps-observe`（必須レビューなし、observe 専用キーの secrets のみ）に `suiba-paper-monitor.yml` を置く。cron 30分＋手動 dispatch、repo 変数 `SUIBA_PAPER_MONITOR_ENABLED=true` のときだけ動く。check ジョブが status を読み、検証済みの小さなレポートだけを notify ジョブへ渡す。notify は issues:write のみを持ち、ホスト認証情報を受け取らない。
- 通知条件：ランが failed_requires_review（終端状態での requires_review フラグ残留を含む）、status が読めない／形が不正、のいずれかで専用 Issue（ラベル `suiba-paper-alert`、固定タイトル＋マーカーで一本化）を開く／更新する。正常な観測が戻れば自動で閉じる。ラン記録が無い場合は「回復の証明ではない」として何もしない（production monitor の not_started と同じ扱い）。自動復旧はしない。
- 有効化の前提：setup-paper-check.sh の再実行（observe identity の配置）→ 環境 secrets の登録 → 変数を true にする。supervisor が稼働中の setup 再実行は従来どおり拒否されるため、ランとランの間で実行する。

## 検証ラダーに 2h を追加（2026-11-08、オーナー提案）

6h は3回連続で CANDLE_STALE 系の停止になり、失敗までの時間も短い（3回目は約30分）。6h の前に 2h の段を追加し、卒業ラダーを 30m → 2h → 6h → 24h にする。2h は「30分を超えて回り続ける」ことの最初の証拠になり、失敗しても失う時間が短い。

実装は duration の固定集合への追加のみ：controller の DURATIONS（7200秒）と cutoff タイマー unit（suiba-paper-check-cutoff-2h.timer、OnActiveSec=2h）、setup の配布対象（16ファイル）と TIMERS/UNITS、開始・回復・状態表示・export・モニターの duration 許可集合、CYCLE／START ワークフローの選択肢。検証セッションのリース上限（24h）や安全条件は不変。反映は setup 再実行（controller と unit の配置）が必要で、worker イメージの再配置は不要。

## 監視役が回復一時停止を許容する（2026-11-08、根本原因の確定と修正）

6h 再々ラン（07:22開始）と 2h ラン（08:09開始）がどちらも CANDLE_STALE の一時停止から数分以内に failed_requires_review になった。export のイベント記録が決定的だった：一時停止 07:51:04 → MANUAL_STOP 07:51:07（3秒）。MANUAL_STOP は controller が送る停止コマンドであり、worker の回復期限（30分）ではない。

根本原因：controller の監視（monitor_once）が「/api/deployment の running が true」「市場の最終成功が90秒以内」を5秒ごとに要求していた。worker が回復エピソードで一時停止すると running=false になり、最初の監視ポーリングで例外→ラン失敗として確定していた。つまり PR #106/#107 の回復機構は、監督下のランでは構造的に発動できなかった（16:10 の停止も同型だった可能性が高い）。

修正（オーナーが案Aを選択）：monitor_once が「宣言された回復一時停止」を区別して許容する。判定は既存の /api/deployment の readiness を使う：running=false でも、connectivity が非HEALTHY（エピソード進行中）・runtimeClear（エラー未ラッチ）・emergencyClear が全て成り立てば一時停止として扱い、鮮度90秒ルールを止めて監視を続ける（コンテナとホストの確認は継続）。worker 側の期限（stale 30分）を過ぎれば worker がエラーをラッチして即失敗に戻る。保険として controller 側にも外側の上限40分を置く（PAUSE_OUTER_LIMIT_MS）。エラー停止・緊急停止・素の停止は従来どおり即失敗。worker の変更はなく、反映は setup 再実行（controller 配置）のみ。
