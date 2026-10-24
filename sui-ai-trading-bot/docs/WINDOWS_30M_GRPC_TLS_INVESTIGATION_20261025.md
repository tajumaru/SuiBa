# Windows無人30分検証：Sui接続タイムアウト調査

調査日：2026-10-25 JST。原因調査のみ。アプリコード、タイムアウト、安全停止条件、設定、DB原本を変更していない。PAPER/LIVE運用・注文・検証セッションは開始していない。

## 結論

**直接の失敗は、新規IPv4接続でDNS/TCP確立にも時間を消費し、TLS完了前に既存の要求期限10秒へ到達したこと。上流、Windowsホスト、Docker/WSLのいずれが遅延を発生させたかは、既存証跡だけでは確定できない。**

- HTTP要求6件の失敗が、SUI/USDC各2要求 × healthチェック3回として現れ、`SUI_READ_FAILED` の市場サイクル3連続失敗となった。HTTP再試行6回ではない。全要求の `attempt=0`、retry=0。
- `TLS` は期限切れ時に最後に観測された接続段階。TLSハンドシェイクだけが10秒かかったという意味ではない。第1失敗はDNS 2,762ms + TCP 6,496msで約9.26秒を消費している。
- 対象runの10要求すべて `reusedConnection=false`、接続IDは1〜10。成功した4要求はHTTP/1.1。プールが存在しないとは言えず、再利用されなかった理由も未確定。
- SQLite同期処理とイベントループ遅延には時間的な関連がある。ただし失敗した各要求の10秒窓内で記録されたSQLite区間の和集合は50〜156ms。SQLite最大573msは停止処理中であり、最初の通信障害の原因にはならない。
- 3連続失敗をWindows監視が検知して専用コンテナを停止した経過は設計と整合する。プロセス終了コード0は監視側のFAILを否定しない。

## 1. 対象と証拠の由来

| 項目 | 値 |
| --- | --- |
| 最新mainの取得 | `git fetch origin main` 実施。取得時のorigin/mainは対象SHAと一致 |
| 基点SHA | `70ca8da7742dc032b0edcc2c31ee902fe765b72a` |
| 調査ブランチ | `codex/investigate-windows-grpc-tls`（既存UI変更とは別worktree） |
| Run ID | `winverify-20261024T223226112Z-70ca8da` |
| 検証イメージ | `sha256:36272d4ccfe4eca5ef10e4be0a8e5e3b7afb26c00dc6415624f4022ae5acccb0` |
| Node | Linux v24.22.1 |
| 開始〜レポート終了 | 2026-10-25 07:34:25.404〜07:42:00.930 JST（455.527秒） |
| 原本の所在 | `tools/windows-verification/runs/<Run ID>/`（ローカル保存、Git対象外） |

本書の時刻は特記のない限りJST。同日のUTCは9時間前（2026-10-24）。イベントのJSONは元のepochミリ秒を保持する。

使用した原本は `evidence/preflight-evidence.jsonl`、`sqlite-timing.jsonl`、`event-loop-spikes.jsonl`、`audit.json`、`inspection.json`、`reports/report.md`、`logs/monitor.log`。さらに停止済みコンテナの `/app/validation/deepbook-paper.sqlite` を `docker cp` でコピーし、Python sqlite3の `mode=ro` で接続した。原本へのSQL書込みはない。停止後のコピーはDB単体で、整合性確認結果は `ok`。

レビュー用に内容を限定した[解析証拠JSON](evidence/windows-grpc-20261025/analysis.json)を収録した。HTTP層10件、API実試行10件、サイクル9件、遅延スパイク11件、SQLite上位10件、元ファイルのSHA-256、イメージ内ソースの照合結果を含む。DB、secret、管理トークン、リクエスト本文、実環境の全設定はPRに含めない。

イメージ内の `sui-client/index.ts`、`diagnostics.ts`、`shared/api.ts`、`database/index.ts`、`worker/operations.ts`、`engine.ts` の6ファイルは、対象SHAのGit blobをWindowsチェックアウトと同じCRLFへ変換するとSHA-256がすべて一致した。Git blobそのもののLFバイト列とはハッシュが異なる点もJSONに明記した。

