# Windows 2時間検証：品質ゲート修正と保存証拠の再評価

対象run：`winverify-20261024T233151002Z-df2afd7`。対象SHA：`df2afd7243c9b27e0c11944968d8e02ae8f3ebf1`。
修正ブランチ：`codex/fix-preflight-quality-gates`。調査開始時main：`7bd3f74e284e97abefc72ba5122225016bcfd7b3`。PR作成時に追加されていたUI変更を含む最新main `8270beffbdf296800bc737e34ae2d55bd78d3709` へ競合なくrebase済み。
PR #8、main、既存コンテナ・DB・volumeは変更していない。PAPER/LIVE取引、注文、約定、新しい実通信検証は開始していない。

## 結論

今回の `COMPLETED` は正常な予定観測終了であり、保存された品質証拠の全条件達成ではなかった。

| 条件 | 固定基準 | 保存証拠の実測 | 原因と対応 |
| --- | --- | --- | --- |
| twoHours | 実観測7,200,000ms以上 | 7,199,516ms（484ms不足） | WindowsはCompose起動前の時刻で期限を決め、集計は最初〜最後のサンプルを使用。起動時間とサンプル位相で不足する。今後は最初の実サンプルから予定期間を確保し、終了時のDB実スナップショットを保存する |
| suiMinAttempts | 実HTTP試行100件以上 | 82件、成功82件 | 計数は正しい。health成功の120秒キャッシュを使うため121サイクルすべてがHTTPを発生させない。キャッシュhitを試行に加算せず、100件を維持する |
| bookFreshAtEnd | 終了時点の板証拠が10,000ms以内 | 最終保存sampleで18,932ms、取得完了時は929ms | 取得時と終了時の鮮度は別。元の実測を成功へ読み替えず、今後は正常完了時だけ独立したread-only GETで終了時の板証拠を保存する |

**保存済みrunの再評価は `INCONCLUSIVE → NO-GO`（Windows総合評価ではFAIL相当）**。従来は母数不足を先に返すため、終了時の鮮度という既知の未達を `INCONCLUSIVE` に隠していた。修正後は既知の違反を優先し、必要証拠欠落・母数不足だけの場合を `INCONCLUSIVE` にする。

2時間や82件を丸めたり、水増ししたりしてPASSへ変更していない。今回のrunの終了時点へ遡って新しい板データを作ることもできない。新収集経路の実通信での確認と、100件以上を満たす追加の独立検証が必要。

## 入力・判定・レポート経路

1. `scripts/preflight-observer.mjs` は `ValidationRecorder.attempt/cycle/sample` を観測してJSONLへ保存する。Sui API実試行は `kind=api,data.api="Sui gRPC"` であり、health cache hitや市場サイクル成功とは別。
2. `Invoke-SuiBaVerification.ps1` が専用projectの証拠をコピーし、`preflight-audit.cjs` でread-only DB監査・operations読取りを行う。
3. `summarize-preflight.cjs` が証拠期間内のAPI・サイクルと独立監査を照合し、品質checksを生成する。
4. `Verification.OneClick.ps1` が終了理由・既知の障害・品質checks・性能証拠の完全性を組み合わせて総合評価する。`COMPLETED` 自体からPASSを作らない。

各3条件の入力元は、期間が最初と最後のsampleの `at`、試行数が期間内 `api` 行数、板鮮度が最後のsampleの `market.bookAt` と評価時刻の差である。新形式では終了sampleは独立監査の実DBトランザクション時点、終了板は同じ監査が採取した `finalBook.timestamp` を使う。

### 期間の具体的なずれ

時刻はJST、いずれも2026-10-25。

- Windows開始：08:33:24.082（Compose up前）。レポート完了：10:33:49.576。
- 最初の実sample：08:33:32.558。最後の評価対象sample：10:33:32.074。
- read-only audit開始：10:33:35.840。最終sampleから3,766ms後だが、従来auditは完全なsampleではないので、この時間を実観測へ勝手に追加しない。
- 新形式では `ObservationStartedAtUtc` / `ObservationDeadlineUtc` をstateへ保存し、最初のsample起点で予定期間を待つ。終了監査はruntime、安全状態、注文件数、設定hash、build、整合性、残高の実読取りから `terminalSample` を作る。
- watchdogとコンテナ内強制期限、DB・通信・連続失敗等の安全停止条件は変更しない。初期サンプル待ちの間のSTOP_REQUESTも監視ループ前に確認する。

