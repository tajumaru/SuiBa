# VPS 本稼働設計 — 起動・停止経路と監視

これは設計書であり、未実装である。対象は2点に限る：(1) さくら VPS
上で PAPER 本番を回し続けるための起動・停止経路、(3) 止まったら
気づける監視。状態の引っ越しと更新手順は骨子のみ、閲覧経路などは
未決定事項として §7 に置く。前提の事実は
`docs/VPS_RECOVERY_AUTOMATION_JA.md`（運用メモ）と本書 §1 に挙げた
コード位置で確認した。方針転換（2026-11-06：今後は自動売買を目的と
する）を受けた最初の実装対象として書く。

## 0. 推し

**案A'：controller に本番 op（prod-start／prod-stop）を足し、
worker のセッションを「有効期限なし・明示停止まで」に一般化する。**
broker は変更しない。

理由：守るべき安全不変条件（latch、backup 先行、readiness 通過後の
arm・開始、停止の単独権威）は controller の `run()` にすでに集約
されている。本番経路を別系統で作ると同じ不変条件を二重に実装・
審査することになる。対案の案B（本番用 policy/compose を分けた
broker 配置＋素の docker start）は、restart 強制や create-only と
いった broker の凍結モデルそのものに手を入れる必要があり、特権面
の拡大が大きい（§3）。

## 1. 現状の制約（コードで確認した事実）

### 1.1 broker は「作って止める」までしかしない

- 配置は `docker compose create` のみで終わり、台帳は
  `prepared_stopped` になる（broker.py:788-796）。起動は broker の
  仕事ではない（同コメント「Runtime health acceptance is a
  separately approved task」が本書の対象）。
- 配置時に policy の compose から凍結モデルを作り、
  `restart = 'no'` を強制する（broker.py:720）。元の
  `docker/compose.vps.yaml` は `restart: unless-stopped` だが
  （compose.vps.yaml:32）、配置された実物は常に `no` で、controller
  の admission も `RestartPolicy.Name == 'no'` を要求する。
- 配置は paper-check セッションのゲートを通る
  （broker.py:571 `check_paper_session`）：fault ラッチが無く、
  マーカーが `completed` か未存在なら素通り。`in_progress` の間は
  controller の `approve-deploy` が発行する許可証がある場合だけ。
- `validate_model`（broker.py:407）は compose の固定 env 部分集合
  （MODE=PAPER 等）を検証し、それ以外の env キーは許容する。
  TRADING_PAIR／PAPER_CHECK_MODE／MARKET_DATA_PROVIDER は検証
  対象外で、compose 側 `environment:` の値がそのまま実物になる
  （PR #67/#74 の切り替えがこの性質で成立している）。

### 1.2 paper-check は必ず止まる設計

- controller の `run()`（controller.py:961）は開始時に policy が
  `{'enabled': True, 'mode': 'sui-30m'}` と完全一致することを要求
  する（controller.py:973）。セッションゲート（前任ランの
  completed／retry 許可証）→ preflight（storage→ledger→
  container→admission）→ cutoff タイマー起動 → backup →
  unlatch → worker 起動 → readiness → arm → 取引開始 → 監視 →
  正常停止→ post-stop が完了を発行、が一本の流れ。
- 終了は構造的に保証される：cutoff タイマー（30m／6h／24h、
  `suiba-paper-check-cutoff*.timer`）、service の
  `RuntimeMaxSec=25h`、監視ループ自体の終了条件。開始は全 cutoff
  タイマーと cutoff service が静止していることが条件
  （controller.py:279 `quiescent`）。
- watchdog 的な外向き通知はない。journal には固定文字列のみ。

### 1.3 worker のゲート前提（本番化の核心）

- **セッションのリース前提**：`PaperCheckSession`
  （paper-check-session.ts）はコンストラクタで env トークンが
  `'sui-30m'` 以外なら起動時エラーにする（:13-17）。有効な間は
  SUI_USDC のみ許可し（:38-40）、注文は arm 済みかつ期限内に限る
  （:41-47）。arm は単発で、`expiresAt` は issuedAt の30分以内
  しか受けない（:59、:62）。期限切れ・時計の巻き戻しは
  `expired()` が閉じ、engine の停止条件に入っている
  （worker-factories.ts:58）。**つまり現行 worker は「期限なしで
  回り続ける」状態を持たない。** 本番化ではこの一般化が必須。
