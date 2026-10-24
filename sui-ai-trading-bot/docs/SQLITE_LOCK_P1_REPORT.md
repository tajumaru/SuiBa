# SQLiteロック待ち P1 最終報告

対象: tajumaru/SuiBa / sui-ai-trading-bot / main。
基準SHA: `cba02cddc6be728d283e2b0e3a947e3b70b84a2a`。実施: 2026-10-24 JST。
[原因調査・4方式比較](SQLITE_LOCK_P1_INVESTIGATION.md) / [全性能sample](SQLITE_LOCK_P1_BENCH.json)。

## 1. SQLiteロック待ちの原因

基準SHAの`packages/database/src/index.ts:60`でNode DatabaseSyncを生成、64行でbusy_timeout=5000を設定。append(157行)、set(104行)、transaction(144行)は全て同じ同期接続。別writerのBEGIN IMMEDIATEと競合するとSQLite内部で待機する。WALでもwriterは同時に1接続であり、同期FULLもこの待機を非同期化しない。実測約5.4秒は設定5000msにOSスケジュール等の上振れを含む。

Sui観測だけでなく、周期監査、運用イベント、runtime停止保存、設定、会計、注文/約定transactionも影響する。別のchart-history DBは`apps/worker/src/chart-history.ts:67`に100ms待機があるが、通常は`chart-history-client.ts:34`で専用Workerに分離済み。今回変更していない。

## 2. 安全監視への影響

ロック待ち中は同じメインスレッドのwatchdog、45秒取得deadline、AbortSignalのタイマー、Promise継続、HTTP管理操作、SIGTERM処理が進まない。OS側のソケット処理まで止まるという意味ではない。JSの新規注文が同時実行されるわけでもないが、停止の反応が遅れ、DB停止保存も失敗し得る。

基準のengine catch自体もdecision/stop/runtime/risk保存を必要とし、最初の保存例外で停止の永続化まで届かない場合がある。変更後はDB操作境界で障害をラッチし、停止保存の成否より先に有効注文ゲートを閉じる。

## 3. 改善方式の比較

| 方式 | 安全性・整合性 | メインloop | 欠損/運用 | 難易度・互換・rollback |
| --- | --- | --- | --- | --- |
| A timeout短縮 | 同期commit確認と原子性維持。別のメモリ停止ゲートが必要 | 0ならbusy待機をしない。FS/SQLは同期のまま | 短い競合も失敗。無条件retry禁止、失敗明示 | 小。schema/volume変更なし、コードrevert容易 |
| B 観測分離 | 同じDBの別接続だけではwriter競合解消せず。別DBなら証拠結合再設計 | 同期接続を増やすだけでは改善せず | queue/ACK/バックアップ/履歴統合が必要 | 中〜大。Docker volume等も増える |
| C DB Worker | 全操作の順序・transaction・commit ACK・障害時不確定結果の設計が必要 | メインからDB待機を分離できる | queue未保存を正常扱い禁止、終了drain/Worker監視必要 | 大。同期callback APIの全面変更、rollback複雑 |
| D SQL最適化 | transaction/indexで負荷軽減、証拠間引き不可 | 他writerのbusy待ちを解消できない | batch化にはACK設計が必要 | 小〜中。migration検証が必要な場合あり |

詳細なDocker・ログ・ロールバックの比較は原因調査書を参照。

## 4. 採用方式と理由

Aの**busy_timeout=0 + 接続単位のsticky fail-closed**を採用。単にtimeoutを変えるだけでは停止保存失敗を安全に扱えないため、運用SQLite障害をメモリに保持し、注文・復旧・新規書込・新規transactionを拒否する。0は「SQLiteのbusy handlerで待たない」という意味で、全SQLが0msで終わる保証ではない。

短い競合も正常回復を待たず失敗させるため、可用性は下がり得る。この変更は安全側の停止を優先する。Sui通信timeout/retry/health TTL、複数正常周期・手動停止・世代・板/足・台帳の既存条件は緩和しない。

B/Cは観測だけ切り離すと他の同期DB待ちが残り、全体を移すと大規模変更になるため未実装。FS遅延や大規模SQLまで隔離する要件にはCの別承認設計が必要。

## 5. 修正内容と参照箇所（変更後の行番号）

