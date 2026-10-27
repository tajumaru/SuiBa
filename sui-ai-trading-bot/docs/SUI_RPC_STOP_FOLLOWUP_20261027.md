# Sui停止調査：実ソケット検証と停止経路の追加再現

元調査：[SUI_RPC_STOP_INVESTIGATION_20261027.md](SUI_RPC_STOP_INVESTIGATION_20261027.md)、ドラフトPR #23。追加対象main：`e90840d916166c58cc040d48e72f2aa606bd557f`。Node.js **v24.22.1**、Windows x64、Vitest 3.2.7、Sui SDK 2.37.0。

## 追加検証の目的と隔離

前回の全オフライン検証では、既存設定により実ソケット試験8件がskipされ、settings-api/deepbook-transportの2ファイルも対象外だった。原因調査の模擬再現には有効だが、timeout・中断・切断を実ソケットで確認する証拠が不足していたため、今回その範囲を追加した。

- 新規`vitest.loopback.config.ts`は6ファイルを対象とし、名前によるskipを設けない。前回skipした8件と対象外2ファイルをすべて含める。既存`vitest.offline.config.ts`とそのsocket禁止条件は変更しない。
- `node scripts/test-loopback.mjs`から実行する。テスト専用preloaderは**127.0.0.1 / ::1 / localhostだけ**をTCP接続・待受に許可し、外部host・非loopback IP・wildcard bindをDNS/接続前に拒否する。同ガードをNODE_OPTIONSで子processへ継承し、その継承もテストした。worker threadは明示的な`execArgv: []`でpreloadが落ちることを追加検証で発見したため、テストローダー内だけでWorkerを包み、元optionsを維持してguard preloadを付加した。CommonJS eval workerでは`--import`だけで適用されなかったため、Node24の`--require`でTLAのないESMガードを同期ロードする。chart-historyと同じeval/execArgv条件でもガードが入ることを確認した。
- `.env`は専用一時ディレクトリに作った空設定ファイルを指定。運用のADMIN_TOKEN/FILE、DB・address・Sui URL・port等の環境変数をテストランナーで引き継がない。TEMP/TMPもworktree内の新規専用ディレクトリ。
- settings-apiは**新規テストworker**を動的localhostポートで起動・再起動する。DBはその試験が作成する新規一時SQLite、認証値も試験が生成。既存Botの起動・停止・再起動・APIアクセスは行わない。`docker/healthcheck.mjs`はNodeのローカルHTTP確認スクリプトとして実行するだけで、Docker CLIやコンテナは使わない。
- テスト終了時のDBディレクトリ削除は既存settings-api試験の処理で、新規一時ディレクトリのみ。稼働DB・Docker volume・既存データへの操作はない。

初回sandbox実行では、localhostで待受はできても接続が`connect EACCES 127.0.0.1`となり、複数の実通信試験が失敗した。最小のローカルHTTP server/fetchで同じEACCESを再現し、ガードを維持したまま許可されたsandbox外実行に切替えたところ成功。製品コードや期待値を変更して解消したものではない。

## 前回skip／対象外だった試験

| 試験ファイル               | 前回未実行だった範囲                           | 今回の確認                                                                                                              |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| api-access.test.ts         | 実HTTP429、SDK内429、実HTTP停滞中断の3件       | Retry-Afterとretry、429の捕捉、期限でactive解除                                                                         |
| http-errors.test.ts        | headers前／body途中の期限、切断、部分本文の4件 | timeout分類、status保持、retryなし、部分JSONの非cache                                                                   |
| sui-diagnostics.test.ts    | loopback fetchの1件                            | 3要求だけでh1とconnection reuseを受動観測、追加要求なし                                                                 |
| deepbook-transport.test.ts | ファイル全体21件                               | 実HTTP/2再利用、GOAWAY後再接続、headers/body deadline、中断、HTTP429/5xx、短期cache。DNS/TCP/TLS段階は模擬sessionも含む |
| settings-api.test.ts       | ファイル全体1件                                | 一時workerで認証・設定・DB履歴・停止条件・restartを確認                                                                 |
| loopback-guard.loopback.ts | 新規4件                                        | 外部接続とwildcard bindの拒否、子processとexecArgv空のworker threadへのガード継承                                       |

対象6ファイル全体の74件は、実ソケット試験に加えて、分類・許可先・段階イベントの模擬試験も含む。74件すべてが実ネットワーク試験という意味ではない。HTTP/2 fixtureはlocalhostのh2cであり、本番HTTPS/TLSや外部Suiサーバーとの接続を検証したものではない。

## 追加した停止経路の5ケース

すべて`tests/paper-recovery-engine.test.ts`で実Engine・新規メモリDB・実ReadOnlySuiClientを使用し、注文／約定0を確認。本番の安全ロジックは変更しない。

