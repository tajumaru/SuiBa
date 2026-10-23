# 第2回PAPER運用前・2時間通信安定性検証

検証日：2026-10-23 JST。対象：tajumaru/SuiBa / main / sui-ai-trading-bot。

**判定：INCONCLUSIVE。第2回24時間PAPERへの移行はNO-GOを維持する。**

通常周期で2時間以上を実測したが、Sui gRPCは98試行で指定の100試行に届かなかったため、依頼の母数不足時の規則を優先する。加えてSui成功率94.8980%、市場取得周期正常率96.7742%は99%未達。終了時は通信DEGRADED、板snapshotも鮮度未達であり、母数不足だけを解消してもGOにはならない。試行を増やす負荷試験、キャッシュ解除、Bot開始、24時間セッション作成は行っていない。

参照：[第1回報告](PAPER_24H_RUN1_FINAL_REPORT.md)、[RUN2準備判定](PAPER_RUN2_READINESS.md)、[UI/API操作](VALIDATION_UI_FLOW.md)。

## 1. 検証環境と固定バージョン

| 項目 | 確認値 |
| --- | --- |
| Windows | Windows 11 Home Insider Preview、10.0.29683 / build 29683 |
| Docker Desktop / Engine | 4.96.0.243774 / 29.9.1、desktop-linux |
| 固定Git SHA | 8b05f2a6864e2891259b8a934b0063be9ec337b3（mainへマージ・push済み） |
| 実image ID | sha256:a3722496cd4529df8cd50aab7ca84ae2892312f3321f00b03330e4111ec30b85 |
| base image | node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 |
| Node実版 / pnpm | v24.22.1 / 9.12.3、frozen-lockfileでビルド成功 |
| image内lock SHA256 | 018af17282416ae1aa6bcbd9f97e6626f45957bd32ed96a3c0583b8773362816 |
| Git blobのlock SHA256 | f96da72b5afa94e0325a186c7bd07ec97c26f1a7ab26be5be55084399304bb90 |
| 設定SHA256 | 80a3fcb63a125a50ec788ad87fbb79cf13095f49d3087dcfc97592a7ef8b3c2d |
| project | suiba-preflight-20261023-8b05f2a |
| container ID | d9c5ef0f50aa3c8dab48eca11f0cc807319473bb8ac3465e421c2363867fd803 |
| ポート | 127.0.0.1:3104 → container 3100、開始前に競合なし |
| 新規DB volume | suiba-preflight-20261023-8b05f2a_run2-data |
| 新規report volume | suiba-preflight-20261023-8b05f2a_run2-reports |
| DB | /app/validation/deepbook-paper.sqlite、コピー・既存履歴継承なし |
| 安全設定 | MODE=PAPER、deepbook、verified、Profit Guard有効、running=false、restart=no |

mainにはread budget、欠損状態遷移、周期証跡、実行版固定のP0修正が含まれる。cleanなmain用worktreeからビルドし、OCI revision・実image・runtime_buildを独立照合した。Git blobとimage内lockのバイトhash差はWindows checkoutのCRLF変換であり、実image内のhashを実行時と照合して固定した。アプリ変更はせず、実行中のimage・設定hashは各1種類、再作成・再起動0回。

既定のsuiba-paper-run2-preflight volumeは既存だったため再利用せず、上記の未使用projectに新規volumeと新規管理secretを作成した。secretはGit管理外・build context除外、既存値の流用なし。起動前にユーザーへproject/image/port/volume/安全設定を提示し、「すすめてください」の承認後に起動した。LIVE拒否・停止維持は既存回帰テストでも確認済み。統合前の検証は型検査、production build、35ファイル464テスト成功。

既存3100（docker-bot-1、docker_paper-data）と3101（suiba-deepbook-24h-bot-1、suiba-deepbook-24h_validation-data / validation-reports）は変更していない。開始・終了のcontainer ID、image、StartedAt、restart countが一致し、両方runningのまま。既存DB内容への追加アクセス、停止・再作成・設定更新は実施していない。

## 2. 開始・終了時刻と計測方法

| 項目 | JST |
| --- | --- |
| コンテナ起動 | 2026-10-23 19:22:48.117 |
| 評価開始（最初の実sample） | 2026-10-23 19:22:49.971 JST |
| 評価終了（最終監査前の最後の実sample） | 2026-10-23 21:24:21.660 JST |
| 連続観測時間 | 02:01:31.689＝7291689ms |
| 読み取り専用最終監査 | 2026-10-23 21:24:25.767 JST |
| コンテナ正常停止 | 2026-10-23 21:24:26.475、exit=0、restart count=0 |

