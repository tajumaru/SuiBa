# 通信安定性・安全停止機構の調査と強化

基点: main `d1a21baa5668aa67e1d4f426e8b47ac9c834360f`。作業ブランチ: `codex/network-safety-hardening`。2026-10-26 JST。実注文・運用DB・稼働コンテナの変更なし。

## 調査結果（既存実装）

| 項目 | mainで対応済みの内容 | 不足と対応先 |
|---|---|---|
| DeepBook | 固定HTTPS Indexerへ読取専用HTTP/2。接続再利用、GOAWAY後再接続、中断時破棄。プール・全時間足・板・約定証拠の検証 | 連続失敗の通信抑制を本PRで追加 |
| Sui RPC | `@mysten/sui` 2.37.0の読取専用gRPC。既定fullnode、HTTPS必須。HTTP/gRPC/metadata/healthを別階層で観測。一般JSON-RPCへの自動フォールバックなし | 本PRのAPI別Breakerを共通経路で適用 |
| Cetus | Aggregator SDK 1.7.5の見積もりのみ。AsyncLocalStorage内のfetchを共通HTTP制御へ渡す。署名・送信なし | SDK全体の20秒締切を本PRで追加 |
| GeckoTerminal | 市場取得の選択先。autoで許可する障害だけフォールバック。出所混在・ペア不一致・出所切替を検出 | 429/TLS/不正板等を迂回する代替取得は追加しない |
| 分類 | DNS、接続、ヘッダー、本文、TLS、HTTPステータス。証拠が足りない段階はHEADERS_OR_CONNECTのまま保持 | 部分本文切断の実HTTP試験を追加 |
| 再試行 | 共通10秒、DeepBook 8秒・追加2試行。Sui/Cetusの一時障害再試行は既定0。指数待機1秒、2秒+正のジッター、最大60秒。429は別制御・追加2試行まで、長いRetry-Afterは短縮せず手動解除待ち | 無制限再試行なし。既存値を延長しない |
| 全体締切 | Sui healthを含む市場取得45秒。キュー・再試行待機・本文へ中断を伝播 | Breaker待機も同じ締切を消費。Cetus SDK全体を20秒に制限 |
| 停止 | OperationMonitorとBotEngineの世代番号、単一tick、取得中・異常・緊急停止・データ遅延時の注文禁止 | 5状態の共通運用表現を追加 |
| 復旧 | PAPER稼働意図の保持、全時間足の今回の品質・欠損0・板10秒以内・Indexer遅延60秒以内・同周期Sui health・台帳・待機終了、2周期/60秒。復旧遷移周期は注文しない。180秒/9失敗で重大停止 | 不完全周期による連続性のリセットと全注文履歴照合は未マージPR #17 |
| SQLite | WAL、synchronous=FULL、BEGIN IMMEDIATE、COMMIT/ROLLBACK。同じIDのorder/tradeを拒否し、fill・残高・runtime・check等を同一トランザクション保存。BUSY/LOCKED等の接続障害をラッチし注文ゲート閉鎖 | 未確定/孤立/JSON ID不一致を含む全履歴の復旧照合はPR #17 |
| PAPER/LIVE | workerはLIVEを起動拒否。外部注文送信処理なし。再起動は停止状態、再開意図を取消 | LIVE送信・不明取引のオンチェーン照会/再送は今回実装対象外。読取専用transaction(digest)は存在するが執行照合経路ではない |
| 監視 | API別応答時間/429/試行/最終成功/最新失敗と安全停止・市場鮮度・復旧進捗 | Breaker、5状態、待機理由・必要条件を日本語で補足 |

`UPSTREAM_BODY_TIMEOUT`はHTTPヘッダー受信後、成功本文の読取完了前に期限に達した場合。途中切断はBODY段階の`UPSTREAM_NETWORK_FAILED`であり、時間切れと区別する。HTTP200や部分JSONを成功・キャッシュとして採用しない。

`MARKET_DATA_STALLED`は確定足360秒超、取得全体45秒超、最終検証市場360秒超、起動後360秒経過しても有効市場なしの場合。注文ゲートはさらに最終検証180秒超で閉じる。通信成功時刻と市場品質検証時刻は別であり、HTTP成功だけでは鮮度を回復させない。

## 実装順序と変更

P0: API別Circuit Breaker、SDK全体締切、保存失敗時の閉鎖。P1: 運用5状態と日本語の復旧案内。P2: 障害試験・専用Docker回帰と本書。