- **maintenance latch**：`DeploymentGate`（deployment-safety.ts:
  73-99）は `<db>.maintenance` が見えたらそのプロセスの寿命の間
  ブロックし続ける。解除は worker 停止中にオフライン helper で
  ファイルを消す操作でのみ有効（controller の `maintenance(False)`
  が一回限りの helper コンテナで実行）。latch の実体は
  docker/vps-data.mjs:27 が作る `deployment\n` の通常ファイル。
- **boot しても取引は自動再開しない**（index.ts:119-120 の
  `monitor.boot()`）。開始は `POST /api/control {"command":
  "start"}` で、paper-check 有効時は `ordersAllowed`（= arm 済み）
  が必須（http-routes.ts:546）。gate がブロックしている間は
  stop／emergency 以外の POST が 409 `DEPLOYMENT_MAINTENANCE`
  になる（http-routes.ts:336-345）。
- **readiness**：`GET /api/deployment` の `startReady` は
  connectivity／apiAccess／emergencyClear／runtimeClear／
  suiHealthy／suiFresh／ledger の全真（http-routes.ts:168-181）。
  arm は取引が止まっている間だけ受け付ける（http-routes.ts:
  345-361）。controller の `wait_ready`（controller.py:749）は
  60秒上限でこれとコンテナ health を見る。

### 1.4 監視の現状は pull のみ

- 実行中ランの健全性は controller 自身の監視ループが見ているが、
  結果はホスト内の記録（progress.json 等）までで、外向き通知は
  ない。人が `CHECK-PAPER-STATUS` を叩くか watch ワークフロー
  （約40分、30m ラン用）を回さない限り、異常は見えない。
- `diagnose` は終了したラン専用で、実行中は使えない
  （controller.py:305-321 が status completed／
  failed_requires_review と controller の終了を要求）。
- 本番では「誰も見ていない時間」が通常になる。現状の pull 型の
  ままでは、止まってから気づくまでの時間が無制限に伸びる。

## 2. 守る安全不変条件（両案共通）

1. **latch は worker 停止中は常に存在する。** 配置・検証・停止の
   全経路がこれを前提にする（diagnose も latch の uid／nlink まで
   検証する）。
2. **backup 先行。** worker を起動する変更（unlatch・start・
   arm・取引開始）は、その前に DB の backup と検証（helper
   verify＋SUI 選択確認）を通す。
3. **取引開始は readiness 通過後にだけ。** arm／start 等の変更系
   POST は再試行しない（既存 run() の規律）。
4. **停止の権威は単独に保つ。** docker の restart ポリシーや
   systemd の Restart に復旧を委ねない。止めるのは controller の
   stop 一式（と非常時の broker emergency 相当）だけ。
5. **特権面は固定 op の追加のみ。** 引数でコマンド・パス・時間を
   受け取らない（既存 wrapper／sudoers の原則）。
6. **検証ラン（paper-check）の意味論は変えない。** 6h／24h の
   完走が本稼働の前提証拠であり、その最中に検証系を組み替えない。

## 3. 起動経路の案

### 案A'（推し）：controller に本番 op、worker セッションを一般化

**worker（apps/worker/src/paper-check-session.ts ほか）**

- `PaperCheckSession` に本番モードを足す。新しい env トークン
  （名称は実装時に確定）でのみ有効になり、意味論は次のとおり：
  - ペア制限は現行と同じ SUI_USDC のみ。
  - arm は「有効期限なし」の形を受け付ける（例：`expiresAt` を
    省いた arm を本番モードでのみ受理）。受理後は明示停止まで
    `expired()` が時間では閉じない。ただし時計の巻き戻し・
    非有限値で閉じる fail-closed は本番モードでも維持する。
  - 検証モード（sui-30m）の arm 検証は一切変えない。30分上限・
    単発・cutoff 完全一致はそのまま。
- `http-routes.ts` の start ゲート（ordersAllowed 必須）は不変。
  本番でも「controller が arm した worker だけが取引を始める」
  という形が保たれる。`/api/deployment` の paperCheck 表示は
  本番モードでも同じ形（enabled／armed／expired／expires=null）を
  返す。

**controller（deploy/paper-check/controller.py）**

- op を3つ足す：`prod-start`／`prod-stop`／`prod-status`
  （request の許可集合に追加。引数は持たない）。
- 有効化は検証と分ける：prod 用の policy ファイル（例
  `/etc/suiba-paper-check/prod-policy.json`、`{'enabled': true}`）
  を新設し、検証の policy（sui-30m 固定）には触らない。本番の
  有効／無効と検証の有効／無効を独立に切り替えられるようにする。
- 状態は検証と分ける：本番レコードは別ファイル（例
  `STATE/prod.json`：id／started／sha／stage）に持ち、検証の
  `run.json`（`current()`）と混ぜない。broker の
  `paper-check.json` マーカーは配置ゲート専用なので本番では
  触らない。