最低2時間到達時に観測を完了とし、監査・証拠回収前の実sampleまでを最終評価窓に含めた。最低2時間到達後の21:24台にもSui失敗が1件あり、これを除外せず最終値に含めた。監視途中の797/96等の表示と最終797/98のSui母数差はこの追加の通常周期による。正常時だけを選んで終了していない。shutdownのsampleは評価窓外として生データに保持する。

通常60秒周期と既存の限定的な5分境界再確認を維持した。停止中もengine.tickが市場取得・分析を行い、停止ゲートで注文前に終了する。開始間隔の最大は60,006ms、記録周期124（START/END各124）、正常120・失敗4、正常率96.7742%。WAIT分析120と未評価4を区別する。周期時間P50/P95/P99は2,766 / 14,598 / 20,184ms、最大21,262ms。正常率の分母は保存済みの実周期であり、全予定slotの独立した完全ログではない。

既存ValidationRecorderは24時間セッション未開始時に試行を永続化しないため、[観測用preload](../scripts/preflight-observer.mjs)でattempt/cycle/sample通知をJSONLへ複写した。元メソッドには同じ引数を渡し、戻り値・取得周期・売買ゲートは変更していない。imageは固定のまま、read-only bindしたpreloadを最初からcommandに指定。追加I/Oと読み取り専用SQLite監視の負荷があるため、既定entrypointだけの無計測実行とは区別する。観測コード自体のhashも開始・終了で一致した。

API onAttemptだけを実通信の分母とし、retryは別試行、cache・flight共有・ローカルGETは分母外。分位点は実保存latencyMs全件からnearest-rankで計算し、失敗のtimeout時間も含めた。追加のホスト/コンテナ診断は別プロセス・別ファイルで管理し、以下の試験母数には足していない。

## 3. DeepBook通信結果

| 実試行 | 成功 | 失敗 | 成功率 | retry試行 | P50 / P95 / P99 / 最大ms |
| ---: | ---: | ---: | ---: | ---: | --- |
| 797 | 796 | 1 | 99.8745% | 1 | 269 / 1185 / 6064 / 8003 |

5分・15分・1時間足、板、Indexer status、欠損証拠取得を通常経路で観測した。1失敗はMARKET_STATUSのUPSTREAM_TIMEOUT、HEADERS_OR_CONNECT、HTTP status未取得、接続再利用中。TCP/TLS/本文timeoutと断定できる独立証拠はない。明示DNS失敗・CONNECT/TLS/BODY分類・HTTP429は今回の保存試行では0件だが、曖昧な段階の1件を「それらは発生しなかった」と保証する材料にはしない。

次のattempt=1が7,760msで成功し、同じ取得周期も成功した。失敗終了と次試行の推定開始の差は約1,098msで既存1〜1.25秒backoffと整合する。backoffの独立spanがないため推定値として扱う。追加retry上限2回・1要求8秒・全体45秒は変更していない。最大連続失敗1。成功試行のendpoint別内訳は既存ApiAttemptにoperationがないため確定できず、全API集計と足別の品質観測を区別する。

## 4. Sui gRPC通信結果

| 実試行 | 成功 | 失敗 | 成功率 | retry試行 | P50 / P95 / P99 / 最大ms |
| ---: | ---: | ---: | ---: | ---: | --- |
| 98 | 93 | 5 | 94.8980% | 0 | 360 / 8015 / 10006 / 10006 |

失敗はUPSTREAM_TIMEOUT 3、UPSTREAM_DNS_FAILED / EAI_AGAIN 2。DNS以外の3件はHEADERS_OR_CONNECTで、DNS・TCP・TLS・応答待ちの個別時間へ分解できない。HTTP statusは全失敗で未取得。最大連続失敗2で、2件のDNS失敗が同じhealth周期内に連続した。これはSUI/USDCの別metadata readでありretry2回ではない。1要求10秒、Suiに無条件retryを追加していない。

124周期のうち75周期はhealthキャッシュから正常復帰し実通信なし。残る49周期でmetadataを各2回読み取り、98実試行と一致する。実通信なしの75周期を通信成功として水増ししていない。異常後の既存fresh復旧読取も通常の実装挙動として記録した。終了時は最後のhealth周期が失敗し、DEGRADED / resumePending=false。単一metadataの後続成功があっても、health全体・正常市場周期の復旧とは判定しない。