### 実行同一性

保存済みrunではreport/runId・state・runディレクトリ、observer SHA/image/Node、全sampleのbuild/settings hash、auditのbuild、inspection.Imageを照合し、対象run・SHA・120分・詳細計測ONの組合せに矛盾がない。比較条件の入力元は `state.json`、`compose.override.yaml`、observer、reportである。

ただし従来observer/auditにはrunId・予定期間・計測モードの共通識別子がなく、自己完結した厳密照合を後付けできない。再評価では `runIdentity=null` と表示し、欠落を推測で補完しない。

新形式は秘密情報を含まない `evidence/run-context.json`（schemaVersion=1）を作り、runId/project/SHA/image/予定期間/`passive-health-cache-v1`/詳細計測ON/OFFをobserver・auditに保存して照合する。異なるrun・SHA・image・期間・モードはNO-GO、識別情報欠落はINCONCLUSIVE。長い予定時間を2時間分の証拠で代用することも禁止する。

Windowsレポート側でも `qualityWindow.context` とreport自身のrunId/SHA/image/予定期間/計測ON/OFFを照合し、他runのGOを取り込ませない。

### 終了時の板証拠

正常な `COMPLETED` の場合だけauditへ `--end-book` を渡し、固定された公開エンドポイント `/orderbook/SUI_USDC?level=2&depth=10` を1回GETする。既存DeepBookと同じ8秒期限、証明書検証有効、retryなし。取引APIには接続しない。安全停止・手動停止ではこの追加GETを行わず、停止を遅らせない。

開始時刻・取得完了時刻・上流timestamp・source・許可されたerror codeだけを保存する。timestampを取得時刻で置換しない。応答不明・不正はMISSING、10秒超や未来timestampはFAIL。取得完了が監査時刻を超えた証拠も採用しない。API本文・tokenは保存しない。

このGETは独立した「終了時の外部板の鮮度」の確認であり、Workerの保持板を更新する操作ではない。通常サイクルの取得時鮮度チェックも残す。独立probeを通常APIの成功数へ加算しないので、Sui82件やDeepBook772件の分母を水増ししない。追加のGET1回という観測上の差は、計測モードと本書で明示する。

### 判定表示

`checks`（true/false/null）に加えて `criteria` にPASS/FAIL/INSUFFICIENT/MISSING、実測値、固定閾値、単位、入力元、評価時刻を保存する。`report.json`とnext-actionsへ伝達し、単なる「未達または未確認」だけで済ませない。

母数不足と既知の障害を同時に検出した場合は既知の障害を優先する。性能ログのSQLite失敗・writer失敗、異常終了、安全停止は既存どおりFAIL。正常な手動停止要求だけは未完走としてINCONCLUSIVEだが、併発するDB障害等を隠さない。

## 保存証拠の再現結果

[再集計結果・原本ハッシュ・性能抽出](evidence/quality-gates-20261025/saved-run-replay.json)を収録。原本はローカル `tools/windows-verification/runs/winverify-20261024T233151002Z-df2afd7/` にあり変更していない。DBやsecretはPRに含めない。

| 指標 | 修正前 | 修正後 |
| --- | --- | --- |
| 実観測期間 | 7,199,516ms | 同じ |
| Sui実HTTP成功/試行 | 82/82 | 同じ |
| DeepBook成功/試行 | 772/772 | 同じ |
| 市場サイクル | 121/121 | 同じ |
| 終了時の保持板証拠の年齢 | 18,932ms | 同じ、10,000ms基準に未達 |
| 通信品質判定 | INCONCLUSIVE | NO-GO |
| 新しいrun同一性・terminal証拠 | 保存なし | MISSING（捏造しない） |

