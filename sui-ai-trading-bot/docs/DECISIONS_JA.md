# 決定の記録（Decisions）

オーナー（たじゅまる）が既に判断したことの台帳。エージェントは
ここにある「見送り」を再提案・実装しないこと。判断が変わるのは
オーナーから話が出たときだけ。

## 見送り確定（再提案しない）

| 項目 | 決めた日 | 理由・補足 |
|---|---|---|
| 実績バッジ（トロフィー棚） | 2026-10-26 | 別ページ化への懸念。本人は見送りと明言 |
| 売りの演出（お祝い系） | 2026-10-27 | 本人が「忘れて」と指示。試作も削除済み。売りラインの「表示」は別物で実装済み |
| 強制買いボタン類 | — | 安全方針に反するため却下リスト入り |
| パターンログイン | — | 最小フォーム（B）に確定し廃止 |
| ブート画面のつよめ CRT 演出 | — | プレーン版に確定 |
| キャラのスキン色替え | 2026-10-31 | 試作提示のうえ見送り |
| 100 USDC 全力トレード（設定上限の大幅拡張） | 2026-11-03 | 本人が見送り。注文上限などの設定上限は現行のまま |
| BTC の値動きを取引判断に使う | 2026-11-03 | 保存足で実測し先読み効果なし（相関は高いが予測にはならない）。実況の味付け（BTC つぶやき）としては実装済み |
| X（旧 Twitter）自動投稿 | 2026-11-04 | 設計まで提示したが本人が「なしで」と確定 |
| 接近ゲージ（PR #3） | 2026-11-05 | 検証済みリベースまで行ったが、本人の判断で PR を閉じた |
| さくら VPS への移行そのもの | — | （訂正あり）2026-11-02 に一度閉じたが、2026-11-05 に本人が再提起し、承認一本化（CI 承認モード）で進行中。PAPER 本運用は当面 Windows PC |

## 保留（催促しない）

| 項目 | 状態 |
|---|---|
| なかよし度ハート | 2026-11-01、レベル制の試作まで提示。本人が「保留」。却下ではないが催促しない |
| 候補比較バックテスト（`feature/backtest-candidates`） | 2026-10-30 に本人が push 保留。ブランチ駐車中。再開時はこのブランチから |
| アップロード系アクション更新（PR #44/#45）・Worker CI 初回実行 | 2026-11-04 に低価値として棚上げ。`worker-ci` 環境は未作成 |

## 未決定（勝手に決めない）

| 項目 | 補足 |
|---|---|
| アプリの別名（現 "Sui Paper Lab"） | 候補提示済み、新名は未決定 |
| ProfitGuard の表示文言 | 内部名はそのまま、画面文言の差し替え案が未決定 |
| TradeCap Phase 2 の金額・上限 | 設計書 §11 に未決8件。Phase 1 は「Bot 安定化の後」が確定順序 |
| 戦略パラメータの追加（EMA 期間など） | 現行の調整可能項目で足りているという見解まで。追加は候補比較で測ってから |
| M5Stack CoreS3（音声対話デバイス）の購入 | 検討中。支払い手段の接続待ち |

## 確定した方針（判断の前提）

- 予測は「模式」であることをごまかさない。確率は実測ベースで正直に出す。
- キャラの関西弁は、感情が漏れる瞬間（ニアミスの落胆・的中のドヤ等）だけ。通常の実況・会話は標準語。
- Sui ブルーは差し色に留める。「Sui っぽさ」は実データ（チェーン情報など）で出す。
- Bot の安定化が TradeCap 実装より先（2026-11-04 確定）。止まったときの
  調査手順は `docs/TROUBLESHOOTING_JA.md`。
- エピソード上限（3分／9回）は 2026-11-04 に「伸ばさない」と確定。
  調査可能性を先に入れ、原因が分かってから挙動を変える。
- その例外を 2026-11-07 に確定：CANDLE_STALE だけは上限を30分に
  延ばす（B案）。同日の検証ラン2件が、Indexer の5分足が末尾で
  1本欠けただけでハードストップした実測が根拠（欠落が失効までの
  猶予の大半を使う）。stale 中は売買せず、鮮度が戻れば自動再開し、
  30分を超えれば従来どおりハードストップ。一般の上限（3分／9回）
  と 429／500 の即時停止は不変。混ざったエピソードは一般の上限に
  戻る。
- 2026-11-08、その30分化の入口を統一：検証ラン再試行が「取得した
  足の検証で弾かれる入口」から即ハードストップした（入口は2つ
  あり、境界は同じでレースだった）ため、tick 内の STALE_CANDLES
  例外も同じ stall の仕組みに合流させた。回復局面で古い足が読めた
  場合は従来どおりハードストップ（証明の失敗）。

## 2026-11-08 回復中ティックの stale 合流（PR #107 の「failed proof」扱いを撤回）
PR #107 で残した「回復中（running=false）の STALE_CANDLES は failed proof としてハードストップ」を撤回する。controller が一時停止を許容する（PR #112）ようになった結果、回復証明のティックが最初に stale に当たった時点で全ての candle-stale 一時停止が即死するようになっていたため。回復エピソード進行中（resumePending）に限り、ティックの STALE_CANDLES throw も stallFailure に合流させ、30分のエピソード期限に委ねる（オーナーが案Aを選択）。

## 2026-11-08 emergency（緊急停止）の手動解除経路を新設（A案）

PR #105 で「emergency は scoped reset では絶対に解除しない」と決めた結果、解除経路そのものが存在せず、緊急停止を一度押すと再開不能（DB 直接操作のみ）になっていた穴を塞ぐ。オーナーの選択で A案（ダッシュボードのみ）を採用：

- worker の /api/control に専用コマンド `clear-emergency` を追加。停止中・emergency が立っていること・確認文字列 `CLEAR-EMERGENCY` の3条件を全て満たす場合だけ `emergency` フラグを落とす。`error`（安全停止）には触らず、そちらは従来の reset 経路のまま。解除は監査イベント EMERGENCY_CLEARED として残る。
- ダッシュボードの停止解除セクション（戦略タブ上部）で、emergency のときはボタンを「緊急停止を解除」に切り替える（2段階確認：1回目で武装、2回目で確定）。通常の「停止を解除」（reset）は従来どおり emergency を拒否する。
- Actions（controller 経由）の遠隔解除は入れない。キルスイッチの解除は本人の手（ダッシュボード）だけに限る。必要になれば別途 B案として検討する。

## 2026-11-08 アプリの表示名を Potario に変更（タイトルのみ）

2026-10-25 から未決定だった表示名（Sui Paper Lab）を **Potario** に決定し、画面タイトル類だけを変更した。由来は日本語の滴る音「ぽたり」に、ギリシャ語で川・流れを意味する potamos の語根（Pota-）が重なる二重の意味。海外でも発音しやすく、日本語要素と水のモチーフを両立させる狙い（オーナーの基準：海外の人にウケること＋日本語要素＋点滴的なイメージ）。

範囲は表示名のみ：ヘッダーのブランド、ログイン画面のロゴ（POTARIO_）、ブラウザのタブタイトル、版数フッター、README の見出し。GitHub リポジトリ名 SuiBa、内部の suiba-* 命名（ワークフロー、ホスト側ファイル、環境変数）は変更しない（VPS の仕組み一式への波及を避けるため）。

