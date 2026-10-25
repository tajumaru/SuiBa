# Windows / Docker 独立通信診断

Sui gRPC-Web・HTTP/2 と DeepBook の通信を、Windows ホストと専用 Docker コンテナから比較するツールです。**通常起動、import、ビルド、テストでは実通信診断を開始しません。** 実通信は Windows の `-ExecuteLive` を明示した手動操作だけで開始します。

Bot・取引・DB のコードは読み込みません。既存コンテナ、DB、volume、ネットワーク設定を変更せず、注文・約定・PAPER/LIVE を開始しません。品質判定は常に `NOT_EVALUATED` です。運用品質の試行回数100件、板鮮度10秒、安全停止基準は変更しません。

## 準備と手動開始

Windowsでは同じフォルダーの **`Start-SuiBaNetworkDiagnosis.bat` をダブルクリック**して手動開始できます。Docker Desktopを起動し、下記の依存関係の準備を済ませてください。batの起動自体が実通信開始の明示操作です。結果は同じフォルダーの `results/netdiag-.../` に保存します。終了時はキー入力まで画面を残します。

batはPowerShell 7がPATHにあれば優先し、なければWindows標準のPowerShell 5.1で起動します。追加のPowerShellインストールは不要です。

batは `SUIBA_DIAGNOSTIC_NODE` が設定済みならそれを使い、未設定ならユーザーのCodex runtimeのNode、なければPATHのNodeを使います。バージョンは起動スクリプトで検証します。計画だけ確認する場合は `Start-SuiBaNetworkDiagnosis.bat --plan` としてください。この場合は診断・Node探索・Docker操作を行いません。

Windows PowerShell 5.1 または PowerShell 7、Docker Desktop の Linux engine、**Windows 側も Node.js >=24.22.1 <25** が必要です。PATH 上の Node が古い場合は `-NodePath` で対応する実行ファイルの絶対パスを指定します。`.env` やウォレット、秘密鍵は不要です。PowerShell 7から実行する場合は下記の `powershell.exe` を `pwsh` に置き換えられます。実行ポリシーのBypass指定はその起動プロセスだけに適用し、システムの設定を変更しません。

プロジェクトの `sui-ai-trading-bot` ディレクトリで実行してください。

```powershell
# 依存関係の準備のみ。診断リクエストは発生しません。
npm ci --ignore-scripts --prefix tools/network-diagnosis

# 計画表示のみ。Docker や Node の探索も行いません。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/network-diagnosis/Invoke-NetworkDiagnosis.ps1

# 以下が実通信を開始する明示的な操作です。必要なときだけ手動で実行。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/network-diagnosis/Invoke-NetworkDiagnosis.ps1 `
  -ExecuteLive -NodePath 'C:/path/to/node.exe'