- `prod-start` の手順は run() の部品を再利用する：broker lock →
  セッションゲート（検証ランが開いていないこと、本番が未開始
  であること、全 cutoff タイマーが静止していること）→
  preflight 相当（storage／ledger＝prepared_stopped／container。
  env の期待値だけ本番用：PAPER_CHECK_MODE＝本番トークン、対象
  ペア・provider の扱いは現行どおり）→ backup → unlatch →
  worker-start → wait_ready → deployment-state（本番セッション
  有効・未取引・未 arm を確認）→ pair／market-summary／
  market-freshness → arm（無期限形）→ paper-start → 監視へ。
  run() との差分は「cutoff タイマーを武装しない」「監視に終了
  時刻がない」「正常終了は prod-stop のみ」の3点だけにする。
- 監視中の異常時は検証ランと同じ安全側に倒す：取引停止 →
  worker 停止 → latch 復帰 → 失敗段階を prod レコードに記録して
  終了。自動再起動・自動での取引再開はしない（§5.2）。
- `prod-stop` は stop 一式（controller.py:913 `stop_worker` と
  cleanup 相当）を再利用し、完了条件（worker 停止・exit 0・
  latch 復帰・DB verify・SUI 選択）も検証ランと同一にする。
  prod-status は §5 の watchdog が読む読み取り専用 op。

**systemd／wrapper／setup**

- 本番の監視役は新 service（例 `suiba-prod.service`：Type=exec、
  ExecStart＝controller の prod-run 相当、ExecStopPost＝
  prod-stop 確認、Restart=no、RuntimeMaxSec なし、硬化は
  suiba-paper-check.service と同等）。開始は start op が
  suiba-paper-check.service を起動する既存形と同じく、
  prod-start op が service を起動する。
- setup-paper-check.sh の対象に新 unit を足し、controller の
  ピン更新と合わせて配る（ピン規律は従来どおり）。

**broker／compose**

- broker は変更なし。配置は従来どおり prepared_stopped で止まり、
  本番の開始は controller の仕事になる。配置ゲートは検証
  セッションのマーカー不在（または completed）で通るため、
  本番入替は prod-stop → 配置 → prod-start の順で既存経路に
  乗る（§6）。
- compose は本番用が必要になる：PAPER_CHECK_MODE を本番トークン
  にした版。policy の compose はピン留めされた1枚だけなので、
  検証用／本番用のどちらを置くかが配置時の選択になる
  （プロバイダ切替 PR #74 と同じ型）。検証に戻すときは compose
  を戻して再配置する。本番稼働中に検証ランは回せない、という
  運用制約として明記する。

**変更範囲の見積り**

| 対象 | 変更 | 規模 |
|---|---|---|
| worker | セッション一般化＋単体テスト（検証モード不変をテストで固定） | 中 |
| controller | prod op 3つ＋prod レコード＋preflight の env 期待値分岐＋テスト | 大 |
| systemd／setup | 新 service 1枚＋setup 対象とピン | 小 |
| broker | なし | — |
| compose | 本番用の値を置く（配置時選択） | 小 |

### 案B：本番用 policy/compose を分けた broker 配置＋素の docker start

- broker に「本番配置」を足す：policy を検証用／本番用に分け、
  本番配置では凍結モデルの restart を `unless-stopped` に変え、
  create 後に start まで行う（または開始 op を broker に足す）。
- 問題1：**開始役が別に要る。** worker は boot しても取引を
  自動再開しない（§1.3）。docker start のあと誰かが readiness を
  見て start を送る必要があり、結局 controller 相当の開始役を
  新設することになる。restart ポリシーによる自動復帰も「プロセス
  の再起動」でしかなく、取引は止まったまま。
- 問題2：**不変条件の置き場が割れる。** broker の backup は配置時
  の DB backup であり、§2-2 の「開始前の backup」とは別物。
  unlatch と開始前 backup を broker 側に寄せると、latch を触る
  特権主体が broker と controller の2つになる。
- 問題3：broker は特権コードで、自己更新経路を持たない原則
  （AGENTS.md）の下、変更の審査単位が最も重い。restart 強制の
  緩和は配置全体の安全モデル（作って止める）に触る。
- 見積り：broker 中〜大（特権）＋policy／compose 二重化＋開始役の
  新設。得られるものは案A' と同じで、推さない。

### 比較