アプリアイコンも同日に決定した：白い雫キャラ（B 案：ローソク足を抱える姿）を土台に、雪男要素（全身の毛並み＋頭の雪）を足した「もふもふ雪男雫」を採用（試作 Y1）。favicon／apple-touch-icon として配置する。名前の由来（ぽたり×potamos）と同じく、日本のキャラ感とギリシャの語根の物語を両立させる方針の延長。

## 2026-11-08 検証ランにプリセット入力（safe／hard）を追加

検証ランをハードプリセットで回すには従来ダッシュボード経由の手作業（SSHトンネル＋設定保存＋終了後の手動復旧）が必要だった。オーナーの指示で、CYCLE の入力に preset（safe／hard、既定 safe）を足し、controller がそのラン限り SUI 設定を差し替える形にした：開始時（バックアップ後・worker 起動前）に現行設定をランフォルダへ snapshot し、hard プリセット（dashboard の applyHardPreset と同値。tests/preset-parity.test.ts がドリフトを検出）を DB へ書き、終了時の finalize（post-stop cleanup）で snapshot を復旧する。復旧失敗は PRESET_RESTORE_FAILED として failed_requires_review に落とし、次回 admission でも未復旧なら先に復旧する（冪等）。対象は SUI_USDC の設定のみ。24h ランは本稼働ラダーの最終段として通常設定（safe）で回す方針も同日に決定（ハード検証は 6h）。

## 2026-11-08 検証サイクルが開始直後に前ランの記録を自動 export する

検証ランの結果（判断記録）は、ホストの外へ出せるのが「次のランの開始時バックアップ」が作られた瞬間からで、従来はラン終了後に EXPORT ワークフローを手動 dispatch（＋承認）しないと振り返りレポートに載らなかった。オーナーの指示で、CYCLE ジョブが開始ステップ直後に、同一の環境承認の内側で export 固定操作を実行し、standalone の export と同じ名前・形の artifact を自ランに載せる形にした。レビュー側は workflow_run の対象に CYCLE を加え、サイクル完了時にその artifact からレポートを生成して常設 Issue（#121）へ投稿する。

export の失敗はサイクルを落とさない（continue-on-error、artifact が無ければレビューは静かに終了）。export の有効ゲート（SUIBA_PAPER_EXPORT_ENABLED）は standalone と共用する。手動 EXPORT ワークフローは従来どおり残す（任意のタイミングの再書き出し用）。

## 2026-11-09 実況にパチンコ風の煽り3点セット（リーチ／ハード連動／連チャン）

オーナーの発案「煽りはパチンコ級、数字は正直（実測）」を実況の範囲だけで実装した（取引ロジック・売買条件は不変）。

- **リーチ煽り**：買い条件3つのうち2つが立った（met=2）ら、そのエピソードで一度だけ実況種別 `reach` で宣言し、不足条件を既存の「あと○○だけ」文面と実測値で名指しする。不足条件が既存の注目（watch）の接近判定（宣言距離の半分以下＝WATCH_APPROACH_RATIO）まで詰めたら `superReach` へ一度だけ格上げ。エピソードは「同じ不足条件で met=2 が続く区間」で、met が2を離れる／不足条件が変わると静かに終わる。met=1 では出さない。新しい指標は作らず、既存の充足数と距離測度だけを使う。
- **ハード連動**：presetName === 'hard' の間だけリーチ／スーパーリーチ／的中（watchHit）の文面を熱いバリアントに切り替える。判定はヘッダーのハード表示と同じ presetName を使う。関西弁は従来どおりニアミスと的中ドヤだけに限る。
- **連チャン**：実況された的中が連続したらカウンタ（hitStreak）を増やし、2連チャン以上で的中文の末尾に「○連チャン」を添える。外れ（miss の精算）でリセットし、無言の精算では動かさない。状態は実況状態（reach／hitStreak）として既存の保存経路に載せ、旧保存データは .default() で読み替える。

## 2026-11-09 本番のライブ状態から日次レビューを出す経路を追加

本稼働の最初の1週間を「集中観察週間」とする決定（同日）に伴う部品。従来の自動レビューは検証ランの pre-run バックアップ export が前提で、常時運転の本番には「次のランの開始時バックアップ」が存在しないため、本番の判断記録をレビューに載せる経路が無かった。切替前に「先に作って未使用」の形（配置サイクル PR #125 と同じ）で用意する。

- controller に固定 op `export-prod-snapshot` を追加。稼働中の本番 DB（DATA ボリュームの bot.sqlite と WAL ペア DB）を sqlite の backup API で整合コピーし、メモリ上で tar 化して既存の export プログラム（許可リスト＋秘匿処理）へ通す。worker の停止・再起動・helper 起動は一切しない読み取り専用 op で、本番が in_progress でなければ `EXPORT_PROD_NOT_RUNNING` で拒否する。
- 公開パッケージの manifest scope は `PROD_LIVE_PUBLIC_EXTRACT` とし、検証用（PRE_RUN_BACKUP_PUBLIC_EXTRACT）と区別する。run ブロックは本番セッション（id／started／sha）を指す。抽出テーブル・秘匿処理・上限は検証用と同一。
- 呼び出しは読み取り専用 identity `suiba-observe` 経由とし、controller の caller scope を「status と、この固定 op のみ」へ拡張した（どちらも引数なし・読み取り専用。authorized_keys の強制コマンドと sudoers の制限は不変）。deploy identity と環境承認は使わないため、日次スケジュールが承認タップなしで回る（検証モニターと同じ形）。
- 新ワークフロー `suiba-prod-review.yml`：毎日 00:17 JST に schedule 起動し、ゲート変数 `SUIBA_PROD_REVIEW_ENABLED` が無い間は両ジョブとも完全に不発。流れは export（observe 環境、artifact 保持1日）→ `run-review.py` を直近24時間の窓（`--since`/`--until`）で実行 → 常設 Issue #121 へ投稿。投稿先とラベルは検証レビューと共用する。
- ホスト配布は従来どおり setup-paper-check.sh 経由（controller と export プログラムのピンを同一コミットで更新）。本番はまだ存在しないため実地検証は切替時になる：初回は手動 dispatch（REVIEW-PROD-DAILY）で export とレビュー投稿をスモーク確認してから、ゲート変数を有効化する。

## 2026-11-09 板ガード系の throw をエピソード／一時停止経路へ寄せる

2026-11-09 06:55（月曜早朝＝週末明けの薄い板）、24h 検証ランが DeepBook のスプレッドが一度広がっただけで `SPREAD_TOO_WIDE` により即ハード停止した（failed_requires_review、警報 Issue #133）。注文・約定はゼロ、停止処理と DB 整合性は正常だった。

根本原因は入口の非対称：輸送失敗と古い足（STALE_CANDLES）はエピソード／一時停止の経路を通るのに、板ガード（SPREAD_TOO_WIDE／THIN_ORDERBOOK／STALE_ORDERBOOK／INVALID_ORDERBOOK）は通常の Error で ApiFailure が残らず（transientCycleFailure の対象外）、staleThrowToStall の対象も STALE_CANDLES だけだったため、1回の throw で failCycle→即停止していた。2026-11-07 に古い足の throw 入口を直した際、板ガードが取り残されていた形。

オーナーの選択で、板ガード4コードの throw を STALE_CANDLES の先例と同じくエピソード経路へ寄せた（worker の `bookGuardThrowToEpisode` → stallFailure と共有する会計 `episodeFailure`）。一時停止（DEGRADED・resumePending）し、既存の回復証明で自動再開する。tally キーは `MarketData/<コード>`、制限は標準（180秒／9回）で、継続すれば checkRecoveryDeadline が PAPER_RECOVERY_EXHAUSTED へ格上げする。一時停止中の tick で同じ板ガードが throw しても同エピソードの継続として数える（30秒のカウント絞りも共有）。

