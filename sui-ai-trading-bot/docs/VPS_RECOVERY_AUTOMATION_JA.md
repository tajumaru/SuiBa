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