## 5. データ品質

各正常周期の全timestampについて確定・整列・連続性を再確認し、最終DBの価格・OHLC・出来高の数値整合も独立に確認した。不正な保存足0件。元のengineによるOHLC検証は全正常周期で通過した。

| 時間足 | 正常品質観測 | 最終本数 | 最終確定足終了 | 終了時年齢秒 / 既存上限秒 | 現在未解決 | 連続性異常 |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| 5分 | 120 | 1001 | 2026-10-23 21:20:00.000 JST | 261.660 / 360 | 0 | 0 |
| 15分 | 120 | 672 | 2026-10-23 21:15:00.000 JST | 561.660 / 960 | 0 | 0 |
| 1時間 | 120 | 168 | 2026-10-23 21:00:00.000 JST | 1461.660 / 3660 | 0 | 0 |

5分足の累積unique欠損3本（1792456800、1792724700、1792726500）は3本ともNO_INDEXED_TRADES証拠で再構築。現在窓はraw999＋再構築2＝1,001本、未解決0。残る1本が取得範囲外へ移動したことと、未解決へ戻ることを区別した。再構築失敗観測0、再構築時間P95 309ms、最大2188ms（45秒以内）。15分/1時間の欠損・未解決は各0。証拠はIndexerの空trade応答とindexedThroughであり、独立オンチェーン監査ではない。

正常120周期の板年齢P50/P95/P99/最大は255 / 356 / 407 / 452msで、取得完了時は10秒以内。Indexer遅延P95/最大は2,000 / 2,000ms。最終正常市場周期は2026-10-23 21:23:11.078 JST。

**終了snapshotの板年齢は70803msで10秒条件を満たさない。** 最終周期はSui読取で中断し、新しい市場データを取得していない。古いprovider statusのhealthy=trueを、その周期の通信正常や終了時の新鮮な板と扱わない。ローソク足の年齢上限内・現在未解決0と、板・Sui・全体周期の正常性は別に判定する。

## 6. 安全監視と整合性

- 実sample 487、最大間隔15025ms（45秒以内）。sample・全cycle START/END・CONTROL履歴で稼働/許可状態を照合。running=true、resumePending=true、ordersAllowedAtAnalysis=trueはいずれも0件。
- 意図しない注文・約定・候補・PAPER会計checkは各0、無許可再開0、CONTROLイベント0。起動はPROCESS_RESTART_STOPPED 1件のみ。Bot実稼働時間0。
- Profit Guard無効sample 0、設定hash/image/build変更0、bot_settings更新0、validation_session=null、validation_events=0。24時間計測・PAPER開始・RESET・緊急停止解除は送っていない。
- query_onlyの独立読み取り接続で定期integrity_check 122回すべてok、最終監査もok。正常停止後の退避DBでもreadOnlyのintegrity_check=ok、周期248行・注文/約定0を再確認。台帳ledger.ok=true、理由なし。残高は開始/終了ともUSDC100、SUI0、costBasis/fees/realized各0。
- DB周期監査248行＝124組、成功分析120＝strategy_decisions120、失敗4＝risk_events4。API永続証拠797/98と、独立GET operationsのrequests counter797/98が完全一致。cache/診断値は含めていない。
- 0約定なので実約定時のPAPER会計・停止競合の実運用経路は未行使。ledger.okを実約定の検証済みと読まない。

## 7. 障害と原因分析

全時刻は2026-10-23 JST。retry列は当該失敗試行のattempt index（初回0）。HTTP statusは全件未取得。次API成功は同APIの後続試行であり、同一coin・同一要求やhealth全体の復旧を保証しない。

