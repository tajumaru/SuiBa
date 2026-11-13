# Bot が止まったときの調査手順（Troubleshooting）

PAPER Bot がエラーを出したり停止したりしたときの、決まった切り分け
手順。**回復パラメータを先にいじらない**——まず記録を取り、原因を
切り分けてから直す（2026-11-04 にオーナーが確定した進め方）。

## まず状態を見分ける

| 状態 | 意味 | 動き |
|---|---|---|
| `PAPER_NETWORK_PAUSED`（一時停止中） | 輸送系の一時失敗でエピソード（一時停止期間）に入った | 自動復帰する。健全なサイクルが2回そろい、60秒以上健全なら `PAPER_NETWORK_RECOVERED` で再開 |
| `PAPER_RECOVERY_EXHAUSTED`（完全停止） | エピソードが上限（**3分** または **失敗9回**）を超えた | 自動では戻らない。調査してから手動再開 |
| `PROCESS_RESTART_STOPPED` | プロセス再起動時に、前回のエピソードを閉じる記録として出る | 添付の内訳（どの API が何回、どの理由で失敗したか）を読む |
| `API_BACKOFF` | `apiAccess` の全体バックオフでサイクルを止めている | 個別 API の失敗が全体に波及していないか、内訳で確認 |

## 回復対象の線引き（なぜ止まる／止まらないか）

エピソードで自動回復するのは **輸送系の失敗だけ**：

- 対象：DeepBook Indexer / Sui gRPC / GeckoTerminal への接続失敗、
  DNS・ネットワークエラー、502 / 503 / 504、タイムアウト
- **対象外（即・完全停止）**：HTTP 429、HTTP 500、その他の理由コード。
  これは仕様であり、2026-11-04 に「上限を伸ばさない（3分／9回のまま）」
  と確定している。止まったら上限変更ではなく原因調査を先に行う。

上限値の正は `packages/shared/src/paper-recovery.ts` の
`paperRecoveryLimits`（healthyCycles 2 / minimumHealthyMs 60000 /
minimumCycleSpacingMs 30000 / maxEpisodeMs 180000 / maxFailures 9）。

## 調査手順

1. **運用タブ**で停止理由と「一時停止期間の内訳」を確認する
   （エピソード中の失敗が API × 理由コードで集計されている）。
2. **「AI調査用レポートを書き出す」** ボタンで Markdown レポートを
   保存する（`apps/dashboard/src/diagnosticExport.ts` が生成する
   自己完結の診断資料）。
3. そのレポートを Muse（シロ）に渡して原因を切り分ける。
   レポートには版情報（画面／Bot のビルド）も入るので、版のズレが
   疑われるときもここから分かる。
4. 切り分けの結論が出るまで、回復パラメータ・取引ロジック・
   安全停止条件は変更しない。挙動の変更はオーナーの明示的な
   選択があったときだけ。

## VPS 配置側で止まったとき

- 配置は **prepared_stopped（起動しない状態）** で止まるのが正。
  「配置できたのに動いていない」は異常ではない。
- ブローカーの拒否コード（例：`DIRECTORY_OWNER_MODE` は共有
  ディレクトリの所有者・権限、`CI_APPROVAL_REQUIRED` はポリシーと
  リクエスト形式の不一致、`REPLAY_OR_OLD_RELEASE` は ci_run の
  再生・旧版）への対処は `deploy/broker/approval-ci.md` を参照。
- ホストの状態確認は GitHub Actions の SSH 読み取りチェック
  （`suiba-ssh-preflight`）で行い、Tera Term での手作業確認に
  戻さない。設置済みブローカーの sha256 もそこで照合できる。
- 新版が悪く旧版へ戻すときは、本番を停止した状態で
  ROLLBACK-PROD（`suiba-production-control`、対象リリースの SHA を
  指定）が使える。archive は CI が対象コミットから再作成し、
  broker が現 DB の backup を取って旧版を未起動で用意する。
  開始は START-PROD で別途判断する。DB の巻き戻しは行わない。