再現コマンド（原本をread-only入力にして別ファイルへ出力）：

```text
node scripts/summarize-preflight.cjs <run>/evidence/preflight-evidence.jsonl
  <run>/evidence/audit.json <run>/evidence/inspection.json <別出力>/summary.json
```

新形式のCLIは5番目の引数に `<run>/evidence/run-context.json` を受け取る。古い証拠の再現時は渡さない。

## P2：性能調査

詳細SQLiteは4,782件、失敗0。500ms超スパイク117件。親transactionと子saveCandles等を二重計上しないよう、スパイク窓とSQL開始〜終了区間の交差をマージして和集合を計算した。

- 117/117のスパイク窓が記録されたSQLite区間と重なる。
- 最大スパイクは10:01:11.190 JSTから2,733msの窓、最大遅延2,166.358ms。そのうち同期SQLite区間の和集合は2,208ms。単発最大497msだけでなく、複数の同期保存が連続する構造が見える。
- 最遅の詳細setは `bot_runtime_state/operation_state`、497.217ms（JSON 0.016ms、SQL 497.192ms）。累積計測の497.407msとは異なる計測境界なので混同しない。
- transaction484件の合計48,569.964ms中、COMMIT区間45,032.337ms（約92.7%）。最大COMMIT395.668ms。WAL/FULL同期での永続化待ちが候補だが、COMMIT内のfsync、checkpoint、VHDX待ち、ホストのスケジューリングは分離されていない。
- 記録writerの同期I/O最大23.851ms。GCイベントやホストのディスクカウンタは保存されていない。observer自身の同期読み取り・appendFileSyncのすべてをSQL詳細計測がカバーするわけでもない。

**同期SQLiteと遅延の関連は強いが、ストレージ・WAL checkpoint・GCの責任割合は未確定。** そのためDB同期レベル、checkpoint設定、トランザクション、安全停止・タイムアウトは変更しない。追加調査にはGC pause、WAL checkpoint開始終了、fsync/ディスクI/OとCPUスケジューリングの同時採取が必要。チェックポイントを強制実行したり既存DBを触ったりする診断は行っていない。

## テスト

- 新規Node回帰テスト17件成功：2時間＋全証拠でGO、484ms不足、82件の母数不足、板不明/古い/未来、既知障害優先、識別子不一致/欠落、終了snapshot欠落、期間より長い計画、通信・サイクル失敗、GET一回・上流時刻保存、read-only audit実行の保存経路を検証。通常の `test` / `test:offline` の先頭でも実行する。
- 型チェック・アプリbuild成功（Node v24.22.1、network=noneの隔離環境）。
- Windows `Invoke-SelfTest.ps1` / `Invoke-OneClickSelfTest.ps1`：失敗0。従来のhappy fixtureは実際にはSQLite失敗を含むため、誤ったINCONCLUSIVE期待をFAILへ修正した。安全判定を弱めていない。
- Node v24.22.1の使い捨てコンテナ、network=none、既存volumeなしで既存offlineテストを実行。通常の並列実行ではSQLite系9件が5秒制限に到達。期限は変更せず、tmpfsの一時DB＋1 workerで切り分けた結果は687 passed / 7 skipped / 2 failed。残る2件は `agent-narration-fx.test.tsx` のCSS文字列assertionで、基点mainのGit archiveからも同じ2件を再現した。本PRでは無関係なUIを変更しない。
- 2時間の実通信再検証やDockerのbuild/deployは実施していない。終了時の外部GETはテストではmockし、インターネットへ接続しない。

## 未解決事項とレビュー条件

Suiの固定100試行基準は現行120秒cache・60秒サイクルと組み合わせると2時間では必ずしも満たせない。これは今回の誤集計ではなく基準と観測頻度の関係である。閾値を下げたりcache hitを加算したりせず、十分な母数がある独立runで確認する。新収集形式を使った再検証と、mainに既存のCSSテスト不一致の対応は別途必要。

本変更はレビュー待ちとし、mainへ直接コミット・マージしない。通信観測のPASSであってもPAPER/LIVE取引開始の承認にはならない。
