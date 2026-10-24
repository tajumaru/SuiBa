# Windows無人検証・2時間通信観測の調査結果

調査日：2026-10-24。コード・DB・Dockerの変更、追加RPC、PAPER取引、LIVE取引は実施していない。

## 対象と証拠

- 検証対象SHA：`93d3414f1b38f34f44481faff1a5c98f0bfb12c1`
- Run ID：`winverify-20261024T091053Z-93d3414`
- コンテナ内Node：v24.22.1
- イメージ：`sha256:69c0c88273bfaa0b14e52f7d0a5ce50008b2c24ae6bb110563ec13b7c6ef9d82`
- 実行管理上の開始・終了：2026-10-24 09:12:18.9325805～11:12:46.8414967 UTC
- 集計対象サンプル窓：09:12:27.084～11:12:33.095 UTC
- 終了理由COMPLETED、exit 0、OOMなし。品質判定はINCONCLUSIVE。

ローカル証拠の基点は、プロジェクト内の
`tools/windows-verification/runs/winverify-20261024T091053Z-93d3414/`。
このディレクトリ、secret、実DB、生ログは本コミットに含めない。
以下のJSONL・ログ行番号はその保存済みファイルに対するもの。

`reports/preflight-summary.json` に記載された3ファイルのSHA-256を再計算し、すべて一致を確認した。

| ファイル | SHA-256 |
| --- | --- |
| evidence/preflight-evidence.jsonl | 6c2c520df7ee60660056863fdc0879c9bf10b65ca4659837c57ed063c4755722 |
| evidence/audit.json | 3b44e079a8e67b9d49490590f5dcc4c5ed4f9521a8a1afaeb1581dba848dc994 |
| evidence/inspection.json | e0fb9874d109d1237ebfc6ac963e7dfd1f8284ca797cd01ee5b2d788dba8410f |

## 1. タイムアウトと市場周期の関連

以下の時刻は2026-10-24、日本時間（JST）。APIの終了時刻とobserverの記録時刻は異なるため、API内のstartedAt/endedAtを使用する。

| 対象 | 開始 → 失敗 | 操作 | 結果 |
| --- | --- | --- | --- |
| DeepBook | 18:24:25.728 → 18:24:33.735 | GET、MARKET_STATUS、deepbook-indexer.mainnet.mystenlabs.com | UPSTREAM_TIMEOUT、HEADERS_OR_CONNECT、試行時間8,009ms |
| Sui | 20:05:09.684 → 20:05:19.686 | POST、SUI_GRPC_READ、fullnode.mainnet.sui.io | UPSTREAM_TIMEOUT、TLS、試行時間10,004ms |

両方ともcauseCode=null、HTTP status未取得。証拠はJSONL 159行・1377行、および `reports/events.csv`。

DeepBookのMARKET_STATUSは、`packages/shared/src/http-errors.ts` のrequestIdentityと
`packages/market-data/src/deepbook.ts` のrefreshStatusから、
`/status?max_checkpoint_lag=100&max_time_lag_seconds=60` に対応する。
保存URL自体はredactされているため、クエリはソースに基づく復元である。

SuiはhealthのSUI/USDC metadata取得経路に対応する。SDKではgetCoinMetadataがGetCoinInfoを使用するが、
API JSONLはcoin種別・requestId・RPCパスを保持しない。この証拠から失敗coinを確定することはできない。
詳細を得るには、別途保存されたsui_observationsとの関連付けが必要。本調査ではDocker/既存DBへアクセスしていない。

- DeepBook障害を含む周期：18:24:10.136～18:24:47.032、36,896ms、error=null、SAFETY_GATE。今回の最長周期だが成功（JSONL 167行）。
- 唯一の失敗周期：20:05:09.399～20:05:23.459、14,060ms、SUI_READ_FAILED（JSONL 1379行）。Suiタイムアウトと同一周期。
- 次の成功周期は20:05:46.895に完了（JSONL 1392行）。

## 2. 遅延した段階と復旧

### Sui

新規接続（reusedConnection=false）で、DNS 1,650ms、TCP 2,506ms。その後TLS段階で期限切れ。
TLS完了、応答待ち、本文受信の値は記録されていない。
総時間との差約5.85秒は推定であり、TLS時間の直接計測値ではない。
TLS段階で未完了という証拠はあるが、サーバー、経路、ホスト実行遅延のどれが根本原因かは未確定。

SuiのAPIリトライ件数は0。20:05:22.150には別の成功通信が記録されるが、失敗周期は成功扱いされていない。
`packages/sui-client/src/index.ts` のhealthはPromise.allSettledで両coinの成功を要求する。
片方の成功は両方のhealth成功を意味しない。

### DeepBook

接続再利用（reusedConnection=true）で、ヘッダー取得前にタイムアウト。本文受信開始の証拠はない。
DNS/TCP/TLS値の欠落は再利用接続の計測設計に沿う。欠落値を0msと扱ってはならない。
`packages/market-data/src/deepbook-transport.ts` は新規接続時のみ確立時間を付加する。

18:24:41.673に同APIのattempt=1が6,635msで成功（JSONL 160行）。後続市場周期も成功し、リトライ回復を確認した。

安全状態のサンプルもDEGRADED→RECOVERING→HEALTHYと推移した。
DeepBook障害後は18:26:27.194、Sui障害後は20:07:17.986のサンプルでHEALTHYを確認。
すべてrunning=false、resumePending=falseを維持した。取引再開の検証ではない。