```

準備中に専用イメージを build し、固有 ID・ラベルの bridge network とコンテナを新規作成します。既存サービスの起動スクリプトや compose は呼びません。コンテナには出力用フォルダーだけを bind mount し、root filesystem は読み取り専用、capability はすべて削除します。診断終了時に自身のコンテナと network だけを削除し、専用イメージは再現用に残します。prune は行いません。

ホストとコンテナは同じ UTC 開始予定時刻を共有します。実際の開始を待って壁時計・単調時計を対応づけ、両方で30分以上経過してから期限終了します。タイマーが早く発火した場合は再確認して待ち直し、壁時計の補正量も記録します。片側の正常終了だけで、もう片側を途中停止しません。既存のrunner watchdog（開始予定から31分）は維持し、時計補正や準備遅延等で間に合わなければ不完全のまま停止します。準備が開始時刻に間に合わなければ診断を中止します。画面に表示された出力フォルダーへ `STOP` ファイルを作るか Ctrl+C で停止できます。片側の停止は相手側にも通知します。途中停止や片側の起動失敗は完全な30分の証拠として扱いません。

## 通信内容・負荷・停止

許可するリクエストは固定の2種類だけです。ユーザー指定 URL、RPC、注文 API は受け付けません。

| 対象                                               | 読み取り                                                                               | 期限 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- |
| Sui `fullnode.mainnet.sui.io`                      | SDK 2.37.0 の `getCoinMetadata(0x2::sui::SUI)` → `sui.rpc.v2.StateService/GetCoinInfo` | 10秒 |
| DeepBook `deepbook-indexer.mainnet.mystenlabs.com` | `GET /orderbook/SUI_USDC?level=2&depth=10`                                             | 8秒  |

60秒ごとに1プロファイルを実行します。各枠では warm・warm・cold の順で最大3リクエスト、完了後5秒以上空けて逐次実行します。default-fetch 基準プロファイルは同じ既定プールで3回です。枠の期限45秒、最大90リクエスト/側（両側180）。失敗時のリトライ、失敗枠の残りリクエスト、遅れた枠の追いつき送信は行いません。429で即停止、3枠連続失敗または5分超の成功枠なしでも停止します。診断専用の上限であり、運用 Bot の実装には変更を加えません。

プロファイルは以下を10枠で一巡し、最大3巡します。

1. Sui SDK + Node.js 既定 fetch / 自動 IP の基準計測。
2. 自動 IP・IPv4・IPv6 それぞれについて、Sui SDK + 制御した Undici fetch、Sui SDK + 独立 HTTP/2、DeepBook + 独立 HTTP/2。

Undici 7.30.1 の比較専用プールは `connections=1, pipelining=1, allowH2=false, keepAliveTimeout=15000, keepAliveMaxTimeout=15000, keepAliveTimeoutThreshold=1000`（`diagnostic-15s-idle`）、HTTP/2 は1 sessionです。cold は専用の新規プール/session、warm は同じものを保持します。接続 ID と実際の利用回数から再利用を判定し、warm という指定だけでは再利用成功とみなしません。サーバー側切断・GOAWAY 時は新規接続として記録します。IPv6 AAAA がない場合は `NO_IPV6_ADDRESS` とし、成功扱いにしません。

旧ツールは要求間隔5秒に対してUndici既定idle保持4秒で、HTTP/1.1のwarm接続を再利用しづらい比較でした。新しい比較専用プールのidle保持は要求間隔より長くしますが、サーバーの短いkeep-alive期限や切断は尊重します。`poolPolicy`・`gapSincePreviousAttemptMs`・実際の再利用数・`reuseObservation`を保存し、再利用0件なら`NOT_OBSERVED`と明示します。既定fetchのpoolは変更しません。要求の10秒/8秒・枠45秒等のタイムアウト延長ではありません。

この構成は制御した比較実験です。実運用の接続プールや OS のプロキシ設定を変更しません。Node fetch、Undici、HTTP/2 のプロキシ経路は同一とは限りません。プロキシ環境変数は名前のみ、Docker daemon のプロキシ設定は存在有無のみ保存します。独自のプロキシ経路を強制する機能はありません。

## 保存する証拠

既定では `tools/network-diagnosis/results/netdiag-.../` に保存します。既存実行の JSONL は上書きしません。

| ファイル                                      | 内容                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `network-diagnosis.md`                        | Windows/Docker 比較、観測された失敗、原因候補、次の切り分け、制約                              |
| `network-timeline.csv`                        | UTC epoch ms の要求開始/終了・ログ時刻、各段階、接続 ID・IP family・再利用、OS・packetイベント |
| `network-metrics.json`                        | 生の測定値と集計、プロファイル別比較、同時失敗、重なる CPU・イベントループ窓、収集不能項目     |
| `windows/events.jsonl`, `docker/events.jsonl` | 要求・計測環境・リソース・終了理由                                                             |
| `system.jsonl`, `run-info.json`               | OS 収集状態、固有実行 ID、予定期間、ソース SHA、専用 image                                     |

Node は DNS lookup、TCP connect、TLS secure/connect、ヘッダー、本文完了を別々に記録します。段階の完了が観測できない場合は `null`、再利用接続の DNS/TCP/TLS も `null` です。総時間・失敗時点・未完了段階の経過時間を併記し、タイムアウト全体を「TLS時間」と取り違えません。HTTP/2ではstream生成前のqueue時刻、IDが割り当て済みかreadyイベントで観測した時刻、write finishイベントまたは完了済み状態を記録します。readyとwrite finishの遅い方を送信側処理完了の代理とし、`sendTimingBasis`に観測方法を保存します。`responseWaitMs`はそこからヘッダーまでで、パケット上の送信完了を示すものではありません。時刻逆転や未観測はnullのままです。

Node 計測は JS callback の観測時刻であり、パケットの実到着時刻ではありません。接続競合や Happy Eyeballs のすべての候補 socket が単一の数値に収まるとは限りません。

Node の CPU・RSS・heap・イベントループ遅延を5秒窓、Windows 全体の CPU/メモリと専用 Docker コンテナの stats を約10秒間隔で取得します。Windows DNS Client/System と WLAN Operational のイベントは既存の有効なログだけを読み取り、ログを有効化したり消去したりしません。Docker Desktop の host ログは新規追記部分だけを最大1MiB/回読み、DNS/TLS/接続カテゴリ、既知対象、許可したエラーコードのみ保存します。原文・認証情報・不明なホスト名・SSID は保存しません。無イベントと権限不足を断定的に区別できない場合も明記します。

`measurement-start`には実際の壁時計/単調時計の開始を、`end.clock`にはcleanup前の終了、両経過時間とwallDriftMsを保存します。単調時計の原点は各プロセス内でのみ比較できます。レポートとCSVにも経過時間・補正量・不足理由を出します。両時計とも1800000ms以上、記録間の一致、正常期限終了を必須にし、許容誤差やcleanupによる時間の水増しはありません。旧記録には単調時計の証拠を後付けしません。前回のDocker終了が予定より205ms早かった記録も不完全のままです。

実行 ID・開始時刻・Node 範囲・ソース hash の不一致、途中終了、破損 JSONL、ファイル欠落では `evidenceComplete=false`。`true` でも全補助ログが利用可能、通信正常、運用品質 PASS を意味しません。収集状態と個別の失敗を別途確認してください。出力には実測結果のみを記載し、症状の相関だけで DNS・Docker・上流を原因と断定しません。

**SQLite は使いません。** この独立診断で同時刻のイベントループ停止と通信遅延は比較できますが、既存 Bot の SQLite COMMIT・WAL・GC 原因は判定できません。既存 DB に触れず、その調査には保存済みの別の証拠が必要です。

## パケット取得（任意）

既存の `dumpcap` と明示的に選んだ interface がある場合だけ、上記の手動コマンドに `-CapturePackets -PacketInterface '1'` を追加できます。インストールや昇格を自動で行いません。pktmon の共有セッションや既存のフィルターは操作しません。

対象の現在の IPv4 の TCP/443 と DNS/53 に限定、snaplen128、16MiB×2の ring、最大31分です。**他アプリの DNS 名も raw pcapng に含まれ得るため、packet ファイルは機密としてローカルに保持してください。** IPv6・後から変わった IP・DoH・TLS1.3 の暗号化部分を完全には観測できません。設定時の DNS 解決でキャッシュが温まる影響もあります。

`tshark` が既にあれば終了後にオフラインで各ファイル先頭10000 packet を解析し、DNS・SYN・再送・ClientHello/ServerHello の時刻だけを秘匿化して JSONL に保存します。欠落や取得権限不足は `UNAVAILABLE` と記録します。packet がないことを再送なしの根拠にしません。

## オフライン検証・再集計

```powershell
node --test tools/network-diagnosis/diagnosis.node.mjs
# 保存済み診断フォルダーの再集計のみ。通信しません。
node tools/network-diagnosis/report.mjs 'C:/absolute/path/to/netdiag-run'
```

テストは SDK に偽の gRPC-Web 応答を渡し、HTTP/2 session をモック化します。外部 endpoint は呼びません。既存の `test` / `test:offline` にも組み込みます。通常のイメージ build・起動は計画表示だけです。

実際の30分比較結果・原因の優先順位は**手動実行後に初めて**評価できます。今回のツール作成・オフラインテストから、Windows/Docker/外部ネットワークの原因を確定することはできません。
