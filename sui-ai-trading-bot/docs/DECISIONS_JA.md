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