| 発生時刻 | API / operation | コード / 段階 / cause | 応答時間ms | retry | 次API成功 | 次の正常市場周期 |
| --- | --- | --- | ---: | ---: | --- | --- |
| 19:28:20.026 | Sui / SUI_GRPC_READ | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT | 10006 | 0 | 19:28:22.867 | 19:29:26.871 |
| 19:55:19.892 | Sui / SUI_GRPC_READ | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT | 10003 | 0 | 19:55:20.802 | 19:55:43.649 |
| 20:25:17.763 | DeepBook / MARKET_STATUS | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT | 8003 | 0 | 20:25:26.621 | 20:25:29.002 |
| 20:36:17.670 | Sui / SUI_GRPC_READ | UPSTREAM_DNS_FAILED / DNS / EAI_AGAIN | 8015 | 0 | 20:37:11.042 | 20:37:13.964 |
| 20:36:25.714 | Sui / SUI_GRPC_READ | UPSTREAM_DNS_FAILED / DNS / EAI_AGAIN | 8009 | 0 | 20:37:11.042 | 20:37:13.964 |
| 21:24:19.378 | Sui / SUI_GRPC_READ | UPSTREAM_TIMEOUT / HEADERS_OR_CONNECT | 10004 | 0 | 21:24:21.187 | 未観測 |

障害直前・直後の独立した正常市場周期の品質：

| 障害時刻 | 直前正常周期 / 足品質 / 板年齢 | 直後正常周期 / 足品質 / 板年齢 |
| --- | --- | --- |
| 19:28:20.026 | 19:27:19.355 / 5分未解決0、15分/1時間未解決0/0、板275ms | 19:29:26.871 / 5分未解決0、15分/1時間未解決0/0、板238ms |
| 19:55:19.892 | 19:54:11.786 / 5分未解決0、15分/1時間未解決0/0、板279ms | 19:55:43.649 / 5分未解決0、15分/1時間未解決0/0、板250ms |
| 20:25:17.763 | 20:24:12.381 / 5分未解決0、15分/1時間未解決0/0、板282ms | 20:25:29.002 / 5分未解決0、15分/1時間未解決0/0、板245ms |
| 20:36:17.670 | 20:35:13.089 / 5分未解決0、15分/1時間未解決0/0、板221ms | 20:37:13.964 / 5分未解決0、15分/1時間未解決0/0、板260ms |
| 20:36:25.714 | 20:35:13.089 / 5分未解決0、15分/1時間未解決0/0、板221ms | 20:37:13.964 / 5分未解決0、15分/1時間未解決0/0、板260ms |
| 21:24:19.378 | 21:23:11.078 / 5分未解決0、15分/1時間未解決0/0、板221ms | 観測終了まで正常周期なし |

失敗4周期はframes空・analysis=nullであり、以前のqualityを新規観測に加えていない。最後の21:24台失敗後は正常周期未観測のまま検証を終了した。失敗試行6件、失敗周期4件、複数層のERROR/ANOMALYイベントを足して障害総数にしていない。

最初のSui timeout後、WindowsとDockerの別プロセスでhealthを各1回だけ実行し、各2 readとも成功した（Windows 554/284ms、Docker 458/346ms、19:29台）。DNS障害後の20:55台には両環境で標準DNS lookupを各1回実行し、Windows79ms、Docker15msで成功。これら4 gRPC診断readとDNS診断は上記試験母数から除外した。障害瞬間の同時比較ではないためDocker固有障害やWindows側正常を証明しない。

EAI_AGAINは当該Dockerプロセスの名前解決で一時エラーを観測した証拠。Windows/Docker DNS forwarding、ネットワーク経路、プロキシ/セキュリティ製品、上流側のどこが原因かは特定できていない。DeepBookではreusedConnection=trueだが、それだけで再利用実装の不具合とは断定できない。準備ビルドでもnpm配布元の一時取得失敗があり、同じ設定での再試行は成功した。これは準備時の別事象で、DeepBook/Sui成績には含めない。

## 8. 未解決リスク

1. Sui実通信98試行で母数未達、実測成功率94.8980%・周期正常率96.7742%も未達。DNS2件と曖昧なtimeout3件の根本原因は未確定。
2. 最後のhealth周期の正常復旧を観測できずDEGRADEDで終了。板snapshot70.803秒経過。現在欠損0やHTTPサービスhealthyだけでGOにしない。
3. 成功要求のoperation別・共通request/cycle ID、SuiのDNS/TCP/TLS全段階の独立span、backoff全実時間は不足する。HEADERS_OR_CONNECTを都合よく分類し直していない。
4. 追加の観測preload・ファイルI/Oの影響は完全には分離していない。再構築証拠はIndexer由来。注文・約定経路は未行使。
5. 通常60秒周期と120秒healthキャッシュでは、正常でも2時間で100実試行を下回り得る。今回の98には異常後の既存fresh確認も含まれ、正常時の必要観測時間はさらに長くなり得る。

## 9. 合否判定

