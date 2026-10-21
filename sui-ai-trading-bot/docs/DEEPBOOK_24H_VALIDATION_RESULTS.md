# DeepBook 24時間PAPER検証環境: 実装検証結果

実施日: 2026-10-21。基準: origin/main `167ede8`。作業ブランチ: `codex/deepbook-24h`。

**環境・計測・集計の検証結果です。実際に24時間経過したMainnet PAPER検証の結果ではありません。利用者向け24時間プロジェクトは起動・開始していません。**

## 実施結果

| コマンド                                                                      | 結果                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                                                  | 成功（Windows Node 24.14.0 / pnpm 9.12.3）                                                                                                                                                                                                  |
| `pnpm test`                                                                   | 16ファイル / 254件成功、失敗0（追加30件）                                                                                                                                                                                                   |
| `pnpm test:e2e`                                                               | 72件成功、失敗0（追加8件、375/390/430/1280px）                                                                                                                                                                                              |
| `docker build -f docker/Dockerfile -t suiba-deepbook-24h-verify:20261021 .`   | Windows 11 Docker Desktop / Linuxコンテナで成功                                                                                                                                                                                             |
| `node docker/verify-deepbook-24h.mjs suiba-deepbook-24h-verify:20261021`      | 専用Composeの分離、secret認証、明示計測開始、部分レポート、WAL/SHM、正常再起動、緊急停止・計測ID・履歴保持、LIVE拒否、ログにトークンなしを確認                                                                                              |
| `node docker/verify-compose.mjs suiba-deepbook-24h-verify:20261021 --browser` | 既存Composeの回帰成功。Linuxユニット254件成功。実コンテナの認証済みChromium表示・日本語API監視、ページエラー0。ヘルスチェック、SIGTERM、バックアップ、強制再起動、緊急停止・設定・履歴、LIVE拒否、容量不足でのロールバック/Worker終了も確認 |

合成24時間データのテストでは15秒ごと5,761件の状態記録と1,440周期を集計しました。このテストは集計機能の試験であり、24時間の稼働実績ではありません。

API異常時は計測書き込みより先に既存の即時停止コールバックを呼びます。保存失敗の注入、約定と計測証拠の同一トランザクションのロールバック、未確認の強制終了による合格拒否も検査しました。既存の未来板テストにあった実時計の1ms境界競合は時刻を固定して解消しました。取引の判定条件は変更していません。

最終Linux検証イメージのmanifest: `sha256:5edd5fdab9ec5677d5b2f646850dc61b64085d6df031b11be9a261a4c32c6ab1`。
専用試験プロジェクト: `suiba-deepbook-test-bf249738acaa`。
既存Compose回帰用プロジェクト: `suiba-compose-verify-1744f55f3c8a`。
試験コンテナは停止・除去済み、試験ボリュームとイメージは保存しました。本番のコンテナ・env・DB・ボリュームは操作していません。

## 未実施と残るリスク

- 実Mainnetでの24時間API成功率・応答時間・欠損率・PAPER損益は未計測。DeepBook単独運用の合格判定は出していません。
- 統合試験はSui接続をローカルの到達不能アドレスへ向け、外部DeepBook APIへ追加リクエストを送りません。ネットワーク復旧・遅延等はモック/障害注入テストと区別してください。
- 公開Sui gRPC、DeepBook Indexer、Cetus、Windows/Dockerの経路や停止が依然として稼働を制約します。障害時は既存の停止が維持されます。
- 再構築の無約定確認は既存のIndexer証拠です。全約定の独立オンチェーン照合を新規実装したものではありません。
- 約定・API障害が実際に発生しない試験では、それぞれの安全経路は「未行使」です。実績がないことを実績ありに置き換えません。
- 計測はSQLiteとDockerディスクに依存し、容量不足・強制終了は計測完全性の失敗になります。ログは10MB×3で回転するため、必要時は時刻付きログ保存と停止時バックアップを実施してください。
- 標準Providerの変更、LIVEの有効化、実資金移動、24時間プロジェクトの自動開始、既存データ削除は行っていません。

開始・途中確認・JSON/Markdown出力・停止・再起動・バックアップは [Windows 11手順](DEEPBOOK_24H_PAPER.md) を参照してください。

## 追加・変更ファイル

プロジェクト `sui-ai-trading-bot/` からの相対パス:

- `.dockerignore`
- `.gitignore`
- `README.md`
- `apps/dashboard/src/DeepBookValidation.tsx`
- `apps/dashboard/src/OperationsPanel.tsx`
- `apps/dashboard/src/style.css`
- `apps/worker/src/engine.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/validation-report.ts`
- `apps/worker/src/validation.ts`
- `docker/Dockerfile`
- `docker/compose.deepbook-24h.yaml`
- `docker/deepbook-24h.env.example`
- `docker/deepbook-24h.mjs`
- `docker/verify-compose.mjs`
- `docker/verify-deepbook-24h.mjs`
- `docs/DEEPBOOK_24H_PAPER.md`
- `docs/DEEPBOOK_24H_VALIDATION_RESULTS.md`
- `packages/database/src/index.ts`
- `packages/market-data/src/deepbook.ts`
- `packages/market-data/src/provider.ts`
- `packages/market-data/src/reconstruction.ts`
- `packages/market-data/src/selection.ts`
- `packages/shared/src/api.ts`
- `packages/shared/src/validation-presentation.ts`
- `tests/deepbook-provider.test.ts`
- `tests/deepbook-validation.test.ts`
- `tests/e2e/deepbook-validation.pw.ts`