変えていないもの：MARKET_PAIR_MISMATCH／MARKET_SOURCE_CHANGED は従来どおり即停止（同一性・設定の問題）。足ガード系（INSUFFICIENT_CANDLES／INVALID_CANDLE／CANDLE_GAP／PRICE_OUTLIER）は範囲外、STALE_CANDLES は既存のまま。HTTP 429／500 の即時ハード停止、スプレッド閾値そのもの、取引ロジック・売買条件は変更しない。一時停止中は ordersAllowed のゲート（HEALTHY＋新鮮な市場データ必須）により売買は起きない。

## 2026-11-09 配置サイクルの planner 前提を修正（failed＋ラッチなしは整合）

配置サイクル（suiba-paper-deploy-cycle.yml、PR #125）の初回実地使用で、計画ステップが `STATE_INCONSISTENT: run is failed_requires_review but no fault marker is set` と出て安全に中止した。配置そのものは始まっておらず、ホストは無事だった。

planner（docker/paper-deploy-cycle-plan.py）の前提「failed_requires_review ⇒ 障害ラッチ（STATE/paper-check-failed.json）あり」が誤りだった。ラッチは controller の fault() が「手作業の照合が必要な故障」のときだけ書く柵であり、監視中に worker のランタイムエラーで止まって clean に終了したラン（実例：同日の 24h ラン。診断は clean_stopped・整合性チェック通過・ライフサイクル領収書 True）は failed_requires_review でもラッチが付かないのが正しい状態。broker の配置拒否もラッチが存在するときだけ（PAPER_CHECK_RECONCILIATION_REQUIRED）で、ラッチが無ければ配置許可（permit）は不要。

修正：failed＋ラッチなしを整合として扱い `{release_cutoff: タイマー次第, approve_deploy: false}` を返す。中止条件は live（in_progress／finishing）と「ラッチあり＋failed でない」の2つに絞り、診断が読めない場合の中止は維持。計画は順序付けだけを行い、controller／broker がサーバ側で再検証する従来の規律は不変。ホスト配布ファイルに変更は無い。

## 2026-11-09 訂正：approve_deploy は failed の前任全般に必要（上の記録の一部を訂正）

上の記録のうち「ラッチが無ければ配置許可（permit）は不要」とし、approve_deploy を `failed and fault_marker` に絞った部分は誤りだった。PR #135 マージ後に再 dispatch した配置サイクル（run 42530955606）で approve-deploy ステップが skip され、broker が permit 不足で配置を拒否したことで判明した。

正しい意味（broker.py の check_paper_session／controller.py の approve_deploy で確認）：セッション marker（paper-check.json）が in_progress のまま前任ランが failed_requires_review のとき、配置には deploy permit（paper-deploy-<sha>.json。run.json／stop.json／承認ファイルの digest を束縛）が必須で、その permit を発行するのが controller の approve_deploy。approve_deploy の要件は record が failed_requires_review・stop が clean_stopped・**requires_review でないこと**（requires_review＝ラッチまたは fault-*.json が存在）・marker が in_progress であり、ラッチ／fault がある場合は approve_deploy 自体が拒否する（そのケースは reconcile 経路の担当）。つまり approve_deploy が要るのは「failed の前任」全般であり、ラッチのない clean な失敗こそ本命。なおラッチが存在すると broker は permit があっても PAPER_CHECK_RECONCILIATION_REQUIRED で拒否する。

訂正：planner の approve_deploy を `(state == "failed_requires_review")` に戻す（ラッチの有無によらない）。failed＋ラッチなしは整合という PR #135 の修正と、中止条件（live／ラッチあり＋failed でない／診断が読めない）は維持する。planner は順序付けのみで、ラッチ／fault のあるケースはサーバ側（approve_deploy・broker）が拒否する。ホスト配布ファイルに変更は無い。

## 2026-11-09 訂正：開始直後の自動 export はスーパバイザのバックアップ記録と競合する

PR #130 の自動 export は「start ステップが開始前バックアップを作成済み」という前提で開始直後に export していたが、この前提が誤りだった。start op は開始リクエストを記録して systemd サービスを `--no-block` で起動し、即座に `PAPER_CHECK_REQUEST_ACCEPTED` を返すだけである。バックアップ（DATA ボリュームの tar 化と sha256）はスーパバイザ側が admission→preflight→timer の後に実施し、その完了後に初めて run record へ `backup` が記録される。開始直後の export はこの記録前に走るため `EXPORT_BACKUP_MISSING` で拒否される。2026-11-09 の 24h 初回・やり直しの両サイクルで再現し、いずれも数分後の手動 EXPORT は成功した（ハード区間のレビュー未投稿の原因もこれ）。

修正：サイクルに「watch 終了後の再試行」を追加する。開始したランについては、スーパバイザが worker 起動前にバックアップを記録済みであることが保証されるため、watch が終わる頃には記録が存在する。再試行は最大3回・60秒間隔、初回試行が失敗したときだけ走り、従来どおり観測専用（失敗してもサイクルは落とさない）。成功すれば同じ名前でアーティファクトをアップロードし、レビューの自動投稿に乗る。ホスト配布ファイルに変更は無い（export op 自体の意味は不変）。

## 2026-11-09 診断に broker の事前拒否（last-failure）を表示する

broker がトランザクション段階の前で配置を拒否した場合（paper-session ゲート、permit／承認／アーカイブの不足など）、broker は STATE/last-failure.json に公開コードだけの記録（version／at／operation／sha／code）を best-effort で残す。しかしこのファイルを読む固定 op は無く、GitHub Actions 側からは一律 `SUIBA_BROKER_REJECTED_OR_FAILED` としか見えなかった。2026-11-09 の配置サイクル（run 42530955606）では、approve-deploy が skip されて broker が permit 不足で拒否したことがこの盲点のせいで判明まで余分な往復がかかった。診断が既に表示している ledger 側の broker_failure はトランザクション内部の失敗専用で、事前拒否はそこにも残らない。

修正：controller の diagnostic_host が last-failure.json を読み、厳密に検証（キーは正確に5つ、version=1、at は正の整数、operation／sha／code は broker が書く形の正規表現に全一致）を通ったものだけを `broker_last_failure` として診断に含める。検証に落ちる・読めない・ファイルが無い場合はすべて None に劣化させ、診断自体は決して壊さない（broker 側の書き込みが best-effort なのと対）。表示側（docker/ssh-paper-status.sh）は同じ形を検証し、`- Last broker rejection: code=…, operation=…, SHA=…, at=…` の1行を出す。読み取り専用の可視化のみで、broker・各 op の挙動は変えない。

反映のタイミング：controller.py はホスト配布ファイルのため、この変更がホストで効くのは setup-paper-check.sh の次回再実行時（PR #132 の controller 変更と一緒に乗る。pin は同一コミットで更新済み）。

## 2026-11-09 本番モニターを読み取り専用 identity に分離する