| 観点 | 案A'（推し） | 案B |
|---|---|---|
| 不変条件の実装箇所 | controller に一元化（既存） | broker と開始役に分散 |
| 特権面の増分 | controller の固定 op 3つ | broker の配置意味論の変更 |
| worker 変更 | セッション一般化（必須） | セッション無効化で足りるが開始役は別途 |
| 検証ランへの影響 | policy／レコード分離でなし | policy 二重化の管理が常駐 |
| 配置ゲート | 既存のまま | 本番配置の分岐が増える |

## 4. 状態の引っ越し（骨子）

詳細手順書は実装フェーズで別途作る。骨子のみ：

- **正は Windows の DB 一式**（bot.sqlite 本体と pairs／WAL_USDC
  の関連 DB。棚卸しは paper-database-inventory.ts が正）。VPS の
  DATA ボリュームにある DB は検証ランで進んだ別系統であり、
  正にはしない（検証の backup tar が世代として残る）。
- 順序：(1) Windows 側で Bot を停止し lifecycle が clean で
  あることを確認 → (2) DB 一式の整合スナップショットを取得 →
  (3) 暗号化して VPS の root のみ読める場所へ転送（平文 staging
  の扱いは `docs/PAPER_DEPLOYMENT_SAFETY_V1_JA.md` の注意と同じ）
  → (4) VPS 側の現行 DATA を helper backup で退避 → (5) 移行 DB
  を配置（uid 1000、latch ありの状態）→ (6) helper verify
  （lifecycle clean・DB 整合・選択ペア）→ (7) prod-start で
  readiness を通して開始。
- **Windows へ戻す条件**：verify 不合格／readiness が通らない／
  開始後に runtime error が解消しない／台帳検証（ledgerOk）が
  立たない。戻しは VPS 側を未開始のまま（または prod-stop で）
  latch を維持し、Windows 側を再開する。
- **分岐点の明示**：VPS 側で約定が発生したあとは状態が分岐する
  ため、原則として巻き戻さない。その判断点は開始前に置く。
- 移行後は Windows を即時復帰可能な待機に置き、保持期間は
  未決定事項（§7）ではなく切替手順書で定める。

## 5. 監視の設計

### 5.1 検出：host 内 watchdog

- 形：systemd timer（間隔は実装時に確定、例5分）で controller の
  読み取り専用チェックを叩く。本番稼働中は diagnose が使えない
  ため、`prod-status` op が「prod レコード＋コンテナ状態＋
  /api/deployment＋lifecycle＋progress」を形の検証つきで返す。
  prod 監視ループが書く progress の鮮度を主信号とする
  （検証ランの progress.json と同じ流儀：progress が閾値より
  古い＝監視役の死）。
- watchdog は状態を持たず、異常の有無とコード形の事実だけを
  root 所有の status ファイルと journal の固定文字列に書く。
- 検出できる異常：
  - コンテナ停止／OOMKilled／RestartCount の変化／
    health ≠ healthy（docker inspect）
  - worker API 不達、running=false（取引が止まっている）、
    runtime error の発生
  - 市場の鮮度喪失（lastSuccessAt の停滞）
  - progress の停滞（監視ループの死）、prod service の
    inactive／failed
  - 状態の不整合：worker 停止中に latch が無い／検証系の cutoff
    タイマーが本番中に armed になっている（混線）
  - ホスト資源：MemAvailable とディスク残量（監視ループと同じ
    閾値を流用）、backup の世代と鮮度

### 5.2 自動復旧の線引き

- **初期値は「自動復旧なし」。** watchdog は検出と記録（と §5.3
  の通知）に徹する。根拠：paper-check の全設計が「失敗は証拠を
  残して止まり、再開は承認経由」であり、一時的な通信失敗からの
  自動復帰は worker 内蔵の PAPER_RECOVERY が担う範囲にすでに
  ある。それを超える自動再開（worker 再起動・取引再開）は、
  証拠のない再開になるため入れない。
- 分けて議論できる候補：prod service（監視役プロセス）だけの
  systemd `Restart=on-failure`。取引は開始しないため §2-4 には
  触れないが、初期実装では入れず、未決定事項（§7-4）とする。
- 人が要る範囲：worker の再起動と取引再開（prod-start の承認
  タップ）、latch がらみの不整合、DB 異常、台帳不一致、配置の
  失敗。いずれも既存の流儀（証拠→承認→実行）に従う。

### 5.3 通知チャネル