- `packages/database/src/index.ts:41` health / 49 assertHealthy / 52 sql: SQLite運用エラーをstickyに保持。エラーは元の呼出元へ再throw。一次code19の制約違反だけは業務拒否として区別し、connection障害扱いしない。BUSY/LOCKED/READONLY/IOERR/FULL等と未知のSQL例外は停止側。
- 同ファイル92行: 全BotDatabase接続のbusy_timeoutを5000→0。WAL/FULL/foreign_keys/schema/indexは維持。設定は接続単位で、既存稼働DBへPRAGMAを実行していない。
- 同ファイル137行 runtime: 障害時はメモリ上running=false/error=DATABASE_UNAVAILABLEを返す。**永続停止保存済みとは表現しない**。healthのrequiresRestart=trueを返し、manual resetや通信復旧で解除しない。
- 同ファイル180行 transaction: BEGIN/COMMIT障害も捕捉。statement失敗後もrollbackを試行し、rollbackも失敗した場合は元例外と一緒にAggregateErrorとして伝播。原子性と重複防止を維持。
- 同ファイル202行 append / 304行 commitFill: 共通SQL境界で障害後のwrite/transactionを拒否。自動再試行、queue、ログ間引き、DROP/DELETE/VACUUMは追加しない。
- `apps/worker/src/operations.ts:119` ordersAllowed / 139 recoveryCycle: DB fault時は即false。575行watchdogと`engine.ts:74` tickは障害を例外として既存supervisorへ伝える。
- `apps/worker/src/index.ts:339` operationsレスポンスにdatabaseHealth追加。watchdog / scheduler error handlerは既存のprocess.exit(1)を維持し、固定event名と許可済みdatabaseHealth（code/数値sqliteCode）だけをstderrへ出す。DBに保存できない障害を正常扱いせず、秘密情報や生SQLite例外を出力しない。read可能な場合にAPIでfaultを確認できるが、破損等でread自体不能ならAPI応答は保証しない。
- 同ファイル63行のonObservation→db.appendとSui clientの保存完了確認は同期のまま。未ACKのqueueは存在せず、失敗はVALIDATION_RECORD_FAILEDとなりhealth正常は確定しない。

## 6. 修正前後の性能比較

`node --import tsx scripts/sqlite-lock-bench.ts`。各条件で**独立した新規一時DB10個**、計60個を使用。比較前は同じコードの新規接続だけに旧busy_timeout=5000を設定し、ロック待機方針の差を分離した。旧Bot全体を起動した測定ではない。append直前にsetTimeout(0)を予約し、そのcallbackでAbortController.abortも発火。予約からcallback実行までをメインloopのタイマー遅延として記録。短ロックは別スレッドが100ms後に解放、長ロックはappendが戻るまで保持。

| 条件 | 設定 | timer P50 ms | P95 ms | 最大 ms | 保存成功/失敗 |
| --- | --- | ---: | ---: | ---: | ---: |
| 無ロック | 旧5000 | 5.54 | 7.40 | 7.40 | 10/0 |
| 無ロック | 新0 | 2.98 | 8.05 | 8.05 | 10/0 |
| 短100ms | 旧5000 | 129.01 | 146.28 | 146.28 | 10/0 |
| 短100ms | 新0 | 0.61 | 11.15 | 11.15 | 0/10 |
| 長保持 | 旧5000 | 5412.42 | 5513.41 | 5513.41 | 0/10 |
| 長保持 | 新0 | 1.01 | 21.62 | 21.62 | 0/10 |

長保持のSQL実行時間はP50 5412.04→0.106ms、P95/最大5513.33→0.171ms。新設定のtimer最大21.62msはSQL待ち0.171msより大きく、OSのスケジュール等も含む。新設定は失敗を速めたもので、競合保存を成功させた結果ではない。無ロックのP95は改善しておらず、通常FS書込の高速化を主張しない。

10試行nearest-rankのためP95=最大。小標本、ローカルWindows/Nodeでの測定で、CPU/アンチウイルス/同時テスト負荷を隔離していない。Docker/本番性能・リアルタイム上限の保証ではない。生sampleと方法はJSONに保存。生成一時DB/resultも保持し、既存DBにはアクセスしていない。

## 7. 安全停止・復旧テスト結果

最終オフライン全体: **37ファイル、488件成功、7件skip、失敗0**。socket connect/listen禁止setupを使用。新規SQLite関連11件とBotEngine統合2件を追加。

