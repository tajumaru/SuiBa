# Sui gRPC通信耐久力：原因調査と改善案

調査日：2026-10-23 JST。対象main：`0e076ec2a21cb1239c1ebcc2b665ecbb379a0de2`。
対象実測：[PAPER_RUN2_PREFLIGHT_REPORT.md](PAPER_RUN2_PREFLIGHT_REPORT.md)。本書は調査・実装前の影響評価であり、通信設定・アプリ動作を変更した結果ではない。

## 結論

DNSの一時失敗2件は実測で確認できるが、Windows/Docker/上流のどこが根本原因かは未確定。残り3件のtimeoutは段階情報が不足する。無条件retryやtimeout延長より、既存の実通信を受動計測して原因を分けることを優先する。

別途、外部通信なしの模擬クライアントで以下を再現した。

1. **health失敗後に別のbalance/metadata読取が成功すると、health状態と120秒cacheがhealthyへ戻る。** 全health読取が復旧していなくても、次のhealthが未確認coinの再検証を省略する。
2. **HTTP200・gRPC status=UNAVAILABLEでも、現在のApiAttemptはsuccess=trueとなる。** HTTP本文受信完了、gRPC成功、metadata妥当性を別の結果として記録する必要がある。

これらは状態管理・計測の欠陥候補であり、過去5件の実通信失敗の原因と断定しない。既存の通信DEGRADED・generation・注文ゲートが別に存在するため、この再現だけで不正な取引が可能だったとは判定しない。実測の注文・約定・無許可再開0と矛盾しない。

第2回24時間PAPERのNO-GOを維持する。

## 1. 調査範囲と証拠保全

- 参照：既存報告・集計JSON、生JSONL、固定版ソース、SDK同梱資料、Node v24.22.1同梱Undiciのソース、公式資料。
- 3100/3101、検証DB、既存証拠ファイルは変更していない。新規調査出力はGit管理外 `data/grpc-investigation-20261023/` に分離。
- Bot起動、Docker/コンテナ起動・再起動、外部Sui/DeepBookへの新規診断要求、ネットワーク設定変更、24時間計測開始なし。
- Docker操作は停止済み検証コンテナのinspectと `/etc/resolv.conf` の読み取りコピーのみ。観測時のコンテナはexitedのまま。
- 生JSONL、最終監査JSON、停止後の退避SQLiteのSHA256は既存報告と一致（それぞれ `fd22a736…`、`fa50b0ec…`、`6e341d54…`）。この調査で以前の成績を上書きしていない。

## 2. 実際のtransportと接続管理

確認経路：

```text
ReadOnlySuiClient
  → @mysten/sui 2.37.0 / SuiGrpcClient
  → GrpcWebFetchTransport（@protobuf-ts/grpcweb-transport 2.11.1）
  → apiFetch("Sui gRPC") / apiAccess.run
  → Node global fetch（Undici）
```

`packages/sui-client/src/index.ts:16` のfetch指定と、SDKの `src/grpc/client.ts`、`src/grpc/transport.ts`、同梱 `docs/clients/grpc.md` を確認した。SDKはgRPC-Webが既定で、native gRPC/HTTP2の `@grpc/grpc-js` は別の選択肢。現アプリはnative transportを選んでいない。DeepBook専用 `node:http2` transportもSuiには使用していない。

同じ版のWindows Node実行物はv24.22.1 / Undici7.30.1。アプリにcustom dispatcher、allowH2、global dispatcher置換はなく、Node v24.22.1のconnector既定はallowH2=false。したがって現構成を「常時HTTP/2 gRPCチャネル」としてPING/GOAWAYだけ調べるのは適切でない。過去の実socket ALPN/protocolは未記録なので、実測済みprotocolであるかのように数値を作らない。[Node同版connector](https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/undici/src/lib/core/connect.js)

global fetchの接続管理はUndiciのorigin別poolに委譲される。Client既定idle keepaliveは4秒、server側のKeep-Alive指定等で変わり得る。health実通信は120秒cacheと60秒周期の組合せで約2〜3分間隔になるため、同じclientオブジェクトを保持することと同じTCP接続を維持することは別。過去ログにSuiのsocket ID・reuse・server keepalive情報がないため、再接続頻度やidle切断が主因だったとはまだ言えない。[Node同版Client](https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/undici/src/lib/dispatcher/client.js)