本番モニター（suiba-production-monitor.yml）は check ジョブが承認つき環境 sakura-vps＋配置用 identity（suiba-deploy）で30分間隔の定期実行になっており、切替時に SUIBA_PROD_MONITOR_ENABLED を有効化すると、定期実行のたびにオーナーの承認タップ待ちで止まって監視にならない設計だった。検証モニター（suiba-paper-monitor.yml）で実証済みの分離方式に寄せる：check ジョブを承認不要の環境 sakura-vps-observe＋読み取り専用 identity（suiba-observe）に移し、ポートはリポジトリ変数 SUIBA_OBSERVE_VPS_PORT から取る（秘密にすると "22" がマスク語になりジョブ出力を巻き込む事故の再発防止。検証モニター側の既存規律）。notify ジョブ・スケジュール・同時実行制御は不変。

これに伴い **controller の caller scope を拡張**する：suiba-observe が実行できる操作に `{'operation': 'prod-status'}` を追加した（従来は status と export-prod-snapshot のみ）。prod-status は引数なし・読み取り専用で、paper 側 status と同危険度。PR #132 の export-prod-snapshot 追加と同じ種類の scope 変更として明示する。SSH ラッパー（docker/ssh-prod-status.sh）は identity ごとにホスト側入口を切り替え（suiba-deploy→suiba-paper-check／suiba-observe→suiba-paper-observe）、それ以外のユーザーは従来どおり拒否する。

反映のタイミング：controller.py はホスト配布ファイルのため、ホストで効くのは setup-paper-check.sh の次回再実行時（PR #132／#140 の controller 変更と一緒に乗る。pin は同一コミットで更新済み）。SUIBA_PROD_MONITOR_ENABLED は切替まで未設定のまま。

## 2026-11-09 レビューに直近ランの窓を追加する

paper 側の振り返りレビュー（Issue #121 へ自動投稿）は、export された DB の全履歴に対する累計集計しか出しておらず、個別のラン（例：ハードプリセットの6時間）だけを切り出して読むことができなかった。run-review.py には --since/--until（prod レビューが直近24時間窓で使用）があるのに、paper 側では窓を導出する手段が無かったのが原因。

追加：run-review.py に `--window last-session` モードを足した。窓は DB 自身の operation_events から導出する：終了＝最後の STOP／PROCESS_SHUTDOWN、開始＝それ以前で最後の BOOT。worker はプロセス起動ごとに BOOT を、最終イベントとして STOP／PROCESS_SHUTDOWN を書き、paper-check のライフサイクルはランごとにコンテナをちょうど1回だけ起動する（restart policy は 'no'）ため、この組が1ランの稼働期間と正確に対応する。導出した窓はそのまま --since/--until と同じ内部経路に流す（集計・採点・フラグのロジックは不変）。組が見つからない、または窓内に判断記録が無い場合は、集計の代わりに「直近ランの窓を特定できませんでした」という注記だけの短い報告を出し、終了コード0で終わる（決して落とさない）。

レビューワークフロー（suiba-paper-review.yml）は、窓レポートを「直近ランの窓」の見出し付きで先に、従来の累計レポートをその後に並べた1コメントを投稿する形に変更した。窓を特定できなかった場合は、その注記が窓セクションとしてそのまま載る。

## 2026-11-09 export の開始直後競合を controller 側で解消する

「開始直後の自動 export はスーパバイザのバックアップ記録と競合する」（同日の訂正）の根本修正。start op は開始リクエストを記録してスーパバイザを起動し即座に返るため、バックアップは admission の途中で初めて run record に記録される。PR #137 の修正はワークフロー側の回避策（watch 終了後に最大3回・60秒間隔で再試行）で、export op 自体は記録前の到着を即座に `EXPORT_BACKUP_MISSING` で拒否したままだった。

修正：controller の `export_snapshot` が、現在の run record に有効な backup が無く、かつそのランが `in_progress` の場合に限り、record を5秒間隔で読み直して backup の出現を最大180秒（`EXPORT_BACKUP_WAIT_SECONDS`／`EXPORT_BACKUP_POLL_SECONDS`）待つ。待ちは「同じ run id のまま backup が記録される」「ランが `in_progress` を離れる」「別 run の record に切り替わる」「窓が満了する」のいずれかで終わり、backup が現れれば従来どおり export し、現れなければ従来どおり `EXPORT_BACKUP_MISSING` で拒否する。終端状態の record は backup を後から得ることが無いため、待ちに入らず即座に拒否する（従来挙動のまま）。別 run の backup を誤って export しないよう、待ちの対象は開始時点で現在の run に固定される。

PR #137 のワークフロー側再試行は多重防御として残す。export 自体が数分で返るようになるため、開始直後の初回試行が成功するのが通常経路になる。

反映のタイミング：controller.py はホスト配布ファイルのため、ホストで効くのは setup-paper-check.sh の次回再実行時（PR #132／#140／#141 の controller 変更と一緒に乗る。pin は同一コミットで更新済み）。

## 2026-11-09 配置失敗時に broker の公開結果コードを配置ジョブ内で表示する

配置サイクル（suiba-paper-deploy-cycle.yml）で broker 配置が失敗しても、ジョブ内では一律の拒否コードしか見えず、理由の特定には配置後の診断を別途読む往復が要った（PR #140 で診断側には broker の事前拒否＝last-failure.json が出るようになったが、配置ジョブ自身は盲目のままだった）。

追加：broker は配置の成否を公開ミラー `/opt/suiba/last-deploy.json`（0644、{version, status, code, sha, at}）へ常時書いている。新規の読み取り専用ラッパー `docker/ssh-broker-last-deploy.sh`（配置用 identity 専用、リモートコマンドはミラーの cat に固定、内容を厳密に検証して1行だけ表示）がそれを読み、配置ステップが失敗した場合に限り、同じジョブ・同じ承認の中で `Broker last deploy: status=…, code=…, SHA=…, at=…` をログとジョブサマリに出す。読めない・壊れている場合は固定の unavailable 行に劣化し、このステップはジョブの成否を変えない。broker・controller の挙動は不変で、ホスト配布ファイルの変更も無い。

本節は PR #144 の決定記録として後から追加したもの（同 PR は DECISIONS_JA への同時追記を避けるため本文への記録のみに留めた）。

## 2026-11-09 本番日次レビューの重複ガードと切替スモークの関係（PR #132 への補足）

PR #139 で suiba-prod-review.yml に schedule を2本化（00:17 JST＋01:17 JST の保険）し、同日重複ガードを入れた：その JST 日付ぶんの投稿が既に Issue #121 にあれば、投稿をスキップしてジョブは緑のまま終わる。

このため、切替後に手動 dispatch（REVIEW-PROD-DAILY）しても、同日ぶんの定期投稿が既にあれば投稿はスキップされる（仕様）。PR #132 の節に書いた切替スモーク（ゲート変数 SUIBA_PROD_REVIEW_ENABLED を有効化する前に手動 dispatch で確認する手順）は、定期投稿がまだ存在しない状態で行うため、このガードの影響を受けない。有効化後に手動で試す場合は「同日ぶんが既にある日は投稿されない」ことを前提に読むこと。

**（2026-11-10 訂正）** スモークの順序について、PR #132 の節と本節の記述が workflow の実装と食い違っていた。suiba-prod-review.yml は PR #132 の時点から一貫して、手動 dispatch 時にも `SUIBA_PROD_REVIEW_ENABLED == 'true'` を両ジョブに要求するため、「有効化前の dispatch」は全ジョブ skip の無言 no-op になり、スモークにならない。正しい順序は「ゲート変数を設定する → その JST 日の初回定期投稿より先に REVIEW-PROD-DAILY を dispatch する」であり、切替手順書（VPS_PRODUCTION_CUTOVER_RUNBOOK_JA）はこの順序で書いてある。重複ガードとの関係（定期投稿が無い状態で先に行う）という本節の趣旨は変わらない。

