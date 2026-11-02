# ドキュメント索引

このフォルダの文書の置き場所ルール：

- **現行の仕様・運用手順・未決の設計**はこのフォルダ直下に置く。
- **一時点の調査・検証結果・レビュー記録**は `archive/` に置く（内容は当時の記録として保持し、現在の仕様とは限らない）。
- 検証の生データは `evidence/`、モバイル復旧検証のログ一式は `verification/` にある。
- リポジトリ直下の `docs/SUI_GRPC_P0_IMPLEMENTATION.md`（Sui gRPC P0実装記録）も現行の参照先。

## 現行ドキュメント

| ファイル | 作成日 | 内容 | 備考 |
|---|---|---|---|
| [API_DOCKER_V1_1.md](API_DOCKER_V1_1.md) | 2026-10-22 | API安定化・Docker運用 1.1（Windows 11） | 運用手順（READMEから参照） |
| [BACKTEST_V2.md](BACKTEST_V2.md) | 2026-10-22 | Profit Guard対応バックテスト2.0 |  |
| [CHART_HISTORY_SYNC.md](CHART_HISTORY_SYNC.md) | 2026-10-22 | 7日履歴・価格/RSI/MACD同期の設計と実測 |  |
| [DEEPBOOK_24H_PAPER.md](DEEPBOOK_24H_PAPER.md) | 2026-10-22 | DeepBook 24時間PAPER検証（Windows 11） |  |
| [DEEPBOOK_P0_SCHEDULER.md](DEEPBOOK_P0_SCHEDULER.md) | 2026-10-22 | DeepBook P0: 取得周期・鮮度監視・停止診断 |  |
| [DEEPBOOK_PROVIDER_VALIDATION.md](DEEPBOOK_PROVIDER_VALIDATION.md) | 2026-10-22 | DeepBook市場データの実動作検証とProvider統合 | Provider設定・品質条件の現行リファレンス（READMEから参照） |
| [DEEPBOOK_SKILLS.md](DEEPBOOK_SKILLS.md) | 2026-10-22 | DeepBook公式Agent Skills |  |
| [EASY_SETTINGS_V1_1.md](EASY_SETTINGS_V1_1.md) | 2026-10-22 | かんたん設定 1.1 | 現行仕様（1.0はアーカイブ） |
| [GECKO_TIMEOUT_INVESTIGATION.md](GECKO_TIMEOUT_INVESTIGATION.md) | 2026-10-22 | GeckoTerminal通信失敗・PAPER異常停止の調査 | 24時間再テスト手順を含む（READMEから参照） |
| [LINUX_PAPER_RELEASE_V1_JA.md](LINUX_PAPER_RELEASE_V1_JA.md) | 2026-10-30 | Linux常駐・PAPER停止配備 / rollback v1 |  |
| [PAPER_BACKUP_ENCRYPTION_V1_JA.md](PAPER_BACKUP_ENCRYPTION_V1_JA.md) | 2026-10-30 | PAPERバックアップの認証付き暗号化 v1 |  |
| [PAPER_DEPLOYMENT_SAFETY_V1_JA.md](PAPER_DEPLOYMENT_SAFETY_V1_JA.md) | 2026-10-30 | PAPER配備安全性：第1段階の実装と保守手順 |  |
| [PAPER_NETWORK_RECOVERY_P0.md](PAPER_NETWORK_RECOVERY_P0.md) | 2026-10-23 | PAPER通信障害・安全停止・復旧制御（P0） | 復旧制御の現行仕様 |
| [PAPER_OPERATIONS_V1.md](PAPER_OPERATIONS_V1.md) | 2026-10-22 | PAPER運用検証 1.0 |  |
| [PR35_SECURITY_REVIEW_PACKET_JA.md](PR35_SECURITY_REVIEW_PACKET_JA.md) | 2026-10-31 | PR #35 第三者セキュリティレビュー資料 | 第三者レビュー提出資料（2026-10-31、直近のため直下に保持） |
| [PRICE_CHART_UI.md](PRICE_CHART_UI.md) | 2026-10-22 | SUI/USDCチャートの期間・日時・操作 |  |
| [PROFIT_GUARD.md](PROFIT_GUARD.md) | 2026-10-22 | ProfitGuard：mainとの差分と設計・検証 | 現行仕様（READMEから参照） |
| [REAL_TRADING_TRADECAP_DESIGN_20261025.md](REAL_TRADING_TRADECAP_DESIGN_20261025.md) | 2026-10-25 | REAL（実売買）モード設計書 ― DeepBook v3 TradeCap 委任方式 | 設計書・Phase 2未決（§11） |
| [SUIBA_NAUTILUS_DESIGN_V2_JA.md](SUIBA_NAUTILUS_DESIGN_V2_JA.md) | 2026-10-26 | SuiBa × Nautilus 調査・設計 第2版 | 設計・検討中 |
| [UI_UX_PRO_MAX.md](UI_UX_PRO_MAX.md) | 2026-10-22 | UI UX Pro Max の導入 |  |
| [VALIDATION_UI_FLOW.md](VALIDATION_UI_FLOW.md) | 2026-10-23 | 運用検証ページ：操作とAPIの対応 |  |
| [WALRUS_SITES_CLOUD_ARCHITECTURE_20261030_JA.md](WALRUS_SITES_CLOUD_ARCHITECTURE_20261030_JA.md) | 2026-10-30 | SuiBa — Walrus Sites公開・24時間クラウド稼働 設計調査 | 設計調査・検討中 |
| [WAL_USDC_IMPLEMENTATION_JA.md](WAL_USDC_IMPLEMENTATION_JA.md) | 2026-10-29 | WAL/USDC追加：調査・実装・PAPER検証計画 |  |
| [paper-recovery-state-machine.md](paper-recovery-state-machine.md) | 2026-10-26 | PAPER復旧ステートマシン | 復旧ステートマシン仕様 |

