# VPS リカバリ自動化 — 運用メモ

これは設計書ではなく、2026-11-06 未明の初回配置リカバリで実地に確認した
paper-check／broker の状態遷移を記録する運用メモである。今後の自動化
（リカバリ用ワークフロー等）はこのメモの事実を前提にする。

## 確認した事実

### 1. 開いたままの paper-check セッションが配置を OS_ERROR で止める

- ホストに paper-check セッションが開いている（`/var/lib/suiba-deploy/paper-check.json`
  が `{"status": "in_progress"}`）間、broker は配置を paper-check 配置とみなし、
  その sha の許可証 `paper-deploy-<sha>.json` を読みに行く。
- 通常の CI 配置には許可証が無いため FileNotFound（OSError）になり、公開コードは
  名前付きコードではなく `OS_ERROR` になる。この段階では failure.json も台帳も
  書かれないので、Actions のログだけでは理由が分からない。
- セッションは「失敗した検証ランの後始末が終わっていない」だけでも開いたままになる。

### 2. 是正点は3点セット（fault ラッチ／停止レシート／台帳とコンテナの同一性）

- **fault ラッチ**：`/var/lib/suiba-deploy/paper-check-failed.json` と、ランの
  フォルダ内 `fault-*.json`。preflight 失敗でも cleanup が自動で付ける。
  ラッチがある限り再試行・配置許可のどちらの経路も開始できない。
- **停止レシート**：ランの `stop.json`。admission 前に死んだランは構造上
  `clean_stopped` を自己発行できない（cleanup が無条件に PREFLIGHT_INCOMPLETE を
  積む）。実態（コンテナ未起動・正常終了・未完了の変更なし）を管理者が確認した
  うえで是正する対象になる。
- **台帳とコンテナの同一性**：台帳の sha ＝ コンテナの image ラベル
  `org.opencontainers.image.revision`、台帳の transaction が指す凍結 compose の
  image ＝ コンテナの image、の両方が admission の照合対象。作成に失敗した配置
  （`failed_state_unknown`）はコンテナを作り替えないまま死ぬことがあり、その場合
  台帳だけが新 sha を指して実物と食い違う。台帳の是正は、最後に成功した配置の
  レシート（sequence・sha・transaction）を正として復元する。台帳ファイル自体は
  削除しない（PR35 設計どおり、管理者確認が解除条件）。

### 3. diagnose() は backup 前に死んだ現行ランを診断できない

- `diagnose()` の `diagnostic_backup` は現行ランの `record['backup']` を必須と
  するため、backup 段階より前に死んだランが現行記録だと KeyError で診断自体が
  失敗する（`PAPER_STATUS_FAILED` になる）。
- `approve-retry` も内部で diagnose を使うので同じ理由で到達できない。
  一方、run 自身の開始ゲートは backup を要求しない（ラッチ・停止レシート・
  permit の中身・コンテナ実在を再検証する）。

### 4. admitted 後に失敗したランは cutoff タイマーを armed のまま残す

- admission を通過したランは cutoff タイマー（`suiba-paper-check-cutoff.timer`）を
  起動する。ランが途中で失敗してもタイマーは解除されず、次の開始は
  `quiescent()` が「タイマー active」を理由に即拒否する（記録が作られる前に死ぬ）。
- 解除はタイマーの発火（cutoff 到達）か、管理者による
  `systemctl stop suiba-paper-check-cutoff.timer`。守る対象のランが停止済みで
  あることを確認してから止める。

### 5. market-freshness は worker 起動直後の一回だけの判定で競合負けする

- 検証ランの market-freshness は、worker 起動から約10秒時点で summary の
  `marketData.lastSuccessAt` が90秒以内かを**一回だけ**見る（リトライなし）。
- エンジンの初回 GeckoTerminal 取得（プール発見＋OHLCV）がその前に完了して
  いないと、取得自体は健全でも失敗になる。2026-11-06 の実測では、手動起動では
  約11秒で初回成功したが、ランではチェックが先に来て market-freshness で落ちた
  （数秒差の競合）。GeckoTerminal への到達性自体は VPS から正常だった。

## このメモに紐づく自動化

- `.github/workflows/suiba-paper-watch.yml`：paper-check ランの完走を
  GitHub Actions 側から監視する（承認1回で最大約40分ポーリングし、
  `completed`／`failed_requires_review` で早期終了）。状態取得は既存の
  `docker/ssh-paper-status.sh`（CHECK-PAPER-STATUS）をそのまま使う。
- broker の `OS_ERROR` の名前付きコード化と、診断→再試行承認→開始→監視の
  一本化は未着手（tracked item「SuiBa VPSリカバリ自動化」）。