## 2026-11-09 approve-deploy の失効楔を解消する（作業6、A案）

2026-11-08 の配置 seq 13 で踏んだ楔（docs/CODEX_WORKFLOW_TASKS_JA_20261107.md 作業6）。CI モードの approve-deploy が実体化する配置承認レコード（policy/approvals/<sha>.json）は発行から1時間で失効するが、配置の実行がその窓を過ぎると broker が PAPER_DEPLOY_EXPIRED で拒否し、失効したレコードと未消費の permit（STATE/paper-deploy-<sha>.json）を消す・更新する操作がどこにもないため、同じ sha が二度と approve-deploy を通らなくなっていた。回避は「新しい sha を配置対象にする」ことだけだった。

恒久修正は A案（2026-11-09 に本人が選択）：controller の approve-deploy 自身が、配置サイクルの既存の承認1回の中で失効を検知して再実体化する。ワークフローと broker は変更しない。再実体化が許されるのは次の全てを満たす場合に限る：

- CI モード（policy の approval_source == 'ci'）であること。controller が実体化したのではない承認レコードは、失効していても書き換えず、従来どおり拒否する。
- 承認レコードが存在し、sha／operation が要求と一致し、expires が既に過ぎていること。失効していないレコードは決して上書きしない。
- 消費済みマーカー（.consumed.json）が存在しないこと。存在すれば何も変えずに拒否する。
- 未消費 permit が残っている場合は、その approval_sha256 が失効したレコードの sha256 と一致する場合に限り（＝同じ発行の系譜）取り除き、通常の流れで新しいレコードに束縛された permit を作り直す。他の digest を束縛する permit は触らずに拒否する。

再発行されたレコードは従来と同じ内容（sha／deploy／発行から1時間）で、同じ atomic な書き込みによる。有効窓と single-use の性質は不変で、approve-deploy の他の前提（failed_requires_review、clean stop、セッションマーカー、helper 検証、quiescence 等）は従来どおり全て効く。

反映のタイミング：controller.py はホスト配布ファイルのため、ホストで効くのは setup-paper-check.sh の次回再実行時（本番切替時。pin は同一コミットで更新済み）。

## 2026-11-09 docker-run の復旧シナリオを3並列の matrix に分割する

CI（suiba-no-worker.yml）の壁時間は docker-run ジョブの単一ステップが決めていた。PR #149 の実測ではジョブ全体7分16秒のうち、イメージ構築は buildx のレイヤーキャッシュが効いて32秒、残り6分34秒が `verify_run.py` の9シナリオを直列に実行するステップだった（他のジョブは全て約1.7分以内に終わる）。

9シナリオ（normal／crash／timer／helper／persistence／worker-abort／signal-failure／signal-survive／normal-cutoff）はそれぞれ独立したフィクスチャ（固有の名前・一時ディレクトリ・volume・unit・後片付け）で、共有する状態が無い。時間の主因は persistence／worker-abort／helper に仕込まれた sleep 120秒のフックだったため、各脚にそのシナリオを1つずつ配る3脚の matrix に分割した（crash-group: persistence,normal,crash／abort-group: worker-abort,timer,signal-failure／helper-group: helper,signal-survive,normal-cutoff）。fail-fast は無効にし、1脚の失敗が他の脚の結果を隠さないようにした。集約ジョブ docker-suites は matrix 化されても `needs.docker-run.result`（全脚成功でのみ success）の読み方が従来どおりで不変。

verify_run.py は引数でシナリオの部分集合を選べるようになった（カンマ区切り、正規順で実行、未知の名前はアサーションで即失敗）。シナリオ本体・アサーション・タイミング定数は一切変更・削除しておらず、総カバレッジは同一。3脚の和集合が正規の9件とちょうど一致することは test_setup.py の契約テストで固定した。壁時間は最も遅い脚（sleep 系1件＋速い2件）まで下がる見込み。

## 2026-11-09 docker-run matrix の脚配分を実測で組み替える（PR #150 の追補）

PR #150 の CI 実測で、脚の所要時間は crash-group 66秒／helper-group 3分18秒／abort-group 4分32秒と偏った（abort-group は準備約40秒＋worker-abort 約2分に timer と signal-failure が積み重なっていた）。crash-group のシナリオ群は SIGKILL で注入 sleep が中断されるため軽い。

組み替え：timer と signal-failure を abort-group から crash-group へ移し、abort-group は worker-abort 単独にする。シナリオ・断言・時間定数は一切変更せず、実行する脚だけを変える（デグレ防止）。3脚の和集合＝正規9シナリオの契約テスト（test_setup.py）は不変で合格したまま。全体の壁は最遅の helper-group（約3分18秒）に張り付く見込み。

## 2026-11-09 検証モニターの schedule を3本（約10分間隔）に増やす

2026-11-09 の実測で、モニターの schedule 実行は 05:00〜17:57 JST の約13時間に6回だけだった（15分間隔の期待は約48回、最長で約6時間の空白。24h 初回の警報 Issue #133 も発火から57分遅れ）。GitHub の scheduler は混雑時に schedule を落とす best-effort で、2本冗長化（PR #118）でも命中率が足りなかった。

対策：cron を3本・6発火/時（2,32／12,42／22,52 分、いずれも混雑する正時・15・30・45分を回避）に増やし、名目約10分間隔にする。モニター本体・ゲート・concurrency（suiba-paper-monitor、cancel-in-progress: false で直列化済み）は不変。コストはゼロで、トークンを使う定期チェックは引き続き置かない（2026-11-08 のトークン削減3点運用どおり、GitHub 側の冗長化で閉じる）。本番モニター（suiba-production-monitor.yml、*/30）も同じ間引きを受けるが、ゲート変数が未設定で未稼働のため、切替時に同様の増強を検討する。

## 2026-11-09 本番モニターの schedule を3本（約10分間隔）に増やす

検証モニターと同じ間引き実測（PR #152 の記録）に基づき、本番モニター（suiba-production-monitor.yml）の schedule を */30 の1本から3本・6発火/時へ増強する。分は検証側（2,32／12,42／22,52）と重ならないよう 7,37／17,47／27,57 に交互配置し、いずれも混雑する正時・15・30・45分を回避する。ゲート変数 SUIBA_PROD_MONITOR_ENABLED は未設定のままで、本番モニターは未稼働。効くのは本稼働の切替後。当初は Codex 向け作業として切り出したが、Codex が動けないためシロが実施した。

## 2026-11-10 板ガードだけのエピソードも長い窓（30分/61回）へ広げる（A案）

24h 検証ラン3回目（CYCLE 42630076642、seq 16）が未明に failed_requires_review で終了した。診断（run 42694203919）で確定した落ち方は、SPREAD_TOO_WIDE が1回だけのエピソードが標準窓（180秒/9回）の時間切れで PAPER_RECOVERY_EXHAUSTED になったもの（エピソード実測181949ms、failures=1、tally=MarketData/SPREAD_TOO_WIDE×1、最後の市場取得は 02:40 JST の薄い板）。PR #134 で板ガードは即停止からエピソード経路へ移したが、窓は標準のままだったため、薄い時間帯に数分続く板の広がりを回復サイクル2回で越えられず枯渇した。板の広がりは stale ローソク足と同じ「ゆっくりした市場の状態」であり、読み取りの障害ではない。

