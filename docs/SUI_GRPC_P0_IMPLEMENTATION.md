# Sui gRPC resilience P0 実装・オフライン検証

実施日: 2026-10-24 (JST)

対象基点: main `a0dfd358866a7e7fe4cb2dd2aaa6d1f3991e8ddf`。
参照: `SUI_GRPC_RESILIENCE_INVESTIGATION.md`、`PAPER_RUN2_PREFLIGHT_REPORT.md`、
`../tools/sui-transport-bench/REPORT_20261023.md`。

## 調査と変更方針

従来は通常 read の成功が health の成功状態・確認時刻を更新でき、片方の coin の成功で
失敗状態を上書きできた。HTTP 本文取得成功だけでは SDK の gRPC status と metadata の
妥当性を保証できない。比較試験は完全なペアが1組に限られ、native transport への変更を
裏付ける結果ではない。このため transport は維持し、状態分離と受動計測を追加した。

## 実装

- `packages/sui-client/src/index.ts`: health と通常 read の状態を分離。
  SUI/USDC の同一 health cohort が両方成功して初めて healthy とする。
  通常 read は health の時刻を延長せず、health 障害を解除しない。
  並列 health は共有し、別の fresh budget は古い cohort 完了後に自分の確認を行う。
  途中の read 障害・期限切れ・記録障害で世代を無効化し、遅延応答による復旧を拒否する。
- HTTP、GRPC、METADATA、READ、HEALTH を別イベントに記録。
  transportId/requestId/rpcId/healthId/cycleId で関連付ける。
  grpcStatusSource は SDK。SDK のローカルエラー変換も含むため、wire trailer の直接観測と
  同義ではない。HTTP 200 でも gRPC・metadata が失敗し得ることを保持する。
- `packages/sui-client/src/diagnostics.ts`: Node diagnostics channel と socket イベントによる
  DNS/TCP/TLS/応答待ち/本文の受動計測。接続ID、再利用、観測できた protocol を記録。
  未取得の時間は省略し、0で補完しない。再利用接続に新規接続の所要時間を帰属させない。
  対象 origin と相関できた情報のみ採用し、listener は上限を設けて終了時に解除する。
  URL・IP・認証情報・生のエラーメッセージは追加イベントに保存しない。
- worker は `sui_observations` に記録し、operations API に health/read 状態と直近50件を公開。
  市場取得 cycleId を既存 read budget にメタデータとして渡す。
  記録不能時は fail closed とし、完了済み HTTP を再実行しない。

既存の安全停止・復旧ゲート・120秒 health TTL・既存キャッシュTTL・タイムアウト・
リトライ方針・通信予算は変更していない。追加RPC、keepalive PING、dispatcher差し替え、
native transport切替は行っていない。過去のHTTP通信カウンタも再定義していない。

## 検証結果

Node.js 24.22.1。外部TCP接続を拒否するプロセス内ガード下で実行。
fixture とループバックのみを使用し、外部Sui/DeepBook通信は実行していない。

- TypeScript `tsc --noEmit`: 成功。
- Vite dashboard production build: 成功。依存zod内の既存注釈警告あり。
- `vitest run tests --maxWorkers=2 --exclude tests/settings-api.test.ts --exclude tests/paper-only.test.ts`:
  36ファイル、490テスト成功。
- `node --test tools/sui-transport-bench/bench.test.mjs`: 6テスト成功。
- `git diff --check`: 成功。

追加回帰テストは片側metadata失敗、通常readとの分離、並列singleflight、fresh budget間の
待ち合わせ、途中障害、遅延応答、無協調処理の期限切れ、EAI_AGAIN後の復旧、HTTP200の
gRPC失敗、metadata不正、本文timeout、記録障害、通信段階、実ループバックの接続再利用を含む。
engine統合fixtureで DEGRADED → RECOVERING → HEALTHY と既存の複数正常cycleゲート、
手動停止維持、注文・約定0件を確認した。

アプリworkerを起動する settings-api/paper-only の2ファイルとE2Eは未実施。
transport benchのテストはnode:test形式のためVitestと分けて実行した。
初回ビルドはsandboxのworktree realpathがEPERMになり、承認された実行範囲で再実行して成功。

## 制限と残るリスク

DNS/TCP/TLSの境界はNode/Undiciのイベント提供状況に依存する。DNSキャッシュ・既存接続・
proxy等では欠測する。合成イベントでTLS段階を検証したが、実TLSとDocker/Linuxでの
相関精度、HTTP/2接続、Windows/Docker間の経路差は未検証。欠測を推測で埋めない。
read状態の失敗数は論理readの失敗数であり、実通信試行数はHTTP/GRPCイベントで集計する。
キャッシュ成功はHEALTHのcacheHitとして区別し、実通信成功に加算しない。

永続イベント追加によるDB書込み・保存容量の影響は長時間試験で確認が必要。
この検証では既存3100/3101、検証用DB、証拠ログを変更していない。
Docker/Bot起動・再起動、実通信試験、24時間PAPER試験は未実施。

実通信成功率の改善や24時間運用GOを示す結果ではない。既存NO-GOは解除しない。
別途承認後、固定イメージ・独立DBで通常周期の通信検証を行い、層別イベントと市場周期の
復旧を突合する必要がある。