| 要件 | 結果 | 判定 |
| --- | --- | --- |
| 2時間以上の連続実測 | 02:01:31.689、487 sample | PASS |
| DeepBook100試行以上・成功率99%以上 | 797、99.8745% | PASS |
| Sui100試行以上 | 98 | INCONCLUSIVE |
| Sui成功率99%以上 | 94.8980% | 未達 |
| 市場取得周期正常率99%以上 | 120/124＝96.7742% | 未達 |
| 現在の未解決足0・確定/連続性 | 全3足0、正常120観測で連続性異常0 | PASS（最後の新規市場取得は失敗） |
| 全時間足・板の鮮度 | 足は上限内、正常取得時の板は正常、終了時板70.803秒 | 未達 |
| 重大整合性異常なし | integrity/ledger正常、全件照合一致 | PASS |
| 無許可再開・不正注文0 | 全件0、Bot停止維持 | PASS |
| 固定SHA・実image ID一致 | 開始・実行中・終了一致、再起動0 | PASS |

**依頼の「通常周期で100試行未満ならINCONCLUSIVE」により総合表示をINCONCLUSIVEとする。ただし母数不足以外にも実測の未達があるため、第2回24時間テストへの移行判断はNO-GO。** 失敗を長時間の成功で希釈したり、今回の窓を切り直してGOにはしない。

## 10. 第2回24時間テストへの推奨対応と成果物

まずDNS一時障害と段階不明timeoutを、障害時刻に合わせたWindows/Dockerの読み取り専用診断で切り分ける。Suiの段階計測が必要なら別の実装修正・回帰確認として行う。Windowsネットワーク・安全閾値・timeout・retry条件の変更は今回実施しておらず、次の対応でも無断変更しない。

原因対策後に新しい独立環境・固定版で再試験する。キャッシュを無効化せず100試行を確保できる観測時間を事前に設定し、今回の失敗履歴を上書きしない。100試行・99%以上・周期99%以上・終了時の全足/板/gRPCと台帳の正常性を実測で満たした後にGOを再審査する。**24時間PAPERテストもBotも開始していない。将来GOでも24時間開始には別途承認が必要。**

検証コンテナだけを正常停止し、専用DB/report volume・新規secret・固定imageは証拠保全のため残した。自動再起動なし。既存3100/3101は継続中。PAPER_RUN2_READINESS.mdとUIのNO-GOは変更していない。

集計成果物：[PAPER_RUN2_PREFLIGHT_RESULTS.json](PAPER_RUN2_PREFLIGHT_RESULTS.json)。再集計：[summarize-preflight.cjs](../scripts/summarize-preflight.cjs)、独立監査：[preflight-audit.cjs](../scripts/preflight-audit.cjs)、観測：[preflight-observer.mjs](../scripts/preflight-observer.mjs)。

生データは実施worktreeのGit管理外 docker/artifacts/preflight-8b05f2a/ と専用report volumeに保存した。JSONL全1,508行＝observer1＋API895＋cycle124＋sample488（評価内487・shutdown時1）。API6失敗を全件掲載し、独立DB監査の件数・counter・hashと照合済み。大きな生ログや認証値はコミットしない。

| 証拠 | SHA256 |
| --- | --- |
| evidence-final.jsonl | fd22a73695a3a4e9a707c87cc84049290513db28d6c574b9b0fb69bc156769a4 |
| audit-final.json | fa50b0ecffaa236281a28225e219e4abbd7cd55fad100065a87892190dfd4798 |
| inspection-final.json | ed62a8c397b1d65a30668e992d89f334f013760443f7804dceaca9fa20484938 |
| 実行observer.mjs | c1f91da5ca8b199406999f270b1829b34b69ef8596ad7e41409e55565f0ecbf4 |
| db-final/deepbook-paper.sqlite（正常停止後） | 6e341d5452fc6ab367c6d1d0e3ace9d8467ab2902e4fb5182526eb635709ab0e |

再集計例（アプリルート）：

```powershell
node scripts/summarize-preflight.cjs docker/artifacts/preflight-8b05f2a/evidence-final.jsonl docker/artifacts/preflight-8b05f2a/audit-final.json docker/artifacts/preflight-8b05f2a/inspection-final.json data/preflight-recomputed.json
```

この報告のコミットは文書・集計結果・観測/再集計補助スクリプトのみ。実行imageの固定SHAは8b05f2aのままであり、報告追加後のmain SHAを実測済みimageのSHAへ読み替えない。