| ケース                            | 再現方法／実際の確認結果                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sui429→同要求retry成功            | 実SDKに合成429を1回、その後正しいSUI/USDC metadataを返す。HTTP呼出し3回、health=trueまで回復してもruntime.error=UPSTREAM_HTTP_429、running=false、注文禁止。次の正常tickでも同じ停止理由を保持                                                                                                    |
| Sui片coin障害2周期→復旧           | 各cohortのSUIをEAI_AGAIN、USDCのHTTPは成功。市場frames未呼出し、DEGRADED・error=nullを維持。60秒時点の最初の正常cohortはRECOVERING、120秒時点の2回目でHEALTHY／PAPER再開。復旧遷移周期に注文なし                                                                                                  |
| Sui片coin障害4周期→復旧上限       | 0/30/60/90秒に同じ障害、120秒にhealth回復。それでも180秒時点でPAPER_RECOVERY_EXHAUSTED、running=false、注文禁止。単一HTTP成功やmetadata復旧でepisode上限を解除しない                                                                                                                              |
| health失敗の二重加算              | transport証拠のないSUI_READ_FAILEDをhealthから返す。1周期でapiErrors/consecutiveErrors=2（HEALTHとMARKET）。次周期で4となり、途中3に達した時点のCONSECUTIVE_API_ERRORSも記録。ただしruntimeは最初のSUI_READ_FAILEDを保持、lastStopReasonも最終SUI_READ_FAILED。障害数と監視イベント数は区別が必要 |
| 補助balanceとpending healthの競合 | SDK境界で2件のmetadata完了を保留し、補助balanceに整合したDNS障害証拠を注入。その後metadata両方を成功完了させてもepochが古いためhealth=false、frames未呼出し、DEGRADED／注文禁止。次の独立fresh cohort2回まで再開しない                                                                            |

連続障害の試験でUSDCのHTTP成功が入ると、ApiAccessのAPI単位consecutiveFailuresはリセットされる。一方health cohortは失敗し続け、PAPER episode上限はリセットされない。この2種類の連続失敗カウンターをダッシュボードで混同しない。

競合試験は決定的な完了順を作るためSDK boundary mockを使用する。実transportは同APIキューを直列化するため、この試験を「実ソケットで同じタイミングの競合を観測した」とは扱わない。既存のsui-health試験（古い成功・cache・balance成功による誤復旧の防止）も再実行した。

## 検証結果と再現コマンド

結果は[evidence README](evidence/sui-rpc-stop-20261027/README.md)と`loopback-vitest.json`、`offline-vitest-followup.json`に記録する。後者は最新main取り込み後の追加5ケースを含む全オフライン回帰。前回の`offline-vitest.json`は履歴として残す。

| 最終検証                         | 結果                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| localhost限定suite               | 6ファイル、74成功、失敗0、skip0                                   |
| 全オフラインVitest               | 69ファイル、983成功、失敗0、8skip（この8件は上のsuiteで別途成功） |
| 最終のEngine＋Sui health重点回帰 | 50成功、失敗0、skip0                                              |
| Node標準テスト                   | 45成功、失敗0                                                     |
| TypeScript                       | 型検査成功                                                        |

suite間には重複があり、74＋983等を独立した試験総数として加算しない。

```powershell
# 専用worktreeのsui-ai-trading-bot内、Node24.22.1
node scripts/test-loopback.mjs --reporter=json --outputFile=docs/evidence/sui-rpc-stop-20261027/loopback-vitest.json
New-Item -ItemType Directory -Force data/offline-tmp | Out-Null
$env:TEMP = (Resolve-Path data/offline-tmp).Path
$env:TMP = $env:TEMP
node scripts/run-project.mjs test:offline --reporter=json --outputFile=docs/evidence/sui-rpc-stop-20261027/offline-vitest-followup.json
node scripts/run-project.mjs typecheck
```

## 修正案の優先順位と残る限界

1. 先に用途・層・cohort・周期・初回停止理由と最終停止理由の対応を可視化する。特に、HTTPだけの成功／health失敗、片coin失敗、HEALTH/MARKET二重加算、過去のlastFailureを現在異常と誤解する表示を分離する。
2. 補助balance失敗の重大停止への波及を分ける案は妥当性を引き続き検討する。ただし同originのcooldown/429/Breakerは共有し、必須healthの新規確認前には注文を許可しない。単にclientを分けるだけでは共通callbackによる停止を防げない。
3. gRPC UNAVAILABLE等の一時障害扱いは、確定statusと今回cohortへの相関を必要条件にする別修正案。429、データ不正、証拠保存、SQLite、手動・緊急停止、復旧上限の緩和は行わない。

今回、前回未実行だった実ソケットの範囲は検証できた。ただし外部Suiへの実通信、Windows/Dockerの経路差、実TLS、上流rate limit、本番長時間運転は未検証。直近の稼働中停止に対応する新しいログエクスポートも未入手。既存の退避ログ5失敗／4周期の証拠と、今回の合成障害による再現を区別する。実運用の根本原因を解消済みとは判定しない。