- 無ロック保存: 別接続から行を確認、WAL/FULL/timeout=0も確認。
- 短200ms/長10秒予定ロック: BUSYを速やかに検出しtimer/Abortをdispatch、追加write/手動start相当書込を拒否、ロック解放後も障害解除なし。
- READONLY: 実PRAGMA query_onlyで失敗を生成。writableへ戻しても自動復旧なし。
- 部分transactionの運用例外: 証拠行とportfolio変更をrollback。COMMIT I/O失敗はfixtureで注入し、ACK前にrollbackしたことを別接続から確認。
- 制約違反: transactionをrollbackし元行/portfolioを維持。通常の重複拒否をconnection運用障害と混同しない。
- 保存中キャンセル: 同期保存callbackの境界でAbortし、healthを正常確定しない。ネイティブSQL実行途中をAbortSignalで中断できることまでは主張しない。
- Sui保存BUSY: writer呼出しは最初の1回だけ。後続の通信確認・複数周期・manual stopの有無で復旧せず。
- BotEngine実統合: Sui fixture応答時に新規DBをlockし、観測保存から停止。市場取得/quoteへ進まず、ロック解除後の3周期もDB障害で拒否。
- 永続runtime.running=trueが残った場合: 障害接続は有効runtime=false。新接続のbootで停止・resumePending=falseを確認。
- 新規ロック/性能fixtureのpaper_orders/paper_tradesは0。既存全回帰には一時DB上の模擬会計fill検証を含むが、実注文・実約定・送金・LIVE有効化はなし。

TypeScript `tsc --noEmit`、本番 `vite build apps/dashboard`成功。既存Zod注釈警告のみ。Sui観測、health、Bot停止/復旧、DB/会計を含む全オフライン回帰が成功。実socketを使う7件とsettings-api/deepbook-transportの2ファイル、E2E、Docker、実Sui/DeepBook、PAPER運転は未実施。

**Nodeはv24.14.0**。要求24.22.1以上での検証は未実施であり、追加の制限として残す。Nodeインストールや既存runtime更新は行っていない。

## 8. 残存リスク

- SQLiteロック待ちを除去しても同期FULL fsync、checkpoint、巨大query、JSON、GC、OS停止はメインloopを止め得る。Worker化なしに全DB処理の遅延上限は保証できない。
- 短い競合でも停止する。外部DB writer・backupツールのlock方式を独立検証環境で確認する必要がある。可用性目的のretry追加は別設計。
- DB障害時の停止ラッチはメモリ上。永続DBのruntimeが古いまま残り得るため、DB health/固定supervisorログ/起動時停止を合わせて解釈する。障害証拠行自体を保存できない場合があり、それを正常・完全ログと扱わない。
- ディスク障害ではCOMMIT結果が不確定な場合もある。自動再送せず、再起動前にSQLite/台帳/証拠を照合する。実電源断/実disk full/corruption/rollback故障の耐障害試験は未実施。
- code19の制約例外はsticky DB faultにしないが、観測writerがそれをthrowすればSuiの既存sticky保存障害として停止する。業務transactionも失敗を元callerへ返す。
- ログ保持/容量管理は前回提案のまま。証拠削除・既存DB変更・schema migration・DBファイル分離は実施していない。
- rollbackはコードrevertと承認済み再デプロイで可能、schema互換のためDB逆migration不要。ただし5秒待ちも復活するので安全性を再評価する。今回は稼働環境への反映なし。

## 9. コミット・push

原因調査 `b676383` →実装 `410e52d` →回帰/性能→最終報告の4単位。最終応答に各SHAとmain pushの実結果を記載する。GitHub push以外の実ネットワーク・Docker・既存Bot/DB/volume操作は行わない。

## 10. 次の30分実通信検証

**現時点で開始はNO-GO（承認待ち、要求Node版での検証待ち）**。本修正でコード上の5秒SQLite busy待ちの課題は改善したが、30分実測の承認を代替しない。

次は要求Node24.22.1以上でoffline/type/buildを再確認した固定SHA/imageを使い、前回の独立project/新DB/新secret/未使用localhostポート3105計画に、DB health・SQLITE_BUSY件数・stop persistence差分・event loop lag・append P95/最大を追加する。既存3100/3101は操作せず、running=false・注文0を維持。新環境でBUSY/証拠保存障害が出たら打切りNO-GO、DB正常でも30分の母数では長期安定性合格としない。

実通信・Docker操作・PAPER開始はユーザーの別途明示承認を待つ。