決定（オーナーが A 案を選択）：`episodeLimits()` が長い窓（staleEpisodeLimits、30分/61回）を返す条件を、counted failure の tally key がすべて「ゆっくりした市場の状態」の集合（MarketData/CANDLE_STALE、SPREAD_TOO_WIDE、THIN_ORDERBOOK、STALE_ORDERBOOK、INVALID_ORDERBOOK）に収まる場合へ拡張する。ネットワーク系など他の failure が1つでも混ざる混合エピソードと、tally が空の場合は標準窓（180秒/9回）のまま。制限値そのもの、429/500 の即停止、他の回復条件は変更しない。

## 2026-11-10 実売買の手数料は DEEP 払い・ステーク割引なしを設計前提とする（TradeCap 設計書 §11 #2 を決定）

DeepBook の手数料を公式 docs で再確認した。手数料はプール別ガバナンス値（ボラティルプールは taker 1〜10 bps／maker 0〜5 bps の範囲でエポック投票により変動）で、DEEP 払いが基準、入力トークン払いは +25%。DEEP のステークと出来高要件を満たすと taker が半額になる。実効の往復コストは 0.1〜0.25% で、現行 PAPER の前提（feeRate 0.003／回＝往復 0.6%）の約 1/3〜1/6。

決定（オーナーが推し案を採用）：実売買の設計前提は「DEEP 払い・ステーク割引なし」とし、BalanceManager に手数料用の DEEP を少量常備する。コストの設計値は taker 10 bps／回（往復 0.2%）とし、実装時に `poolTradeParams` の実値で確定する。ステーク割引は少額運用では出来高要件を安定して満たせないため前提にしない。PAPER の feeRate とレビューの物差し（往復 0.6% 控除）は検証ラダーの間は変更しない。設計書 `docs/REAL_TRADING_TRADECAP_DESIGN_20261025.md` の §2.3 と §11 #2 に反映した。

## 2026-11-10 TradeCap 設計書 §5.4（コスト計算）の詳細設計を確定

設計書 §5.4 を §5.4.1〜§5.4.5 に展開し、実装可能な粒度まで確定した。要点：手数料レートは `poolTradeParams` を起動時とエポック境界で読み取り、キャッシュは読み取ったエポック内のみ有効とする。DEEP フロートは金額でなく最大注文手数料の回数で定義する（目標 1,000 回分、200 回分で警告、50 回分で新規注文を停止。補充はオーナーの手動操作）。ガスは PAPER の固定値に代えて実績（各 tx の gasUsed を USDC 換算し直近 20 件の中央値。5 件未満は見積もり不能）を使う。見積もりは常時 taker レート（最悪側）で行い、見積もり不能時は入口をフェイルクローズ、出口（保有ポジションの決済）は最後に読めたパラメータで許可してフラグを記録する。しきい値類はいずれも Phase 1 で較正する初期値。あわせて §2.3 に SUI_USDC の注文制約（最小 1 SUI／ロット 0.1 SUI／tick 0.0001 USDC、Indexer 公式データで確認）を追記し、§5.3 の payWithDeep のコメントを決定済みに更新した。

## 2026-11-10 TradeCap Phase 1（testnet）の実行手順書を作成

設計書 §10 Phase 1 を実行するための手順書 `docs/REAL_TRADING_PHASE1_RUNBOOK_JA.md` を新規作成し、設計書 §10 から参照を張った。要点：資産入手は公式 docs の確認済み経路に限定する（testnet SUI は faucet、DEEP と DBUSDC は token request form が本命で testnet DEEP に faucet はない。DEEP_SUI プールでの swap は当てにしない）。受け入れ 1〜10 は §10 の文言そのままにチェックリスト化し、項目ごとに残す証跡（digest 等）を対応させた。副産物として較正データ（poolTradeParams 実値、tx ごとの gasUsed、手数料の実績と見積もりの差、注文種別の約定率・スリッページ比較、DEEP フロートの消費ペース）の採取を必須化し、§5.4 の初期値を実測で置き換えるまでを Phase 1 の仕事とした。

## 2026-11-10 SDK 調査：TradeCap 発行は 1 tx（§11 #5 決定）、deepbook-v3 は 2.8.0 に固定

`@mysten/deepbook-v3` のソースと npm の peer 範囲を 2026-11-10 に確認した。`mintTradeCap` は Transaction を受けて move call を追加し Cap のハンドルを返す tx ビルダーであり、同一 PTB 内で発行＋`transferObjects` まで組める。よって §11 #5 は「1 tx（同一 PTB で発行＋移転）」と決定し、設計書 §4.1・§11 #5 と Phase 1 手順書 §3 に反映した。

バージョン整合：deepbook-v3 の peer は `@mysten/sui` の版に連動する（2.8.0 は `^2.37.0`、2.8.2 以降は 2.38 以上、2.11.1 は `^2.39.1`）。本リポジトリの `@mysten/sui` 2.37.0 と互換な最新は 2.8.0 であり、設計が前提とする API（poolTradeParams、placeMarketOrder、cancelOrder、cancelAllOrders、checkManagerBalance、accountOpenOrders、createAndShareBalanceManager、mintTradeCap、`$extend(deepbook({ address, balanceManagers }))`）が 2.8.0 の公開型定義にすべて存在することを確認した。実装では `@mysten/deepbook-v3` を 2.8.0 に固定する（設計書 §5.5）。deepbook を上げる場合は `@mysten/sui` の更新と既存 gRPC 読み取り経路の回帰確認をセットで別途行う。

## 2026-11-10 VPS 本稼働の切替手順書を作成

設計書 §8-4 が求める切替手順書 `docs/VPS_PRODUCTION_CUTOVER_RUNBOOK_JA.md` を新規作成し、設計書 §8-4 から参照を張った。要点：切替の前提条件として、本番 START/STOP の Actions 入口（ssh ラッパー＋ワークフロー）が未実装であることを明記した（controller の prod-start／prod-stop は実装済みだが、現存する Actions 経路は prod-status と export-prod-snapshot の読み取りだけであり、当日にホストへの手打ちで代用しない）。当日の順序は setup 再実行（両 supervisor 静止時のみ可。PR #132／#140／#141／#146／#149 の controller 変更はここで入る）→ 配置確認 → cutoff release（prod-start のセッションゲートは全 cutoff タイマーの静止を要求する）→ prod-policy 配置 → prod-start → 開始後確認 → 変数有効化（SUIBA_PROD_MONITOR_ENABLED、SUIBA_PROD_REVIEW_ENABLED）と日次レビューの初回スモーク → WireGuard 閲覧確認 → Windows 停止、とした。日次レビューの初回スモークは、workflow の if 条件により変数が true でないと手動 dispatch（REVIEW-PROD-DAILY）でも skip されるため、変数を設定したうえで、その JST 日の初回定期投稿より先に dispatch する順序で書いた（重複ガードとの関係は PR #148 補足の趣旨どおり）。

## 2026-11-10 本番開始・停止の Actions 入口を新設（切替の前提部品）

controller は prod-start／prod-stop を実装済みだったが、Actions から呼べるのは prod-status と export-prod-snapshot の読み取り経路だけで、開始・停止の入口が無かった。検証系と同じ型で、固定ラッパー `docker/ssh-prod-start.sh`／`docker/ssh-prod-stop.sh`（送るのは固定リクエストのみ、応答は controller の固定 JSON だけを受理）と、確認文字列 START-PROD／STOP-PROD の2ジョブを持つ `.github/workflows/suiba-production-control.yml` を新設した。caller scope の裏取り：controller の受理集合に prod-start／prod-stop が含まれ、制限を受けるのは observe identity だけで、deploy identity はホスト配布物（setup-paper-check.sh のピン済み controller／sudo ラッパー／sudoers）のまま受理できるため、ホスト側の変更は不要。ゲート変数 SUIBA_PROD_CONTROL_ENABLED は未設定のままで、切替時に有効化するまで不発。