Breakerは一時通信失敗の実試行が3回続くとOPENへ遷移。初回30秒、失敗プローブ後は最大60秒。API単位の既存キューで1本だけHALF_OPEN試験通信を許可し、その失敗を再試行しない。成功まで`blocked()`はtrueで注文禁止。期限を過ぎても自動でCLOSEDにはしない。成功HTTPはBreakerを閉じるだけで、Botの復旧は既存の品質・台帳・リスク条件に従う。

OPEN待機は取得45秒締切や終了操作で中断され、後から通信を発火しない。長いOPEN待機で45秒を消費した場合は既存の安全停止を優先する。証明回数や180秒/9失敗の上限は緩めない。TLS・データ不正・取消・429は一時通信障害のBreaker件数へ含めず、既存の重大停止/レート制限制御を維持。

Breaker開閉は既存`api_cooldowns`へ同期保存。再起動後は期限切れでも成功プローブ前に注文を許可しない。手動resetはBreakerを解除しない。保存失敗はVALIDATION_RECORD_FAILEDとして失敗扱いとし、成功プローブ時の保存失敗でもゲートを閉じたままにする。DB障害ラッチも維持。

Cetusの全体20秒はSDKが複数fetchを行う場合や例外を握りつぶす場合も含む。親の取得締切が短ければ優先し、cycleId/fresh属性を保持。期限後のSDK内部処理を強制終了することはできないが、同じ非同期スコープの追加HTTPは中断済み予算で拒否し、呼出し側へ結果を採用させない。

## 5状態と遷移

| 状態 | 条件と注文 |
|---|---|
| RUNNING | 稼働中・通信正常かつ既存注文ゲートが開く。個別リスク/利益条件は別途必須 |
| DEGRADED | 再開意図を持つ通信劣化。注文禁止 |
| PAUSED | 連続正常確認中、取得中、鮮度/待機等のゲート閉鎖。注文禁止 |
| STOPPED | 手動停止・開始待ち、再開意図なし。注文禁止 |
| FAULTED | runtime.error、緊急停止、DB不健全。注文禁止、明示操作が必要 |

典型遷移: RUNNING→DEGRADED→PAUSED→RUNNING。通信成功だけで最後の遷移を許可しない。手動停止はどの状態からも再開意図を取消してSTOPPED（重大異常があればFAULTEDを優先）。重大異常/期限超過/DB障害はFAULTED。再起動は自動再開しない。未知の通信状態はPAUSEDとして扱う。

`controlState`は既存のruntime/safetyと注文ゲートから導く運用表現。新たな売買許可フラグとして利用しない。既存botState/通信状態/履歴の互換性を保つ。

## PR #16・#17との関係と残課題

調査時点で両PRはopen/Draft・未マージ。#16 head `abed7e5`は板分析・履歴比較、#17 head `543de0d`は連続正常周期と注文履歴照合。取り込み・マージ・同等実装の複製は行っていない。本PRは#17のrecoveryCycle/履歴照合実装を変更しない。mainへ先に#17が入った場合は追従して統合試験が必要。

**プロジェクト全体の完了とは扱わない項目**:

- #17の全履歴照合と不完全周期リセットは本ブランチには存在しない。未確定注文を検出した復旧拒否の完成には#17のレビュー・統合が必要。再起動時の停止と既存候補の中断処理はあるが、全未確定注文を照合済みとは主張しない。
- LIVEは意図的に禁止のまま。応答不明の実注文をチェーン照会して復旧する機能は未実装。実注文を無条件に再送する経路も追加しない。
- 新しい複数RPC先の自動切替・独立ソース間の合意検証は未実装。既存のソース整合性/切替時停止のみ。
- 実時間24/48時間の市場通信、Windows/Docker Desktop再起動、スリープ復帰、物理電源断、本番ディスク・極大量履歴は未検証。48時間試験は仮想時刻のAPI制御試験でありBot全体の実時間耐久保証ではない。
- UIの再開条件は必要条件の案内。未マージの注文照合機能まで稼働済みと解釈しないこと。

## 障害テスト対応

| 要求 | 検証ファイル/範囲 |
|---|---|
| 一時タイムアウト | deepbook-transport、api-access、circuit-breaker、paper-recovery-engine |
| 本文途中切断 | http-errors: 実HTTP200の不完全本文を2回拒否、成功時刻なし・キャッシュなし。既存HTTP/2 BODY期限も維持 |
| 更新停止 | market-scheduler、operations: 45秒/180秒/360秒境界と注文禁止 |
| Sui接続障害 | sui-observations、sui-health、paper-recovery-engine: DNS/接続/本文/gRPC/metadataを区別 |
| 429 | api-access、deepbook-transport: 即時停止、Retry-After/再起動後の待機維持 |
| 復旧後の古い市場 | paper-recovery-engine、market-scheduler: 古い足/板、同周期証明不足で注文禁止 |
| 再起動直後の未確定 | operations: 中断候補と再起動停止。全注文照合は#17で未統合 |
| 同結果重複 | operations、core、profit-guard-worker: 重複ID/単一tick/原子的fillと元取引保持 |
| SQLite失敗 | sqlite-lock: BUSY/LOCKED、ロールバック/再起動、読取・書込障害。circuit-breaker: 復旧結果保存失敗で閉鎖 |
| 長時間断復旧 | circuit-breaker: 48時間相当2880周期・8断復旧・API履歴件数の境界。実時間試験ではない |

