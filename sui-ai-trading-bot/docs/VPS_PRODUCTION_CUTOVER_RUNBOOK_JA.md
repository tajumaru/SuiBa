# VPS 本稼働 切替手順書

本書は、設計書 `docs/VPS_PRODUCTION_JA.md` の §8-4 が求める切替手順書
である。設計判断そのものは設計書側にあり（§7 の決定済み事項 1〜6）、
本書は「切替当日に、何を、どの順で、どう確認するか」だけを扱う。

- **前提**：§8-1 の検証の完走（24h 検証ランの卒業）が済んでいること。
  未達のまま切替に入らない。
- **完了の定義**：prod-start が受理され、本書 §2 の開始後確認が全て
  通り、監視（本番モニター＋日次レビュー）が有効化され、Windows 側を
  停止した時点。
- **状態は引き継ぎなし・VPS 新規スタート**（§7-1 で決定済み）。
  Windows の DB は移行しない。順序は「VPS で本番開始 → Windows 側を
  止める」で、Windows 側の記録はそのまま Windows に残る。
- **本番稼働中は検証ランを回さない**（§7-6）。本番と検証は同じ
  コンテナ・DATA ボリュームを使うため、検証は本番開始前に卒業して
  おくことが前提になる。

---

## 0. 切替前に作るもの

### 0.1 本番 START/STOP の Actions 入口（未実装・切替の前提条件）

- controller は固定 op `prod-start`／`prod-stop` を実装済みで、配置
  identity の request 許可集合にも入っている。しかし **GitHub Actions
  から呼ぶ経路（ssh ラッパー＋ワークフロー）がまだ無い**。現存する
  のは読み取り経路だけである：
  - prod-status：`suiba-production-monitor.yml` が
    `docker/ssh-prod-status.sh` 経由で呼ぶ（observe identity）。
  - export-prod-snapshot：`suiba-prod-review.yml` が
    `docker/ssh-prod-export.sh` 経由で呼ぶ（observe identity）。
- observe identity の caller scope は status／prod-status／
  export-prod-snapshot のみであり、開始・停止は配置 identity 側の
  経路にする。
- 切替当日までに、検証系ワークフローと同じ型（固定の確認文字列、
  ゲート変数、sakura-vps 環境の承認、ssh ラッパー）で START/STOP の
  入口を作ることが、切替の前提条件である。**当日にホストへ手打ちで
  代用しない**（承認と証跡の経路を外れるため）。

### 0.2 setup 再実行の位置づけ

- ホストの controller はまだ旧版であり、PR #132／#140／#141／#146／
  #149 の controller 変更（export-prod-snapshot、本番モニターの
  observe 分離、export の bounded wait、approve-deploy の再発行
  ほか）は、`setup-paper-check.sh` の再実行でホストに入る。配布ピン
  は同一コミットで更新済みである。
- 再実行は、検証・本番いずれの supervisor も静止しているときだけ
  可能である（稼働中・状態遷移中・ジョブ待ちでは setup が拒否
  する）。当日の手順（§2）で先頭に置く理由はこれである。
- 現行の配布手順は、コミット固定の raw URL から Tera Term で実行
  する形である。配布の自動化は卒業後の課題として既知であり、切替
  の前提にはしない。

---

## 1. 切替前チェックリスト

- [ ] 検証 24h ランの卒業記録（最終ランの完了状態と証跡）が残って
  いる。
- [ ] 警報 Issue が解消している（検証側 `suiba-paper-alert`、本番側
  `suiba-production-alert` の open が残っていない）。
- [ ] 対象リリースが確定している（配置する main の sha。prod
  レコードと `/opt/suiba/last-deploy.json` に残る値と突き合わせる）。
- [ ] §0.1 の START/STOP 入口が main にマージされ、ゲート変数が
  未設定の間は不発であることを確認済みである。
- [ ] repo 変数の現状を確認した：`SUIBA_PROD_MONITOR_ENABLED` と
  `SUIBA_PROD_REVIEW_ENABLED` が未設定であり、
  `SUIBA_OBSERVE_VPS_PORT` が設定済みである。
- [ ] prod-policy.json（`/etc/suiba-paper-check/prod-policy.json`）が
  未配置である（配置は当日の明示操作）。
- [ ] watchdog timer（`suiba-prod-watchdog.timer`）が setup で配布
  済みだが未有効化である（有効化は当日の明示操作）。
- [ ] Windows 側の Bot が稼働中である（止めるのは VPS の開始確認が
  取れてから）。

---

## 2. 当日の手順

1. **setup 再実行**：検証ランが止まっている状態で
   `setup-paper-check.sh` を再実行し、ホストの controller を現行
   main のピンに揃える。拒否された場合は、理由（supervisor 稼働
   等）を解消するまで先へ進まない。
2. **配置確認**：対象リリースのイメージが `prepared_stopped` で
   配置済みであることを確認する（未配置なら DEPLOY-CYCLE-PAPER の
   経路で配置する）。あわせて prod-status で本番が閉じている
   （未開始、または前回が completed）ことを確認する。
3. **cutoff の release**：最後の検証ランの cutoff タイマーは、ラン
   終了後も武装したまま（active／elapsed）残る。prod-start の
   セッションゲートは全 cutoff タイマーの静止を要求するため、開始
   前に deploy-cycle の release-cutoff と同じ扱いで release する。
4. **prod-policy の配置**：`/etc/suiba-paper-check/prod-policy.json`
   に `{"enabled": true}` を明示操作で配置する（setup は作成も
   変更もしない）。検証の policy とは独立である。
