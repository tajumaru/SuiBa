# Codex への依頼：SuiBa VPS 検証の失敗連鎖の調査と品質改善

## 背景

2026-11-07 の朝、VPS 検証（30分 PAPER ラン）を回すまでに多数の NG が連鎖した。個別の修正は PR #84〜#96 で main に入れたが、「なぜ毎回違う場所で落ちるのか」「テスト/CI がなぜ素通りしたのか」という構造側を、実装担当の視点で独立に調査してほしい。結論は証拠ベースで、推測と実測を分けること。

## 今日観測された失敗（証拠つき）

1. **self-read 上限**：controller.py が broker の `read_trusted` 既定上限（64KiB）を PR #77 時点で超過し、全 op が起動拒否（PR #84 で修正）。CI が素通りした理由：test の FakeBroker が `maximum` を無視し、systemd 検証はモジュールとして読むだけで `main()` を実行しない。
2. **setup の旧スナップショット事故**：ブランチ raw URL で配った setup が、マージ直後に「整合するが古い」一式を掴み、DeepBook 切替が実機に届かなかった（→ コミット固定 URL 運用に変更済み）。
3. **承認ゲートの独立性**：配置承認 ≠ 開始許可。retry 承認と deploy 承認が独立で、片方だけでは開始できず運用ミスを誘った。
4. **前任 run のエラー残留**：monitoring 失敗した run の runtime error（と API クールダウン）が DB に残り続け、次回の readiness を落とす。クリアはダッシュボード reset のみ。単発送信が失敗を握り潰して seq 10 のランを失った（PR #88／#92 で着信まで再送化）。
5. **DeepBook プロファイル不完全**：必須 env `DEEPBOOK_RECONSTRUCT_CANDLES=verified` が VPS compose に無く、Indexer 足系列の欠け（5分足1000本中2本）で全取得が CANDLE_GAP になった（PR #89／#90 で preflight 検査化）。
6. **sui.health() の予算なし（未確定）**：monitor の取得 deadline（45秒）を STALLED として消費する疑い。根拠は「足取得は 1.5〜2.8 秒で完了しているのに STALLED が出た」ことと、health だけが独自予算を持たず `pendingHealth` を後続サイクルが await する構造。PR #92 で stall の reasonDetail が取れるようになった（観測値：CANDLE_STALE ×2）。
7. **cutoff 競合**：正常終了処理の最中に cutoff タイマーが割り込み、監視とクリーン停止を完走した run を failed_requires_review に格下げした（PR #93 で正常停止中は post-stop へ委譲）。
8. **開始直前の永続エラー再発＋guard の楔**：起動サイクルが STALE_CANDLES（インデクサの足遅れ、閾値60秒の境目）で止まって runtime error を残し、市場鮮度は通過したのに paper-start が 409 拒否。guard の「中断時は pending を残す」設計と相まって OPERATION_COMPLETION_UNCONFIRMED になり、レシートが clean_stopped でないため通常の RETRY ゲートが通らない楔になった（PR #96：4xx 拒否で pending 解消／開始直前の readiness 再確認＋リセット再送／証拠主義の heal-run 操作）。

## 調査してほしいこと

- **A. 起動ウィンドウの設計**：worker はセッション開始前からサイクルを回し、エラーを永続化する（first-error-wins で停止中は上書きもされない）。開始前サイクルの失敗を開始可否に結びつける現設計は妥当か。worker 側で開始前エラーを分離する案（例：arm 前は永続化しない、鮮度ゲートと役割分担する）を含め、選択肢と推しを提示すること。
- **B. sui.health() の時間予算**：`pendingHealth` の連鎖を含め、45秒 deadline 内に必ず終わる保証がないことの実証（コード精査＋可能なら再現テスト）と、予算を持たせる修正案。
- **C. STALE_CANDLES の閾値**：インデクサの実測遅延（本日観測：閉じた最新足が境界から60〜120秒遅れることがある）に対して、`validateCandles` の鮮度条件（timeframe+60秒）は妥当か。閾値変更／取得側リトライ／鮮度ゲートとの役割分担、の比較。
- **D. テストの盲点の棚卸し**：FakeBroker のような「本物の制約を無視する偽物」が他にないか。`main()` を実行するスモークが無い箇所、CI の systemd 検証が実機と乖離する箇所を洗い出し、塞ぐテストを提案すること。
- **E. preflight の拡充**：今日の失敗のうち、開始前に弾けたものはどれか。弾けるものを preflight チェックとして提案すること（env プロファイル完全性は PR #90 で一部実施済み）。
- **F. 承認・回復フローの詰まり**：retry/deploy 承認の独立性、レシートが clean_stopped でないと前進できない箇所など、「安全だが詰まる」箇所の棚卸しと、安全性を落とさない緩和案。

## 成果物

- 調査レポート（日本語）：項目ごとに **証拠／結論／推奨アクション**（やる・やらないの判断材料つき）
- 修正の実装はレポートの提案まで。実装着手は たじゅまる の指示が出てから（分担：Codex は PR 作成＋ローカル全回帰まで、CI 確認とマージ判断はシロ）

## 注意

- 取引ロジック・安全停止条件の変更提案は可。ただし根拠（実測データ）を必ず添えること
- 既存の合意は蒸し返さない：HTTP 429 は即ハードストップ（2026-11-04 合意。回復対象化は却下済み）、自動復旧は検出＋通知のみ、本番稼働中は検証ランを回さない
- リポジトリの場所：`sui-ai-trading-bot/`、記録は `docs/VPS_RECOVERY_AUTOMATION_JA.md` と `docs/DECISIONS_JA.md` にある