| 候補 | 即時性 | ホスト側の追加 | 備考 |
|---|---|---|---|
| (a) host から GitHub Issue を直接作成 | 高 | GitHub 認証情報をホストに置く | 現設計（ホストに外部認証情報を持たせない）と衝突 |
| (b) 定期 Actions チェック（推し） | チェック間隔ぶん（例30分） | なし（prod-status の読み取りのみ） | 既存の SSH 読み取り＋Environment＋変数ゲートで完結 |
| (c) webhook（プッシュ通知サービス等） | 最高 | 送信先＝実質的な認証情報をホストに置く | 送信内容をコード形のみに絞っても秘密管理が増える |

- 推しは (b)：schedule トリガーのワークフローが既存の
  `docker/ssh-paper-status.sh` の経路で prod-status を取得し、
  異常時に GitHub Issue を作成する（重複は open な同題 Issue で
  抑制）。Issue とワークフロー失敗は GitHub のモバイル通知に
  載る。新規の認証情報をホストに置かないことが決め手。
- これにより現状は「叩くまで分からない」から「異常は最大で
  チェック間隔だけ遅れて自動で上がってくる」に変わる。即時性が
  必要になったら (c) を後から足す（watchdog の status ファイル
  が送信内容の源泉になるため、追加は局所的）。

## 6. 更新手順（骨子）

- 本番入替は **prod-stop → 配置 → prod-start**。配置は従来どおり
  prepared_stopped で止まる。broker ゲートが見ているのは検証
  セッションのマーカーだけなので、「本番が停止していること」は
  ゲートではなく手順の前提として置き、配置ワークフローの前に
  prod-status で閉じていることを確認する（broker の配置手順
  自体もコンテナを止めるため、稼働中の配置は強制停止になる。
  それを通常手順にしないための区別）。
- prod-stop の完了条件を満たさなければ配置へ進まない。
- 新版の readiness が通らなければ prod-start を中止する。旧版へ
  の戻しは、配置がコンテナを作り替えているため再配置＋
  （必要なら配置時 backup からの DB 復元）で、判断は §4 の戻し
  条件に準じる。
- 証跡：prod レコードに sha と開始・停止時刻を残し、
  `/opt/suiba/last-deploy.json`（配置結果）と対で追えるように
  する。

## 7. 未決定事項（ユーザーが決める点）

1. **状態**：**決定済み（2026-11-06）：引き継ぎなし、VPS で
   新規スタート**。移行手順（§5）は不要になり、切替は「VPS で
   本番開始→Windows 側を止める」の順で足りる。Windows 側の
   記録はそのまま Windows に残る。
2. **閲覧経路**：**決定済み（2026-11-06）：WireGuard（直）**。
   VPS をサーバ、スマホをピアとし、ダッシュボードは VPN 内
   でのみ届くようにする。Tailscale（管理サービス型）は採らず、
   鍵と設定は自前管理。VPS 側は WireGuard の UDP ポートを
   1つだけ開ける（未認証プローブには無応答）。現行 compose は
   127.0.0.1:3100 のみで、VPS にはダッシュボード配信自体が
   ない（worker のみ）点は実装側で補う。
3. **通知チャネル**：**決定済み（2026-11-06）：定期 Actions
   チェック＋GitHub Issue**。ホストに通知用の認証情報は置か
   ない。即時性が要るようになったら webhook を追加検討する。
4. **自動復旧の許可範囲**：**決定済み（2026-11-06）：検出＋
   通知のみ**。再起動はオーナーの操作から行う。安全停止の原因を
   自動再起動で隠さないため。一時的な通信断の回復は worker
   内蔵の PAPER_RECOVERY が引き続き担当する。
5. **対象ペア**：**決定済み（2026-11-06）：当面 SUI_USDC
   のみ**。検証の証拠が揃っているのは SUI だけであり、本稼働が
   安定してから WAL_USDC の追加を検討する。
6. **本番と検証の優先**：本番稼働中は検証ランを回さない
   （compose の置き換えを伴うため §3）でよいか。

## 8. 段階計画

1. **検証の完走**：6h ラン完走 → 24h ラン完走（現行系のまま。
   本稼働の前提証拠）。
2. **設計レビュー**：本書を確定し、§7 に決着をつける。
3. **実装**（順序固定、各段は個別 PR）：
   (i) worker セッション一般化＋テスト →
   (ii) controller prod op＋prod レコード＋テスト →
   (iii) systemd／wrapper／setup（新 service とピン）→
   (iv) watchdog timer＋prod-status →
   (v) 定期 Actions チェック＋Issue 通知。
   各段で検証系（paper-check）の意味論が変わっていないことを
   既存テストと CI で確認する。
4. **切替**：§4 の骨子に沿った手順書を作成 → 状態移行 →
   prod-start。初回は watch を付けたまま監視し、Windows は
   即時復帰可能な待機に置く。