## 2. DNS・TCP・TLSの時系列

下表は `sui_observations` のHTTP層（39観測中10件）とpreflight APIイベントを照合したもの。終了時刻はHTTP観測の記録時刻であり、deadline発火時刻とは数百msずれる。DNS/TCPはソケットイベント間の区間時間。

| HTTP観測時刻 | Coin | 接続ID | API実試行ms | DNS ms | TCP ms | TLS完了ms | 結果 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 07:34:32.749 | SUI | 1 | 544 | 71 | 34 | 80 | HTTP200 / h1 |
| 07:34:33.214 | USDC | 2 | 392 | 131 | 51 | 68 | HTTP200 / h1 |
| 07:37:11.014 | SUI | 3 | 602 | 131 | 42 | 95 | HTTP200 / h1 |
| 07:37:11.495 | USDC | 4 | 419 | 173 | 65 | 66 | HTTP200 / h1 |
| 07:40:20.617 | SUI | 5 | 10001 | 2762 | 6496 | 未完了 | TLS段階で期限切れ |
| 07:40:30.876 | USDC | 6 | 10002 | 135 | 3237 | 未完了 | TLS段階で期限切れ |
| 07:40:50.448 | SUI | 7 | 10001 | 4 | 5328 | 未完了 | TLS段階で期限切れ |
| 07:41:00.741 | USDC | 8 | 10001 | 5900 | 2403 | 未完了 | TLS段階で期限切れ |
| 07:41:20.702 | SUI | 9 | 10001 | 3 | 4076 | 未完了 | TLS段階で期限切れ |
| 07:41:31.138 | USDC | 10 | 10003 | 120 | 7549 | 未完了 | TLS段階で期限切れ |

失敗6件はすべて `family=4`、`tcpAttempts=1`、`available=true`、`httpStatus=null`。`secureConnect` は未観測で `tlsMs` とprotocolが存在しない。証明できるのは「IPv4 TCP接続イベントは観測したがTLS完了は観測できなかった」まで。ClientHello送信、ServerHello受信、再送、証明書交換の位置はパケット未採取のため不明。証明書不一致エラーやTLSアラートの記録もない。

**DNSだけを原因にできない。** 3〜4msでlookupを終えた要求も失敗している。一方、2.762秒/5.9秒のlookup遅延があるので、DNSを無関係とも言えない。これらはJSでイベントを受け取った時刻であり、DNSサーバー内部処理時間や純粋なパケット往復時間ではない。ホストのスケジューリング停止も混ざり得る。

### 20秒の診断値と10秒の要求期限

`ReadOnlySuiClient.health()` は `Promise.allSettled([metadata(SUI), metadata(USDC)])` を呼ぶが、`ApiAccess.run()` は同じAPI名の `tails` により直列化する。Suiへの実送信は2本同時ではない。

`http()` はキューへ入る前にtraceを作成する。一方 `AbortSignal.timeout(10000)` とAPI試行時間はキュー通過後に開始する。そのためUSDC側の `transportTimings.totalMs` は20,321/20,300/20,442msとなる。HTTP層の最終snapshotはさらに同期保存などを含み20,500/20,517/20,802ms。この値はTLS時間でも1要求のtimeout延長でもない。

失敗時HTTP観測の `phaseElapsedMs` は982/6806/4892/1913/6286/2688ms。これもfailure生成時から後の同期保存時間を含み得る。DNS+TCP+この値をAPI試行10秒へ厳密に合算しない。分類は `UPSTREAM_TIMEOUT`、終了時phaseはTLSで、TLS固有の例外を6件検出したという意味ではない。

## 3. SDK・fetch・接続プール

実際の経路は以下のとおり。