## 再現方法

Windows側Node v24.22.1、npm 11.12.0、pnpm 9.12.3。OS API: 10.0.29695、レジストリBuild 29695.1001 / Dev（ProductNameはWindows 10 Homeと報告するため名称ではなくビルドを記録）。Docker Client/Engine 29.9.2、LinuxコンテナNode v24.22.1。CIMによるOS製品名取得は制限環境で不可。

プロジェクトディレクトリで実行。PAPERの運用.envや既存DBをテストへ渡さない。

```powershell
node scripts/run-project.mjs build
node scripts/run-project.mjs test --maxWorkers=1
node node_modules/@playwright/test/cli.js test --config playwright.safety.config.ts tests/e2e/paper-recovery.pw.ts
docker build -f docker/Dockerfile --build-arg SUIBA_BUILD_SHA=<検証コミット> -t suiba-network-safety:20261026 .
docker build -f docker/Dockerfile.network-safety-test -t suiba-network-safety-tests:20261026 .
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges suiba-network-safety-tests:20261026
```

専用テストイメージには試験コードだけを追加し、通常Dockerfileの既定起動は変更しない。テスト実行時は外部ネットワーク無効・DBマウントなし。ビルド時には既存の依存取得先へ通信する。

初回の並列全件試験ではworker起動待ちと実HTTPタイムアウトに単発失敗があった。単独と直列で切り分け、安全制限・製品タイムアウトは緩和せず実行並列数だけ1にして最終確認する。モバイルでは既存ヘッダーが横にはみ出して固定ナビのタップを妨げたため、ヘッダー幅と固定ナビの余白を修正し4幅で通常クリックを検証。force clickは使わない。

## 検証結果

- Windows: Node標準45件成功。最終Vitest全64ファイル924件成功（49.58秒）。型チェック・Vite build成功。
- ブラウザー: 375/390/430/1280px、通信劣化・復旧確認・正常・手動停止・緊急停止・異常停止の24件成功。制御APIへの書込0、横はみ出しなし。375pxの取得画像も目視確認。
- Windows Docker Desktop: 製品イメージの固定digest Node 24.22.1ビルド成功。専用非rootコンテナを`--network none --cap-drop ALL --security-opt no-new-privileges`で実行し13ファイル189件成功（99.27秒）。運用ボリュームのマウントなし。
- 製品ソースは`50a1abb`時点と同一。検証時の製品イメージdigest `sha256:c3dc96464f9d63fd567f6756bb559b0a5733303c1335fe239912c81782cd2d83`、テストイメージdigest `sha256:fc377a8d48f4d34f841e75e82715848d6b6b7b9f3c7ca7e5b49b17492a5d0692`。製品イメージのrevisionラベルは検証用文字列`50a1abb-plus-regression`であり完全なGit SHAではないため、再現時は上記digestとソースを使用する。
- 初回テストコンテナはViteが`/app`へ一時設定を書けず起動拒否。専用テストDockerfileだけにnodeユーザーの設定一時ファイル/キャッシュ書込先を用意し再実行で成功。通常製品イメージのユーザー・権限は変更していない。
- 新規Breaker、SDK締切、5状態、本文切断、注文ゲートの計21件を追加。既存安全条件の削除・緩和なし。

全体完了には上記#17統合と実時間耐久試験等が残る。外部実注文・実資金試験は実施していない。

## PR作成後のCI分類修正

初回GitHub ActionsのUbuntuは追加した実HTTP本文切断テストがオフラインCIにも含まれ、`OFFLINE_NETWORK_FORBIDDEN`で失敗。Windowsはmatrixの失敗に伴いキャンセルされた。製品障害ではなく実通信テストの分類漏れだった。

実HTTPテストに既存分類の`actual loopback`を付け、通常テストと専用Dockerでは引き続き実行する。オフラインCIにはネットワークを使わないReadableStream切断試験を追加し、BODY/HTTP200/UND_ERR_SOCKETの分類、最終成功なし、部分JSONのキャッシュ不採用と2回とも再取得を検証する。オフラインガード・除外設定・製品コード・安全条件は変更しない。本文関連22件と型チェックは成功。
