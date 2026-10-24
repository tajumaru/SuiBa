# SQLiteロック待ち P1 原因調査・方式選定

基準: main `cba02cddc6be728d283e2b0e3a947e3b70b84a2a`。既存DB、Docker、外部APIにはアクセスしない。

## 原因と影響（基準SHAの行番号）

- `packages/database/src/index.ts:61`でDatabaseSyncを生成、64行でWAL/FULL/busy_timeout=5000を設定。`append`(157行)・`set`(109行)・transaction(144行)も同じ同期接続を使用。
- `apps/worker/src/index.ts:62`のSui onObservation→db.appendは通信Promise継続処理内で同期実行。Sui clientのemitで保存完了後にのみ正常判定へ進む。
- WALはreader/writerの並行性を改善するが、writerは1接続。別接続のBEGIN IMMEDIATEに競合するとSQLite C API内部で最大約5秒待つ。実測約5.4秒はbusy timeoutにスケジューラ/OS等の上振れを含み、厳密な上限ではない。
- 同じNodeメインスレッドのtimer、AbortSignal.timeout、45秒取得deadline、15秒watchdog、API制御、SIGTERMハンドラ、Promise継続も実行されない。ソケット/OSの処理自体とJSハンドラ実行は区別する。
- `apps/worker/src/operations.ts:136`のordersAllowed、375行付近の取得deadline、安全停止(546行)はDB状態を参照/保存する。DB lockがあると停止保存自身も待つ/失敗する。
- `apps/worker/src/engine.ts:613`以降のcatchもdecision→stop→runtime→riskのDB書込に依存。最初の保存失敗で後続停止保存へ届かない可能性。注文/約定/会計のBEGIN IMMEDIATE/COMMIT、cycle_audits、heartbeat、API設定保存にも同じ待ちがある。
- 同期ブロック中にJSで新規注文が並行実行されるわけではない。ただし制御応答が遅れ、停止失敗後に永続runtime.running=trueが残る場合を放置してはならない。

## 比較

| 方式 | 安全性/整合性 | event loop | ログ欠損 | 難易度/互換性/Docker/rollback |
| --- | --- | --- | --- | --- |
| A busy_timeout短縮 | 完了確認と原子性は維持。全DBに適用し、失敗時の揮発性注文拒否が必要 | ロック待ちを短縮。0ならSQLite busy handlerは待機しない。FS I/Oは同期のまま | 短い競合も失敗し得る。欠損を正常扱いせず停止/明示報告 | 小。接続単位設定、schema変更なし、Docker変更不要、コードrevert容易 |
| B 観測書込分離 | 同じDBを別接続にしてもsingle writer競合は残る。別DBは証拠整合/backup/API結合を再設計 | 同期別接続だけでは改善しない。他の書込も残る | 非同期queueなら未保存/queue喪失を管理しACK前health禁止が必要 | 中〜大。ファイル/volume/復旧手順追加。rollback時の証拠統合が必要 |
| C DB Worker Thread | メインから全DB操作を非同期化すれば分離可能。取引原子性、ACK、順序、取消、Worker障害/再起動を設計 | DB側の待ちはメインを止めない。ただしDB依存の安全判定はACK待ち | queue/未ACK/commit結果不明をfail closed、durable ACK必要 | 大。同期DB呼出しとtransaction callbackが広範。Docker resource/終了/drain変更。rollback難 |
| D transaction/index/頻度最適化 | 原子性維持で短縮可能。証拠間引き不可 | 負荷は減るが別writerの5秒lock待ちは残る | batching ACK設計を誤るとhealth先行/証拠喪失 | 小〜中。index migrationやbatch化は別検証。根本のlock待ち保証なし |

## 採用方針

Aのbusy_timeout=0と、DB接続単位のsticky operational faultを採用。短時間競合も速やかに失敗させる可用性上のtradeoffを明示する。自動retryしない。runtimeは障害時にメモリ上running=false/error=DATABASE_UNAVAILABLEを返し、永続化成功と偽らずDB healthを別公開。書込/transactionは以後拒否し、manual resetや通信復旧で解除しない。新プロセスでは既存boot停止・台帳照合・手動開始条件を再適用する。

制約違反など通常の業務上の拒否と、BUSY/LOCKED/READONLY/IOERR/CORRUPT/FULL等の接続運用障害を区別する。後者でのみsticky latch。失敗transactionはROLLBACKを試み元エラーを返し、rollback失敗も隠さない。schema/WAL/FULL/会計原子性は維持。Suiの保存ACKは同期のままで未保存正常は認めない。

Worker化は、ロック待ち以外のFS I/O・大規模SQL・GCまで含む停止上限が必要な場合の次段階。大規模変更のため今回は実装しない。