```text
BotEngine.tick → monitor.request(HEALTH) → ReadOnlySuiClient.health
  → metadata(SUI/USDC) → SuiGrpcClient.getCoinMetadata
  → @mysten/sui GrpcWebFetchTransport
  → @protobuf-ts/grpcweb-transport（POST / gRPC-Web）
  → ReadOnlySuiClient.http → apiFetch → ApiAccessのAPI別キュー
  → rawFetch（globalThis.fetch.bind）→ Node内蔵Undici → TLS/TCP
```

根拠：[sui-client](../packages/sui-client/src/index.ts)、[受動診断](../packages/sui-client/src/diagnostics.ts)、[共通API](../packages/shared/src/api.ts)、`@mysten/sui@2.37.0` のインストール済み `src/grpc/transport.ts`、`@protobuf-ts/grpcweb-transport` の `grpc-web-transport.js`。SDKが上流のfetch transportへ委譲し、その `fetch` をアプリが差し替えていることをソースで確認した。

- native gRPC/HTTP2クライアントや `@grpc/grpc-js` の常時接続経路ではない。成功4件の観測protocolは `h1`。
- アプリはSui向け独自Agent/dispatcherを設定していない。Node fetchの既定dispatcherにプール管理を委ねている。`rawFetch.bind()` が1要求ごとに新しいプールを作る実装ではない。Nodeの[公式fetch説明](https://nodejs.org/download/release/v24.22.1/docs/api/globals.html#fetch)も参照。
- プールの最大接続数・idle timeout・サーバー応答のkeep-alive情報・socket close理由は保存されていない。接続ID1〜10が別であることは確定だが、プール不具合の証明にはならない。
- health成功は120秒キャッシュされる（`apiFetch` のTTLは0）。実HTTPは07:34:32〜33、07:37:11、07:40:10以降に偏る。この間隔と、SUI→USDCの2要求も別ソケットだったことを両方説明する必要がある。「idle timeoutだけが原因」とは断定しない。
- 失敗要求は新規ソケットなので、「古い接続を再利用したためTLSが失敗した」という直接の説明は証拠に反する。再接続が頻発して遅い経路に露出した可能性は残る。
- DeepBookは[独自のnode:http2 transport](../packages/market-data/src/deepbook-transport.ts)で既存sessionを再利用し、120秒idle/GOAWAY/abortを扱う。Suiとは別origin・別プロトコル・別接続寿命であり、対照条件が一致しない。

## 4. Docker・Windows・上流の切り分け

当時の検証コンテナはNode v24.22.1、DBとレポートはDocker named volume。DBをWindows bind mount上へ置いた構成ではない。OOMなし、再起動0回、メモリ最大約142.5MiB。保存ログから全体的なネットワーク断、CPU飽和、メモリ圧迫を断定できる証拠はない。

**DeepBook 50/50は同時対照ではない。** 最後のDeepBook実試行成功は07:39:12.733で、最初の失敗したSui要求開始07:40:10.380より前。`tick()` はSui healthを先にawaitするため、その後の失敗サイクルはframesを取得しない。失敗cycleに残る `market.healthy=true` は以前のprovider状態であり、同時刻にDeepBookが接続正常だった証拠にはならない。

### 停止後の低負荷診断（当時の障害再現ではない）

取引アプリを起動せず、`node:tls.connect` で両originへ各3回、新規TLS接続だけを行った。検証と同じ10秒で打ち切り、証明書検証は有効。ホストは07:51:10〜12、Dockerは07:51:42〜43に実施。Dockerは当時の固定イメージ、別の一時コンテナ・標準bridge・secret/DB/運用volume接続なし。

| 現在の診断 | Node | Sui TLS完了 | Sui総時間ms | DeepBook TLS完了 | DeepBook総時間ms |
| --- | --- | --- | --- | --- | --- |
| Windowsホスト | v24.14.0 | 3/3 | 710 / 119 / 121 | 3/3 | 573 / 117 / 138 |
| 固定Dockerイメージ | v24.22.1 | 3/3 | 336 / 140 / 125 | 3/3 | 141 / 129 / 147 |

生データ：[Windows](evidence/windows-grpc-20261025/current-host-tls.jsonl)、[Docker](evidence/windows-grpc-20261025/current-docker-tls.jsonl)。計測方法はlookupイベントまでをDNS、lookup→connectをTCP、connect→secureConnectをTLSとして `performance.now()` の差分をms丸め。新規ソケットを3回ずつ順番に接続して終了した。HTTP/gRPC送信、fetch接続プールは検証していない。

現在のDockerはDesktop/WSL2、kernel `6.18.54.1-microsoft-standard-WSL2`、Engine29.9.1、12 CPU、メモリ約15.5GiB。ホストはWi-FiとWSL仮想NICがUp、EthernetはDisconnected。シェル環境にPROXY/NODE_OPTIONS系の変数名は検出されなかった。これらは停止後の現在値であり、当時のWi-Fi品質、Windows/WSL firewall、VPN、Docker Desktop内部proxy、セキュリティ製品の状態を除外する証拠ではない。

この診断は「その後は両側から新規TLSを完了できた」ことだけを示す。時刻、Node版、ALPN条件、アプリ負荷が揃っておらず、Windows対Dockerの因果比較や継続安定性の合格判定には使えない。

## 5. SQLiteとイベントループ

DB実装は `node:sqlite DatabaseSync`、`journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=0`。同期SQLiteは同じJSスレッドを占有するため、複数の保存が連続するとネットワークのイベント処理やタイマーを遅らせ得る。FULLのcommitやautocommit時のストレージ待ちを疑う余地はあるが、fsyncそのもの・WSL仮想ディスク待ち・GC・CPUスケジューリングは個別計測されていない。

| 観測 | 解釈 |
| --- | --- |
| 詳細SQLite356件、失敗/BUSY/LOCKEDなし | ロック競合・書込み例外による停止ではない |
| 最大event-loop 2466.251ms、窓07:35:11.661〜14.913 | set423.579ms等の同期保存が重なる。サイクルは成功しており後の失敗の必要十分条件ではない |
| 最大set573.326ms、07:41:57.477〜58.050、key=paper_safety | 最初の失敗より約97秒後、監視の停止検知より約13秒後。初発原因の説明には使えない |
| transaction/saveCandles 175.228ms中commit165.466ms | 少なくともこの書込みはcommit区間が支配的。ディスク原因の確定ではない |
| 計測SQLite writer flush合計12.421ms/最大0.558ms | 詳細計測writer単独で秒単位スパイクを説明する証拠は弱い |

失敗要求の `failure.startedAt〜endedAt` と詳細SQLiteレコードの区間を交差し、親transactionと子SQLが重複する部分を区間和集合にして計算した。

| 要求開始(JST) | 記録SQLite占有ms | 重複レコード数 |
| --- | ---: | ---: |
| 07:40:10.380 | 87 | 1 |
| 07:40:20.697 | 133 | 2 |
| 07:40:40.228 | 65 | 1 |
| 07:40:50.523 | 156 | 2 |
| 07:41:10.341 | 50 | 1 |
| 07:41:20.776 | 120 | 2 |

算式は各SQL区間 `[max(requestStart, sqlStart), min(requestEnd, sqlEnd)]` の正長区間をソート・マージし、長さを合計。wall時刻のms丸めを使う。これは未計測I/Oや全JS停止を含む総占有率ではない。

失敗後の07:40:29.905〜31.711、07:40:59.716〜41:01.607、07:41:29.905〜32.521のスパイクは、失敗記録や安全状態の同期保存と重なる。同期保存が失敗後の処理を長くする可能性はあるが、ネットワークタイムアウトを引き起こしたと逆向きに推論しない。累積event-loopの最大2455.765msと詳細の2466.251msは別histogram/採取窓の値で、取り違えない。

`preflight-observer.mjs` の `appendFileSync` とread-only DBのopen/count/integrity_checkなど、SQLite詳細sinkが直接カバーしない同期処理もある。同期処理全体の無関係を証明したわけではない。

## 6. 安全停止は設計どおりか

| 時刻(JST) | 証拠 |
| --- | --- |
| 07:39:13.834 | 6回目の市場サイクル成功（最後の成功） |
| 07:40:31.643 | 7回目失敗、`SUI_READ_FAILED`、21,531ms |
| 07:41:01.541 | 8回目失敗、同21,431ms |
| 07:41:32.447 | 9回目失敗、同22,224ms、3連続 |
| 07:41:44.538 | 監視が `CYCLES_FAILED_3_CONSECUTIVE` を検知 |
| 07:41:55（ログ秒精度） | 証跡収集後、専用projectのstop要求 |
| 07:41:58.774 | Docker State.FinishedAt、ExitCode0、OOMKilled=false |
| 07:42:00.930 | レポート最終化 |

[Verification.Common.ps1](../tools/windows-verification/lib/Verification.Common.ps1) の `Get-SuiBaEvidenceFacts` は成功で連続失敗カウンタを0へ戻し、末尾の失敗3件を数える。`Test-SuiBaAbortCondition` は `ConsecutiveFailedCycles >= 3` を停止理由にする。最後の成功から5分経過するより先にこの条件が成立した。

[Invoke-SuiBaVerification.ps1](../tools/windows-verification/Invoke-SuiBaVerification.ps1) は監視ループを抜け、FAIL対象を終了コード2として最終化する。検知から実コンテナ終了まで約14.24秒、3回目サイクル終了から約26.33秒。`Finalize-SuiBaRun` が監査・証拠コピー・ログ・集計をstopより先に実行するため、検知とコンテナ停止は同時ではない。この遅延も監査上明記する。今回の実行は元々 `running=false` であり、その間の取引開始はない。

注意：保存済み `inspection.json` はfinalize中のstop前に採取され、`Running=true` とある。停止の裏付けにはmonitor.logに加えて、今回読み取ったDockerの `State.FinishedAt=2026-10-24T22:41:58.773802959Z` / `Running=false` を使用した。

安全ゲートは別に動作する。`ApiAccess` は失敗時に `onTransientFailure` を先に呼び、`OperationMonitor.transientFailure` がDEGRADED・runtime.running=falseへ遷移する。最終監査もDEGRADED、resumePending=false、generation=7、runtime.running=false。サンプル30件でrunning=trueなし、注文/約定/会計記録/候補は0、セッションnull、整合性ok。これは今回の停止専用runに対する検証であり、実稼働中の注文キャンセル経路を実演した結果ではない。

## 7. 原因候補の強さと優先順位

| 優先 | 候補 | 証拠の強さ | 支持する証拠 / 未確定事項 |
| --- | --- | --- | --- |
| 1 | 新規接続経路の断続的遅延（上流LB/接続先、Wi-Fi/ISP、WSL/NAT/firewall等） | 接続確立遅延の存在は強い。責任区間は未特定 | 6件すべてTCP/TLS確立が遅い。DNSも一部遅い。停止後はhost/containerとも成功。パケット、接続先IP、同時host比較がない |
| 2 | Sui側の新規接続頻度・idle/接続寿命が不安定な確立経路への露出を増加 | 新規接続は強い。障害原因として中〜弱 | 10件すべて別ID、成功はh1。pool未設定ではなくdefaultに委譲。close理由・サーバーkeep-alive・pool occupancyがない |
| 3 | SQLite同期保存/ホスト停止がイベント配送を遅らせる増悪要因 | 保存とスパイクの関連は中。初発原因として弱い | 2.466秒スパイク。ただし通信失敗窓の記録SQLは50〜156ms。573ms最大は停止時。未計測同期I/O/GC/ホスト停止は残る |
| 4 | DNS単独障害 | 単独説明は弱い | 一部lookupが秒単位だが3〜4msの要求も同じく失敗 |
| 5 | 証明書不正・常設TLS設定ミス・古い接続再利用の直接バグ | 弱い / 一部は観測と不整合 | TLSアラート/証明書エラーなし。成功実績と事後成功あり。失敗したソケットは新規 |
| 除外に近い | SQLite BUSY/LOCKED例外、OOM、コンテナ再起動、HTTP429/5xxが直接引金 | 今回の記録で否定 | SQL失敗0、OOMなし、再起動0、HTTP応答前に失敗。ネットワーク経路全体の断続異常までは否定しない |

## 8. 次に必要な証拠（実装・条件変更の提案とは別）

1. 再発窓でホストとDockerを同時刻、同じNode v24.22.1、同じSui endpoint・gRPC-Web metadata要求で比較する。既存の10秒期限と注文禁止を維持し、TLS単独診断とfetch/SDK要求を分ける。単純なGET成功をgRPCの成功として扱わない。
2. 同期したpacket trace/ETW/WSL tcpdumpによりDNS問合せ、TCP SYN/再送、ClientHello/ServerHelloを確認する。接続先IP/IPv4、ソケットclose、接続ID、HTTP request ID、pool待ちを対応付ける。機微情報を含む生packetはそのままPR公開しない。
3. Windows/Wi-Fi・WSL仮想NIC・firewall/VPN・Docker proxyの状態変化、ホストCPUスケジューリング、VHDX/ディスク待ち、GCを同時記録する。現在の「成功した短時間probe」で除外しない。
4. SQLiteについてcommit/fsyncとホストディスク待ちを対応させ、親transactionとの二重合算を避ける。詳細observerの同期I/Oも含める。DB保護・同期設定は維持する。

既存の安全停止条件緩和、timeout延長、無条件retry追加、dispatcher/プール差替え、PAPER/LIVE開始は本調査では行わない。根拠の不足する原因を修正済みと扱わず、30分検証を合格へ変更しない。

## 9. 検証と再現性

- `origin/main`を取得し対象SHA一致を確認。PR差分は本書と証拠データだけ。
- コピーDB：read-only `PRAGMA integrity_check` → `ok`。HTTP観測10件とAPI実試行10件をcycleId/coin/時刻で照合。
- 固定イメージ、`--network none`、テストのみの一時コンテナで既存6ファイルを実行：`sui-diagnostics`、`sui-health`、`sui-observations`、`api-access`、`paper-recovery`、`market-scheduler`。**81 passed / 4 skipped**。skipはoffline設定で除外された実ソケット試験であり、その経路の成功を主張しない。Vite一時生成ファイルのため一時コンテナだけuser0で実行、元ソースのbind mountはread-only。
- Windows既存 `Invoke-SelfTest.ps1` を最新mainの分離checkoutから実行。停止閾値、専用project停止、safety、watchdogのassertionはPASS。**全体は2件FAIL**：`happy: COMPLETED is INCONCLUSIVE quality, not PASS`、`user stop produces incomplete report`。スタブのreport判定に関する既存不一致であり、本PRでは原因の確定・修正を行っていない。全テスト成功とは報告しない。
- 制限環境での初回self-testはスタブ実行周辺で追加失敗、初回VitestはVite一時ファイルの権限エラー。アクセス可能な実行条件で再実行した最終結果が上記。テストやアプリのコードは変更していない。

主要な確認コマンド（パスはリポジトリroot基準）：

```powershell
git fetch origin main
git rev-parse origin/main
pwsh -NoProfile -File sui-ai-trading-bot/tools/windows-verification/tests/Invoke-SelfTest.ps1
# DBは停止済み検証コンテナからコピー後、sqlite3.connect('file:<copy>?mode=ro', uri=True)
```

Vitestは対象イメージをentrypoint=node、network=noneで起動し、対象SHAのtestsと `vitest.offline.config.ts` をread-only mountして次を実行した。アプリentrypointは実行していない。

```text
node_modules/vitest/vitest.mjs run --config vitest.offline.config.ts
  tests/sui-diagnostics.test.ts tests/sui-health.test.ts tests/sui-observations.test.ts
  tests/api-access.test.ts tests/paper-recovery.test.ts tests/market-scheduler.test.ts
  --maxWorkers=1
```