## 2026-11-10 マージ済みブランチは削除する（運用ルール）

オーナーの指示で、PR をマージしたらそのブランチを削除する運用に統一した（シロ・Codex 共通）。リポジトリ設定 `delete_branch_on_merge` を有効化し、既存のマージ済みブランチ118本も削除した（残りは main、open PR のブランチ、未マージの作業ブランチのみ）。AGENTS.md の「変更の進め方」にも明記した。

## 2026-11-10 §5.1 執行アダプタの詳細設計（非同期はサイクル内 await で吸収）

REAL 設計書 §5.1 を §5.4 と同じ粒度に詳細化した（§5.1.1〜§5.1.8）。要点：型（ExecutionIntent／ExecutionResult／CancelResult／AdapterOnchainState）を PAPER の既存型（Fill、QuoteResult、CandidateAudit、commitFill の verification 一式）と対応づけて確定した。非同期の吸収は「execute() をサイクル内で await し、終端または UNKNOWN の確定までそのサイクルで完結させる」案を採用した（MarketScheduler が単一サイクルを await する現行構造では、サイクル内で待っても重なり・二重実行が起きず、監査の「1 サイクル＝1 候補」の帰属も保てるため）。finality 待ちには上限を設けて UNKNOWN で返し、未解決の UNKNOWN が残る間は新規送信をゲートで止める（§6.4／§7.3 の執行点）。想定内の執行結果は例外にせず ExecutionResult で返し、例外は帳簿の整合性異常に限って既存の tick 例外分類に載せる（新しい停止条件は作らない）。照合の説明できない差分による HALTED は REAL 側のラッチとし runtime.error とは別軸に置く。cancelAllOpenOrders は緊急停止のラッチ地点と Worker 終了時に呼び、PARTIAL／FAILED と残件 ID で部分失敗を表す。

## 2026-11-10 エピソード内訳と Indexer 遅延の観測を追加（記録・表示のみ）

24h 検証ラン attempt 2 の失敗で「どの上流 API が・何分落ちたか」が公開 export から特定できなかった反省から、観測を2件追加した。売買・安全の意味論（エピソードの数え方、制限値、停止条件、フォールバック、429/500）は一切変えていない。(1) エピソード内訳：閉じたエピソードのサマリ（API×理由の件数、最初／最後の失敗時刻、継続時間、結末 RECOVERED／EXHAUSTED／STOPPED／INTERRUPTED）はもともと終了イベントに付いて DB に残っていたが、公開 export の秘匿で落ちていた。export の許可リストに終了系コード（PAPER_NETWORK_RECOVERED、PROCESS_RESTART_STOPPED、PAPER_NETWORK_PAUSED）を加え、episode を厳密な形のまま保持するようにした。診断側は tally キーの正規表現が API 表示名の空白（"DeepBook Indexer" 等）を弾いていたのを直し、直近に閉じたエピソードを専用クエリで引いて Latest episode 行に出す（従来の直近10イベント走査だけでは終了イベントが窓外に押し出されうる）。(2) Indexer 遅延：DeepBook の全読み取りが通る checkedRead で所要時間を測り、サイクル末に回収して operation_state に有界な集計（読み取り種別ごとの総件数・最大・直近60件）として永続化する。再起動をまたいで残り、診断の Indexer latency 行と worker の timing 表示に出す。取得そのものの挙動は変えていない。

## 2026-11-10 Indexer 遅延の集計から TTL キャッシュヒットを分離

上記の Indexer 遅延計測は TTL キャッシュに当たった読み取りも約0ms として分布に混ぜており、ネットワーク遅延が読めなかった（同エントリで明記した留意点）。キャッシュヒットを種別ごとの別カウンタ `cached` にだけ数え、総件数・最大・直近60件リング（＝中央値）には入れない形に分離した。ヒットの判定は、キャッシュを返す実在の分岐に置いた観測コールバック（ApiPolicy.onCacheHit）を ApiAccess 自身が呼ぶ方式とし、所要時間の閾値推測は使わない。キャッシュの挙動（TTL・ヒット判定・返却値）と取得のリトライ・切替・タイムアウトは現行どおり。分離前から永続化された集計（cached を持たないバケット）は 0 として読み替え、診断の Indexer latency 行には cached=N を追加する（controller は3要素・4要素の両形を受理し、旧ホストとの混在に耐える）。setup-paper-check.sh の controller ピンは同コミットで更新済み。

## 2026-11-10 paper モニターの scheduler 落ちに watchdog で冗長化

GitHub scheduler の best-effort な間引きで paper モニターが 2026-11-09 に約5時間、2026-11-10 に約4時間45分発火せず、その間は異常検出が遅れた。対策はエージェントの定期チェックに寄せず GitHub 側で閉じる方針とし、軽量な watchdog ワークフロー（suiba-paper-monitor-watchdog.yml）を追加した。本体と分数をずらした毎時 9,29,49 分に起動し、Actions API で本体の直近実行を見て、scheduled・dispatch のどちらの時計も45分以上途絶え、実行中・キュー中もない場合に限り、本体を workflow_dispatch（CHECK-PAPER-MONITOR）で最大1回だけ再発火させる。45分の根拠：本体の名目間隔は約10分であり、通常の scheduler 遅延では45分の空白は生じない一方、観測された数時間の間引きは確実に拾える（検出遅延は最大で45分＋watchdog 間隔20分）。ゲートは本体と同じ repo 変数 SUIBA_PAPER_MONITOR_ENABLED に連動し、権限は GITHUB_TOKEN の actions: write のみで、ホスト資格情報も Issue 権限も持たない。失敗時は無言で何もしない。本番モニター（suiba-production-monitor.yml）はゲート未設定で未稼働のため今回は触らず、本稼働の切替時に同方式を検討する。

## 2026-11-10 本番モニター watchdog の先行実装

PR #168 で本番切替時に検討するとしていた watchdog を先行実装した。リポジトリ変数 SUIBA_PROD_MONITOR_ENABLED が未設定の間は復旧処理は不発となる。本番切替時に本体のゲートを有効にすると、watchdog も自動的に有効になる。

## 2026-11-10 transitive の zod 3.25.76 は上流待ちとし、強制解決しない

依存監査の残件として transitive の zod 3.25.76（advisory：制約付きコレクションの過大入力でメモリ枯渇、本体の zod 4.6.7 は対象外）を調査した。居場所は @cetusprotocol/aggregator-sdk 経由の @pythnetwork/hermes-client@3.1.0（最新安定版）で、zod ^3.23.8 を直接要求し、@zodios/core@10.9.6 の peer も zod ^3.x（次期 beta でも同じ）。宣言レンジ内の更新や dedupe では動かない（実測：pnpm dedupe で差分0件）。なお `^3.25.0 || ^4.0.0` の宣言は zod-validation-error@4.0.2 のもので、既に本体の 4.6.7 に解決済み。tools/ の npm lockfile には zod 3.25.76 はない（実測）。判断：pnpm overrides 等による強制解決はしない。使用箇所が Pyth 応答のパース内部で advisory の攻撃面が現実にはほぼないことと、zod 3 前提のライブラリへ 4 を強制すると価格フィード経路の互換性検証の負担が割に合わないため。再確認の契機は、hermes-client か zodios が zod 4 を許容するリリースを出したときで、その場合は通常の依存更新で拾う。