`apiAccess.run` は同APIのtailで直列化する。healthのPromise.allSettledによる2読取も通常このキューを通り、DNS2件はいずれもattempt=0。retryではない。10秒timeoutはqueue待機後に始まり、周期全体は既存45秒budgetに制限される。TLS session resumption cache、HTTP idle keepalive、TCP keepalive、HTTP/2 PINGは別物であり、一括で有効化しない。

## 3. WindowsとDockerの経路

今回、現在設定を読み取り確認した結果：

| 場所 | 確認内容 |
| --- | --- |
| Windows | active interfaceのIPv4 DNSは192.168.3.1。別active interfaceにはIPv6 resolver設定も存在 |
| 停止済み検証コンテナ | Compose専用network、`nameserver 127.0.0.11`、内部転送先コメントは192.168.65.7、`ndots:0` |
| コンテナ個別設定 | Dns/DnsOptions指定なし、ExtraHostsなし、proxy環境変数なし、NODE_OPTIONS / NODE_USE_ENV_PROXY指定なし |
| Docker Desktop設定JSON | 読み取った個別キーは未記録。nullを「特定の既定設定が有効」と解釈していない |

Windows側のOS resolverからの経路と、Linux側resolver→Docker内DNS→Desktop backend経由の経路は同一ではない。Docker公式資料も、Linux VM・仮想networkとWindows backend経由の外向き通信を説明している。現在の設定は障害瞬間のpacket captureではなく、転送先の存在だけでその機器を原因とは断定できない。[Docker Desktop networking](https://docs.docker.com/desktop/features/networking/)

次の承認済み実測では、実通信の失敗時に同時刻のWindows/Dockerのresolver結果・A/AAAA・採用family・TCP試行・TLS状態を比較する。常時追加pollや、診断先の固定IP化、IPv6無効化、DNS書換え、proxy回避は行わない。ホスト側の成功とコンテナ側失敗が同時観測できても、どの転送段階かはさらに切り分ける。

## 4. DNS/TCP/TLS/応答待ちの計測案

最初はtransport・poolを置き換えず、Node/Undiciの既存イベントを受動計測する。追加API要求0。Node版を固定し、取得できない段階はunknown/null、再利用時はnot-performedとして区別する。

| 段階 | 候補となる観測点 | 判定・注意 |
| --- | --- | --- |
| API queue | enqueue → attempt開始 | 現在のlatencyに含まれない待機を別計測 |
| 新接続/再利用 | undici beforeConnect/connected、sendHeadersのsocket ID | requestとconnectionの対応が不明なら推定で結合しない |
| DNS | net.client.socketで早期に購読し、socket.lookupの完了・error | OS cacheの内部時間と実DNS packet時間は分離できない。lookup自体を追加発行しない |
| TCP | lookup完了/connectionAttempt → connect、AttemptFailed/Timeout | IPv4/IPv6の複数attemptを1つのTCP timeoutに潰さない |
| TLS | connect → secureConnect、TLS error、ALPN | reused socketのTLS時間を0msとして分位点へ入れない |
| request送出/応答待ち | sendHeaders/bodySent → response headers | connect後の待ちとbody待ちを分離。bodySentは低レイヤー通知で、上流受領の証明ではない |
| HTTP body | headers → trailers/complete、apiFetch arrayBuffer完了 | HTTP statusが得られていれば本文timeoutでも保存 |
| gRPC結果 | UnaryCall response/status/trailersの解決/拒否 | HTTP200とgrpc-status=OK、decode、metadata validationを別記録 |

Nodeの `net.client.socket` とsocketイベント、Undiciのrequest/connection diagnosticsを組み合わせる。[Node diagnostics](https://r2.nodejs.org/docs/v24.8.0/api/diagnostics_channel.html)、[Undici7.30.1 diagnostics](https://raw.githubusercontent.com/nodejs/undici/v7.30.1/docs/docs/api/DiagnosticsChannel.md)

実装時は、Sui対象originだけをallowlistし、requestId/health cohort ID/cycleId、connection ID、単調時計、phase、HTTP/gRPC code、reuse/protocol/familyを記録する。request/headers/body/error全文や認証URLは保存しない。subscriberは同期・例外禁止で、bounded buffer/WeakMapを使い、ログI/Oはcallback外へ出す。connectionイベントはrequestとの結合が弱いため、曖昧な対応はunknownとする。HTTP/2が実際に有効な構成の場合だけsession/stream/GOAWAY等を追加する。

localhost専用HTTP fixture3要求で、現在のNodeからsocket生成、lookup、TCP attempt、connect、HTTP h1、headers、同socket再利用を観測できた（2socket、3要求）。Bot/外部APIは使用していない。TLS実測・Linuxでのイベント対応・timeout時のpool処理は未検証であり、実装前にfixtureを追加する必要がある。

## 5. 再現した状態管理・計測の問題

### 5.1 通常read成功がhealth cacheを更新する

`ReadOnlySuiClient.read()` はbalance/metadata/transactionの各成功時にstatusをhealthy=true、checkedAt=now、failures=0へ置き換える。healthは同じstatusを120秒cacheの根拠に使う。`/api/balances` も同じsuiインスタンスを使用する（READ_ONLY_ADDRESS設定時）。

模擬で「SUI metadata失敗・USDC成功 → health失敗 → USDC balance成功 → health再呼出し」を実行すると、最後のhealthはSUIを再確認せずcacheからhealthyを返した。metadataは計2回のままであり、balance成功だけで失敗を上書きしたことを確認した。metadata単体の後続成功でも同様。外部通信0。

改善案：全health cohortの成功だけでhealth cacheを更新する。通常readの成功/失敗時刻は別に保持し、通常read成功で失敗したhealthを治癒させない。cohort開始後の別失敗が後続成功で消えないようfailure epochと対応づける。全coin確認時刻、最後の実通信成功/失敗、cache hit、in-flightを分離する。TTL120秒は維持し、既知の失敗後は正常cacheを復旧証拠にしない。

この不具合は2時間試験の根本原因と未結合。試験ではbalance API要求を行っていない。監視側のDEGRADED・generation・注文ゲートも別に動作するため、不正約定があったとは主張しない。

### 5.2 HTTP成功とgRPC成功が混在する

`apiFetch` はHTTP2xxかつarrayBuffer受信完了でsuccessを通知し、その後SDKがgRPC status/trailerとprotobufをdecodeする。SDKの `src/grpc/core.ts:329` のgetCoinMetadataは、非abortのservice例外をcoinMetadata=nullへ変換する。アプリ側ではINVALID_METADATA→SUI_READ_FAILEDとなり、上位でgRPC codeを失う。

模擬fetchをHTTP200・grpc-status=14にすると、2試行ともApiAttempt.success=trueなのにhealthは失敗した。またstatus.failuresは3となり、実際のmock読取2件・health失敗1件が混在した。外部通信0。

改善案：HTTP transport、gRPC result、business validationの結果を別計測し、同じrequest/cohortへ結合する。SDK transport境界でgRPC codeを記録してからCore APIのnull変換へ渡す。数値の過去互換を保ち、既存API成功率を黙って別定義へ変更しない。gRPC UNAVAILABLEを新たな自動復旧許可やretry許可へ追加することは、この観測改善には含めない。

過去の93/98は正確には現在のHTTP transport成功カウンターであり、93件すべてのgRPC decode/metadata成功を独立記録した値ではない。今回の4失敗health周期は既存5通信失敗と時刻対応し、別のgRPC-status障害が観測されたとまでは言えない。以前の報告・証拠は保持して、この計測定義上の限界を追記調査として扱う。

## 6. 障害後に正常周期へ戻れるか

保存済み証拠から確認した。HEALTHY時刻は15秒sampleで初めて観測した時刻であり、正確な遷移時刻ではない。

| 障害 | 次の正常市場周期 | HEALTHY再観測 |
| --- | --- | --- |
| Sui timeout 19:28:20 | 19:29:26.871 | 19:31:20.072 |
| Sui timeout 19:55:19 | 19:55:43.649 | 19:57:20.460 |
| DeepBook timeout 20:25:17 | 20:25:29.002（retry後、同周期成功） | 20:27:20.905 |
| Sui DNS2件 20:36:17/25 | 20:37:13.964 | 20:39:21.091 |
| Sui timeout 21:24:19 | 終了まで未観測 | 21:24:26.475にコンテナ正常停止 |

最後以外はDEGRADED→RECOVERING→HEALTHYへ戻っている。最後のtimeoutから停止までは約7秒で、回復不能なhangや永久的pool破損の実証ではない。一方、終了時に回復したとも判定できない。全期間running=false / resumePending=falseであり、稼働中PAPERの自動再開を実地検証した試験ではない。

既存の安全経路は、障害時に注文ゲートを閉じ、次周期をfresh読取にし、全足・板・Sui・台帳・世代・backoffを確認して復旧する。2正常周期以上かつ60秒以上、最短間隔30秒、resumePending時の180秒/9失敗上限、手動停止後の再開禁止を維持する。回復試行として追加の即時RPCを入れるより、まずこの経路の正しい証拠と状態表示を保つ。

## 7. 最小修正案・安全性・通信負荷・回帰テスト

| 優先 | 修正候補 | 安全性と負荷 | 必要な回帰検証 |
| --- | --- | --- | --- |
| P0 | health cohortと通常read状態を分離 | TTL120秒・1確認あたり2 read・既存周期を維持。既知失敗が別read成功で消えることを防ぐ。通常readがTTLを延命していた利用時や、失敗を隠していた場合は必要なhealth確認が増え得る。追加scheduler・常時cache無効化は行わない | SUI/USDC片失敗、balance成功後もhealth未復旧、並行read/health、遅延した古い成功、failure epoch、cache hitが実通信成功を増やさない |
| P0 | 受動的な段階・request/connection/cohort計測 | 追加RPC0、poolやprotocolは変更しない。購読失敗をunknownとして扱い、例外・ログ漏洩・メモリ増大を防ぐ | 新規/再利用socket、DNS/TCP/TLS/header/body、IPv4/IPv6試行、abort/45秒期限、相関不能、購読解除、secret除外 |
| P0 | HTTP/gRPC/metadata outcomeを分離 | 追加RPC0。既存success定義を残して新しい指標を追加。安全復旧許可は拡張しない | HTTP200+gRPC14、正常trailer、decode失敗、null/不正metadata、body timeout後HTTP200保持、計測重複防止 |
| P1・証拠次第 | Sui専用のbounded pool・寿命管理 | 全体dispatcher置換禁止。必要時のみorigin単位。idle寿命変更はstale socket/再DNS増加の両面があるため現時点で値を選ばない | 正常時reuse、idle切断、abort後次要求、destroy時の未完了要求、close/cleanup、他APIへの非干渉 |
| 保留 | native HTTP/2への切替・keepalive PING・追加retry | 接続・依存・通信量・障害特性が変わる。今回の最小修正には含めない | 別途必要性と上流対応を確認してから評価 |

全案で10秒timeout、周期45秒budget、retry上限、安全停止/復旧条件を緩和しない。DNS pinning、OS DNS設定変更、無制限retry、cache強制無効化、失敗履歴の削除も行わない。P0実装後は既存 `paper-recovery-engine` / `paper-recovery` / `read-budget` / `http-errors` 等を、隔離fixtureで回帰させる。

## 8. 次の進め方

まず上記P0を、ネットワーク経路の変更なしで実装・回帰検証する案を推奨する。通信耐久性が改善したとの実環境判定は、その後の別途承認された独立コンテナで行う。Docker/Botの起動・再起動前にproject、固定image、専用volume、port、安全設定を提示して承認を得る。既存DB・証拠は引き継がない。

実測は通常周期とcacheを維持し、100実試行を確保できる観測時間を事前設定する。外部DNS要因をアプリ修正だけで解消済みとしない。24時間PAPERは開始せず、NO-GOを維持する。

今回作成したのは本調査メモと新規の隔離再現出力のみ。production修正・依存追加・設定変更・コンテナ起動は未実施。