## 3. イベントループとSQLiteの遅延

| 指標 | 累積結果 |
| --- | --- |
| イベントループ P50 / P95 / 最大 | 10.215 / 10.379 / 2,545.943ms |
| SQLite append 件数 / P95 / 最大 | 999 / 130.879 / 407.807ms |
| SQLite set 件数 / P95 / 最大 | 2,991 / 133.631 / 1,767.423ms |
| SQLite transaction 件数 / P95 / 最大 | 484 / 456.703 / 798.719ms |
| BUSY / LOCKED / 各書き込み失敗 | すべて0 |

最終値は `logs/container.log` 483行。
イベントループ最大値の初出区間は19:32:09.967～19:32:24.965（同322～323行）。
これは2件のタイムアウトとは別の時刻であり、この最大停止がタイムアウトを引き起こした証拠はない。
同区間の市場周期は7,391msで成功（JSONL 991行）。

set最大値の初出区間は18:32:23.152～18:32:38.152（ログ83～84行）、
transaction最大値は19:27:08.714～19:27:23.711（302～303行）。
いずれも単一処理の正確な開始時刻ではなく、累積最大値の更新が判明する区間である。

ソースで確認できる同期負荷：

- `apps/worker/src/engine.ts` は毎周期3時間足分をsaveCandlesへ渡す。
- `packages/database/src/index.ts` のsaveCandlesは全行をJSON変換し、UPSERTする同期トランザクション。WAL/FULL、busy_timeout=0。
- `scripts/preflight-passive-metrics.mjs` はtransactionメソッド全体を計測する。コールバック、ループ、JSON変換、BEGIN/COMMITを含み、純粋なCOMMIT待ち時間ではない。ネストするappend/setの時間とも重複するため合算不可。
- `scripts/preflight-observer.mjs` にもappendFileSync、同期DB読み取り、4サンプルに1回のintegrity_checkがある。これらすべてが上記DBメソッドのヒストグラムに含まれるわけではない。

**根本原因は未確定。** 同期処理によるイベントループ占有という構造は確認できたが、
保存済み計測は15秒間隔の累積ヒストグラムであり、遅い処理のキー・SQL・スタック・fsync・GC・ホストI/Oを持たない。
ディスク、WALチェックポイント、GC、CPUスケジューリング等は候補であり、確認済み原因として扱わない。
SQLite異常なしは、SQLite処理の遅延なしを意味しない。

## 4. INCONCLUSIVEの判定

`scripts/summarize-preflight.cjs` のchecks（200行付近）と判定順（293～335行）を確認した。

| 未達条件 | 基準 | 実測 |
| --- | --- | --- |
| suiMinAttempts | 100件以上 | 88件 |
| suiSuccess | 成功率99%以上 | 87/88、98.864% |
| bookFreshAtEnd | 最終サンプル時の板鮮度10秒以内 | 15.233秒 |

母数不足を先に判定するため、上記の成功率・鮮度未達も存在するのにINCONCLUSIVEとなる。
母数不足だけの結果、または合格相当として報告してはならない。
取得完了時の板鮮度は最大2.522秒で、bookFreshAtEndとは異なる指標。
最後の取得時刻とサンプル終了時刻の差もあるが、現行条件の未達という事実は維持する。

COMPLETEDは予定観測を終了した意味であり、品質合格ではない。
Sui gRPCと名付けられたAPI集計は、`packages/shared/src/api.ts` の本文取得完了を成功とする層の計数。
87件のAPI成功だけではgRPC status・metadata個別成功率を証明できない。

通信観測としては、2時間完走、DeepBook 790/791成功、市場121/122成功、単発障害後の回復、停止状態維持を確認。
一方、PAPER取引は未実施で、注文・約定・候補はいずれも0件。約定後会計や取引運転の合格証拠にはならない。
サマリは整合性確認121件、final integrity_check=ok、runningCycleEvidence=0、runningAuditEvidence=0を記録する。

## 5. 次の検証へ進む条件

24時間通信観測は、無条件GOではなく、次の準備とユーザーの明示承認を条件とする。

1. 実行SHAを固定する。今回の93d3414は、その後マージされたSQLite一時エラー修正の実通信検証ではない。
2. 必要な追加調査として、遅いDB処理・observer処理とイベントループ停止を時刻・処理種別で対応付ける受動計測を検討する。追加RPCや安全条件緩和は行わない。本報告では未実装。
3. 母数・成功率・取得時鮮度・終了時鮮度を区別し、複数の未達条件を併記する。基準を結果に合わせて下げない。
4. 独立project/volume/secret、期限監視、ディスク条件、連続失敗・証拠保存失敗時の中止、注文・約定0件の監視を維持する。

PAPER取引検証は保留。保存障害時の注文停止、workerの例外終了、再起動後停止の回帰確認と遅延の追加切り分けを行い、
通信観測とは別の取引・会計・安全停止の試験計画および明示承認を得る。
24時間通信観測の成功も、PAPER取引やLIVEの開始承認に代えてはならない。

## 調査の範囲と未実施

ローカル保存済みJSONL、監査・集計JSON、コンテナログ、ソースの読み取りのみ。
実ネットワーク再現、Docker操作、既存DBの照会、OS/ディスクの性能測定、コード修正、取引開始は未実施。
上記ソースの通信・集計・計測経路は検証対象SHAとの差分がないことを確認した。
DB一時エラー分類は検証後に修正されたため、今回の性能・正常終了をその修正の検証結果として流用しない。