## アーカイブ（archive/）

当時の調査・結果・レビューの記録。結論が現在の実装と異なる場合がある。
主な置き換え：かんたん設定1.0 → 1.1（現行）、パターン再認証の設計 → パターン方式自体を廃止（2026-10-27）、さくらVPS関連 → 田嶋の判断で検討終了。

| ファイル | 作成日 | 内容 |
|---|---|---|
| [AUTOLOCK_PATTERN_REAUTH_DESIGN_20261027_JA.md](archive/AUTOLOCK_PATTERN_REAUTH_DESIGN_20261027_JA.md) | 2026-10-27 | SuiBa 自動ロック・パターン再認証：現状調査・詳細設計 |
| [DASHBOARD_P1_REPORT.md](archive/DASHBOARD_P1_REPORT.md) | 2026-10-22 | DeepBook欠損監査とダッシュボード通信削減 |
| [DEEPBOOK_24H_VALIDATION_RESULTS.md](archive/DEEPBOOK_24H_VALIDATION_RESULTS.md) | 2026-10-22 | DeepBook 24時間PAPER検証環境: 実装検証結果 |
| [DEEPBOOK_5M_GAP_INVESTIGATION.md](archive/DEEPBOOK_5M_GAP_INVESTIGATION.md) | 2026-10-22 | DeepBook 5分足43欠損の原因と検証付き再構築 |
| [DEEPBOOK_GAPS_48_P1.md](archive/DEEPBOOK_GAPS_48_P1.md) | 2026-10-22 | DeepBook欠損48本の調査 |
| [DEEPBOOK_TIMEOUT_20261022.md](archive/DEEPBOOK_TIMEOUT_20261022.md) | 2026-10-22 | DeepBook通信タイムアウト調査・対策（2026/10/22 日本時間） |
| [DEEPBOOK_TIMEOUT_FOLLOWUP_20261023.md](archive/DEEPBOOK_TIMEOUT_FOLLOWUP_20261023.md) | 2026-10-23 | DeepBook本文タイムアウト・安全停止の追加調査 |
| [DEEPBOOK_VALIDATION_UI.md](archive/DEEPBOOK_VALIDATION_UI.md) | 2026-10-22 | DeepBook 24時間検証画面の表示改善 |
| [EASY_SETTINGS_V1.md](archive/EASY_SETTINGS_V1.md) | 2026-10-22 | かんたん設定 1.0 |
| [ESET_NETWORK_INVESTIGATION_20261022.md](archive/ESET_NETWORK_INVESTIGATION_20261022.md) | 2026-10-22 | ESETとDeepBook通信の追加調査（2026-10-22） |
| [MOBILE_RECOVERY_UI_20261027_JA.md](archive/MOBILE_RECOVERY_UI_20261027_JA.md) | 2026-10-27 | モバイルUI・復旧導線の改善 |
| [MULTI_CURRENCY_FEASIBILITY_2026-10-22.md](archive/MULTI_CURRENCY_FEASIBILITY_2026-10-22.md) | 2026-10-22 | SuiBa マルチ通貨対応可否の事前調査 |
| [NETWORK_SAFETY_HARDENING_20261026.md](archive/NETWORK_SAFETY_HARDENING_20261026.md) | 2026-10-26 | 通信安定性・安全停止機構の調査と強化 |
| [NODE_24_OFFLINE_RESULTS.md](archive/NODE_24_OFFLINE_RESULTS.md) | 2026-10-24 | Node 24.22.1 オフライン検証記録 |
| [NODE_DOCKER_30M_PREFLIGHT.md](archive/NODE_DOCKER_30M_PREFLIGHT.md) | 2026-10-24 | 30分独立実通信検証：Docker事前確認と承認後手順 |
| [NODE_RUNTIME_FINAL_REPORT.md](archive/NODE_RUNTIME_FINAL_REPORT.md) | 2026-10-24 | Node 24.22.1適用・独立Docker事前確認 最終報告 |
| [NODE_RUNTIME_INVESTIGATION.md](archive/NODE_RUNTIME_INVESTIGATION.md) | 2026-10-24 | Node.jsバージョン不一致の原因調査 |
| [OPERATIONS_UI_REDESIGN_RESULT.md](archive/OPERATIONS_UI_REDESIGN_RESULT.md) | 2026-10-23 | 運用検証ページ UI 改善結果 |
| [PAPER_24H_RUN1_FINAL_REPORT.md](archive/PAPER_24H_RUN1_FINAL_REPORT.md) | 2026-10-23 | PAPER 24時間運用テスト 第1回 終了監査 |
| [PAPER_RUN2_PREFLIGHT_REPORT.md](archive/PAPER_RUN2_PREFLIGHT_REPORT.md) | 2026-10-23 | 第2回PAPER運用前・2時間通信安定性検証 |
| [PAPER_RUN2_READINESS.md](archive/PAPER_RUN2_READINESS.md) | 2026-10-23 | 第2回24時間PAPER運用テスト P0改善・開始判定 |
| [PAPER_ZERO_TRADES_INVESTIGATION.md](archive/PAPER_ZERO_TRADES_INVESTIGATION.md) | 2026-10-23 | 3101 PAPER売買0件の原因調査 |
| [PERFORMANCE_AUDIT.md](archive/PERFORMANCE_AUDIT.md) | 2026-10-23 | SuiBa 全体性能診断・高速化計画 |
| [PERFORMANCE_DISPLAY_AGGREGATION.md](archive/PERFORMANCE_DISPLAY_AGGREGATION.md) | 2026-10-23 | 表示用集計高速化 第1弾 |
| [PR25_FINAL_REVIEW_JA.md](archive/PR25_FINAL_REVIEW_JA.md) | 2026-10-29 | PR #25 最終レビュー |
| [PR2_FINAL_REVIEW.md](archive/PR2_FINAL_REVIEW.md) | 2026-10-24 | PR #2 最終レビュー・検証記録 |
| [PR32_FINAL_REVIEW_JA.md](archive/PR32_FINAL_REVIEW_JA.md) | 2026-10-31 | PR #32 マージ前レビュー（2026-10-31） |
| [PR9_PREMERGE_REVIEW_20261025.md](archive/PR9_PREMERGE_REVIEW_20261025.md) | 2026-10-25 | PR #9 マージ前確認・追加修正 |
| [PREFLIGHT_30M_20261024.md](archive/PREFLIGHT_30M_20261024.md) | 2026-10-24 | 独立Docker・30分実通信観測 結果 |
| [SAKURA_DEPLOY_BROKER_JA.md](archive/SAKURA_DEPLOY_BROKER_JA.md) | 2026-10-31 | さくらVPS: 最小権限・停止状態配備broker |
| [SAKURA_SSH_PREFLIGHT_JA.md](archive/SAKURA_SSH_PREFLIGHT_JA.md) | 2026-10-31 | さくらVPS: Actions専用SSH準備と接続確認（未実施） |
| [SAKURA_VPS_JA.md](archive/SAKURA_VPS_JA.md) | 2026-10-31 | さくらVPS運用準備（PAPER限定） |
| [SQLITE_LOCK_P1_INVESTIGATION.md](archive/SQLITE_LOCK_P1_INVESTIGATION.md) | 2026-10-24 | SQLiteロック待ち P1 原因調査・方式選定 |
| [SQLITE_LOCK_P1_REPORT.md](archive/SQLITE_LOCK_P1_REPORT.md) | 2026-10-24 | SQLiteロック待ち P1 最終報告 |
| [SUI_GRPC_RESILIENCE_INVESTIGATION.md](archive/SUI_GRPC_RESILIENCE_INVESTIGATION.md) | 2026-10-24 | Sui gRPC通信耐久力：原因調査と改善案 |
| [SUI_P0_ADDITIONAL_REVIEW.md](archive/SUI_P0_ADDITIONAL_REVIEW.md) | 2026-10-24 | Sui P0追加レビュー・安全性検証 |
| [SUI_RPC_STOP_FOLLOWUP_20261027.md](archive/SUI_RPC_STOP_FOLLOWUP_20261027.md) | 2026-10-27 | Sui停止調査：実ソケット検証と停止経路の追加再現 |
| [SUI_RPC_STOP_INVESTIGATION_20261027.md](archive/SUI_RPC_STOP_INVESTIGATION_20261027.md) | 2026-10-27 | Sui取得失敗とBot停止：最新main重点調査 |
| [UI_UX_REDESIGN_PLAN.md](archive/UI_UX_REDESIGN_PLAN.md) | 2026-10-22 | SuiBa UI/UX 全面刷新：診断・設計計画 |
| [VALIDATION.md](archive/VALIDATION.md) | 2026-10-22 | 検証記録 — 2026-10-20 (JST) |
| [VALIDATION_UI_RESULTS.md](archive/VALIDATION_UI_RESULTS.md) | 2026-10-23 | 運用検証UIの検証結果 |
| [VITEST_SQLITE_TRANSIENT_RECOVERY.md](archive/VITEST_SQLITE_TRANSIENT_RECOVERY.md) | 2026-10-24 | Vitest collection and SQLite transient recovery |
| [WAL_POST_MERGE_REVIEW_20261029_JA.md](archive/WAL_POST_MERGE_REVIEW_20261029_JA.md) | 2026-10-29 | WAL追加レビュー（2026-10-29） |
| [WINDOWS_2H_INVESTIGATION_20261024.md](archive/WINDOWS_2H_INVESTIGATION_20261024.md) | 2026-10-24 | Windows無人検証・2時間通信観測の調査結果 |
| [WINDOWS_2H_QUALITY_GATES_20261025.md](archive/WINDOWS_2H_QUALITY_GATES_20261025.md) | 2026-10-25 | Windows 2時間検証：品質ゲート修正と保存証拠の再評価 |
| [WINDOWS_ONECLICK_IMPLEMENTATION_20261024.md](archive/WINDOWS_ONECLICK_IMPLEMENTATION_20261024.md) | 2026-10-24 | Windowsワンクリック通信観測：実装・検証報告 |
| [paper-recovery-additional-review.md](archive/paper-recovery-additional-review.md) | 2026-10-26 | PR #17 追加安全レビュー（2026-10-26） |