## 2026-11-10 24h 卒業後に72時間検証は追加しない

外部提案として「24h の後に改善を入れて72時間検証をしてはどうか」を検討したが、採用しない。理由：(1) 残る未検証の面は prod-start、本番モニター、日次レビューなど本番専用の経路で、PAPER の長時間ランでは検証できない。それらを試せる本稼働の集中観察週間（7日間）が72時間検証の上位互換になる。(2) これまでの失敗は時間比例の劣化ではなく事象（夜間の薄い板、上流ネットワークのバースト）で、薄い板は24hで既にカバーしており、時間を伸ばしても新しい種類の証拠は増えにくい。(3) 本稼働の中身は PAPER で、停止しても金銭被害はない。順序は従来どおり「24h 卒業 → 本稼働切替 → 集中観察週間」とする。なお、売買・安全の意味論を変える改善を入れた場合は、その時点で24hをやり直すのが既存の規律であり、長時間化で代替しない。

## 2026-11-11 AI の取引判断は影運用（シャドーモード）から始める

オーナーが「AIエージェントに取引を任せたい」と表明し、進め方として影運用を選んだ。AI にいきなり売買の権限を渡さず、AI の売買判断を記録だけして（取引には一切関与しない）、ルールベース戦略の判断と同一条件で並べ、既存レビュー（docker/run-review.py）の物差し（往復コスト 0.6% 控除後のフォワードリターン）で答え合わせする。証拠が出てから権限を広げるかどうかを決める。

理由：(1) 権限の前に「AI がルールより上手いか」を数字で測れる。(2) ルールは WAIT が大半で判断サンプルが貯まりにくいが、影の AI は「買う／見送る＋根拠」を残すため評価データが蓄積する。(3) 記録専用なので、AI の失敗・遅延が Bot の安全系に影響しない。対案として挙げた「執行だけ任せる（現行の TradeCap 設計のまま）」「判断も AI に任せる（再現性がなく検証ラダーで測れない）」は今回は採らなかった。

設計書 `docs/AI_SHADOW_MODE_DESIGN_JA.md` を作成した。要点：入力はそのサイクルでルールが見た情報の凍結スナップショットに限り、呼び出しは毎ティックではなくトリガー制（ルール BUY 近傍・レジーム変化＋最大間隔）とし、保存は専用テーブル shadow_decisions、採点は run-review への影セクション追加で既存バリアントと並記する。卒業条件は事前登録式とし、閾値の確定値は未決事項に集約した。実装は本番切替と安定化の後（本番データで影を回す方が価値が高い）。
## 2026-11-11 本番開始トークン不整合と compose バリアントによる修正

2026-11-11 の本番切替で prod-start が failed_requires_review で停止した。原因は、本番コントローラ（ProductionController）の preflight がコンテナ env `PAPER_CHECK_MODE == 'sui-prod'` を要求する一方、配置される compose（`docker/compose.vps.yaml`）が検証用トークン `sui-30m` を固定し、配置経路のどこにもトークンを本番用へ切り替える仕組みが無かったこと。設計書（VPS_PRODUCTION_JA §6）の「配置時に compose を選ぶ」が未実装で、切替手順書の当日手順にも入っていなかったため、本番開始経路の初回実行で初めて表面化した。ワーカーは起動しておらず、台帳（seq 18 / prepared_stopped）と検証の記録に影響はない。修正は設計書 `docs/PROD_START_TOKEN_FIX_DESIGN_JA.md` の方針 A とした：`docker/compose.vps-prod.yaml`（検証用との差分はトークン行と説明コメントのみ）を新設し、broker の setup スクリプト（`setup-ci-approval.sh`）にバリアント引数（無指定／`paper`＝検証用、`prod`＝本番用）を追加して、policy compose の選択を setup で行う。両 compose の sha256 ピンはスクリプト内に持ち、`deploy/broker/test_setup_ci_approval.py` が「ピンの一致」と「差分はコメントとトークンだけ」を固定する。broker.py・コントローラ・ワーカーは無変更。副次的に見つけた「preflight 前で失敗した本番レコードを prod-stop で閉じられない」問題は、同じ設計書の R1 として別 PR で直す。

## 2026-11-11 prod-stop クローズ条件の対象 fault に LATCHED_FAILURE を追加

上記の R1（preflight 前で失敗した本番レコードを prod-stop で閉じる条件拡張）をホストへ配り、実際に wedge したレコードへ STOP-PROD を試行したが、クローズは再度拒否された。理由：対象レコードは失敗したランナー自身の stop で `PREFLIGHT_INCOMPLETE` を fault された後、旧コントローラでの最初の prod-stop 試行で stop_checks をもう一度通っており、その時点で既にラッチ済みの fault があったため、派生コード `LATCHED_FAILURE` が追加で fault されていた。R1 の条件は全 fault が `PREFLIGHT_INCOMPLETE` であることを要求していたため、このレコードは対象外になった（fail-closed が設計どおりに働き、条件集合が実地の形を捉えきれていなかった）。`LATCHED_FAILURE` は「stop の試行が既にラッチ済みの失敗を観測した」ことを示す派生コードで、それ自体は独立した失敗の情報を持たない。したがってクローズ条件の対象 fault を {`PREFLIGHT_INCOMPLETE`, `LATCHED_FAILURE`} に広げる。他の条件（admitted=False、failure.json の stage が preflight、未完了の mutation なし、コンテナがこのセッションで起動していない、failed.json が当該レコードを指す）は不変で、未知の fault コードが混ざれば従来どおり拒否する。

## 2026-11-11 prod-stop のクローズ対象を admission 後失敗にも広げる（R3）

本番切替は完了し（seq 19）、初回本番ラン（2026-11-11 07:38 JST 開始）は同日午前に上流の HTTP 500 でハードストップした（429／500 の即時停止は既定どおりで、取引・台帳への影響はない）。レコードは admitted=True の failed_requires_review となり、復帰のための STOP-PROD は PROD_STOP_FAILED で閉じられなかった。原因は、通常の stop 経路が既に終了したコントローラを持つレコードを閉じる試行そのもので fault を積むこと：terminate 不能で `CONTROLLER_EXIT_UNCONFIRMED`、既存 fault への `LATCHED_FAILURE` 追加が起き、cleanup の完了条件（errors なし・fault なし）に到達できない。R1（preflight 前失敗）と同じ wedge が admission 後の層にもあった。修正は設計書 `docs/PROD_START_TOKEN_FIX_DESIGN_JA.md` の R3 とした：prod-stop の failed_requires_review 分岐に admission 後失敗の閉じ条件を追加し、failure.json の id 一致、コンテナの clean な終了（未稼働・ExitCode 0・非 OOM・StartedAt がこのセッションの開始以降）、stop_checks と同じ DB 検証の通過、未完了 mutation なし、コントローラの終了、fault が stop 機構由来の4コード {`LATCHED_FAILURE`, `CONTROLLER_EXIT_UNCONFIRMED`, `STOP_LOCK_OR_STATE_UNKNOWN`, `CLEANUP_LOCK_OR_STATE_UNKNOWN`} のみ、failed.json が当該レコードを指すこと、を全部満たす場合に限り R1 と同じ確定処理で閉じる（failure.json は証拠として残す）。1つでも欠ければ従来どおり手動切り分けに残る。安全停止条件・取引ロジック・検証系（PAPER）の挙動は不変。