5. **prod-start**：§0.1 の入口から開始する。prod-start は
   `suiba-prod.service` を起動し、runner 側で次の順に進む：
   セッションゲート（検証ランが開いていないこと＝検証レコードが
   completed かつ停止レシートが clean_stopped であること、本番が
   未開始であること、全 cutoff タイマーが静止していること）→
   preflight（台帳が prepared_stopped 等）→ backup → unlatch →
   worker 起動 → wait_ready → arm（無期限形：`issuedAt` のみで期限
   なし）→ paper-start → 終了時刻のない監視。prod-start の応答
   （accepted）は開始要求の受理であり、開始できたことの確認は
   次の手順で行う。
6. **開始後確認**：次が全て取れること。
   - prod-status が `in_progress` を示す。
   - `/api/deployment` の表示で本番セッションが armed／expires=null
     である。
   - 本番レコード（`/var/lib/suiba-paper-check/production/prod.json`）
     に id・開始時刻（started）・sha が残っている。
   - 市場データが新鮮で、最初のサイクルがエラーなく回る
     （prod-status の worker 項目で running／databaseHealthy／
     ledgerOk を確認する）。
7. **監視の有効化と初回スモーク**：
   - repo 変数 `SUIBA_PROD_MONITOR_ENABLED=true` を設定する。本番
     モニターが prod-status の定期観測と Issue 通知を始める（手動
     確認は dispatch の確認文字列 `CHECK-PROD-MONITOR`）。
   - host watchdog timer（`suiba-prod-watchdog.timer`）を有効化
     する（§5.1：setup は配布と検証のみで、有効化は切替時の明示
     操作）。
   - 日次レビュー：repo 変数 `SUIBA_PROD_REVIEW_ENABLED=true` を
     設定したうえで、その JST 日の定期投稿（00:17 JST、保険の
     01:17 JST）がまだ無いうちに、手動 dispatch（確認文字列
     `REVIEW-PROD-DAILY`）で初回スモークを行い、export
     （export-prod-snapshot）と Issue #121 への投稿を確認する。
     - 注記：両ジョブとも、変数が `true` でないと手動 dispatch
       でも skip される（workflow の if 条件）。また同日ぶんの
       投稿が既にある場合、投稿ステップは JST 日付マーカー
       （`suiba-prod-review: <日付>`）の重複ガードで skip され、
       ジョブは緑のまま終わる。したがってスモークは初回の定期
       投稿より先に行う（DECISIONS_JA の PR #148 補足の趣旨）。
8. **閲覧確認**：ダッシュボードが WireGuard 経由でのみ届くことを
   確認する（§7-2）。
9. **Windows 側の停止**：手順 6〜8 の確認が全て取れてから、
   Windows 側の Bot を止める。それまでは即時復帰可能な待機に
   置く。

---

## 3. 中止と戻し

段階ごとに、中止条件と戻し先を置く。

- **setup 再実行が拒否・失敗**：切替を中止する。Windows は稼働
  継続しており影響はない。
- **配置が prepared_stopped にならない**：先へ進まない。
- **cutoff の release ができない／セッションゲートで拒否される**：
  prod-start に入らない。拒否理由は固定コードと prod レコードの
  stage で確認する。
- **開始後確認が通らない**：戻し条件は設計書 §4 に準じる —
  readiness が通らない／開始後に runtime error が解消しない／
  台帳検証（ledgerOk）が立たない場合は、prod-stop して Windows
  側を再開する。
- **prod-stop の完了条件**（worker 停止・exit 0・latch 復帰・DB
  verify・SUI 選択）を満たさない場合は、配置や再開へ進まず、証跡
  を残して要レビュー（failed_requires_review）の扱いにする。失敗
  後の遅い stop は、失敗を正常完了に書き換えない。
- **分岐点**：VPS 側で約定が発生した後は状態が分岐するため、原則
  として Windows へ巻き戻さない。戻すかどうかの判断点は開始前に
  置く。

---

## 4. 切替後の1週間（集中観察週間）

2026-11-09 の決定により、切替後の最初の1週間は集中観察週間と
する。

- 日次レビューが Issue #121 に毎日出ること（`suiba-prod-review.yml`、
  直近24時間の窓）。
- 本番モニターが監視していること（定期観測と、要注意時の Issue
  作成／更新、正常確認での close）。
- host watchdog は検出と記録のみで、自動復旧はしない（§5.2）。
  取引の再開が要る場合は、証跡 → 承認 → prod-start の人の操作に
  よる。
- 検証ランは回さない（§7-6）。

---

## 5. 以後の更新手順（設計書 §6 の要約）

- 本番入替は **prod-stop → 配置 → prod-start** の順である。配置は
  従来どおり prepared_stopped で止まる。配置時の compose は本番用
  の値（`PAPER_CHECK_MODE` の本番トークン）を置く。
- broker の配置ゲートが見ているのは検証セッションのマーカーだけ
  なので、「本番が停止していること」はゲートではなく手順の前提
  として置き、配置ワークフローの前に prod-status で閉じている
  ことを確認する。
- prod-stop の完了条件を満たさなければ配置へ進まない。
- 新版の readiness が通らなければ prod-start を中止する。旧版への
  戻しは、配置がコンテナを作り替えているため再配置＋（必要なら
  配置時 backup からの DB 復元）で、判断は §4 の戻し条件に準じる。
- 証跡：prod レコードに sha と開始・停止時刻を残し、
  `/opt/suiba/last-deploy.json`（配置結果）と対で追えるようにする。
