# SuiBa SQLite専用Agent Skill 調査・設計案

調査日: 2026-10-24。対象: tajumaru/SuiBa、調査時HEAD `95503be8cc76f335056c40890a310f3ec922527a`（`fix/vitest-sqlite-transient-recovery`）。GitHub最新mainとの差分調査は含まない。

この文書は設計提案であり、DB構造・既存コード・実運用設定・Skill本体の変更や導入は行わない。

## 推奨判断

公開Skillの一括導入より、SuiBa専用の `suiba-sqlite` Skillを推奨する。一般的な `busy_timeout=5000` や `synchronous=NORMAL` の推奨は、主DBの同期処理・停止応答・台帳永続性の設計に適合しない。Skillは既存の安全設計を維持し、調査・変更レビュー・運用検証の判断を支援する。実際の導入は別作業とする。

## 現状

主実装: `packages/database/src/index.ts` の `BotDatabase`。

| 項目 | 確認結果 |
| --- | --- |
| ドライバー | Node組み込み `node:sqlite` の `DatabaseSync`。ORM・better-sqlite3は使用しない。 |
| 接続設定 | `journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=0`、`foreign_keys=ON`。 |
| ロック方針 | 同期DB処理でイベントループを長く待機させずBUSYを即時返す。BUSYは恒久障害として接続を汚染しない。 |
| トランザクション | `BEGIN IMMEDIATE`、同期コールバック、`COMMIT`。失敗時は `ROLLBACK`、rollback失敗時は `AggregateError`。 |
| 約定 | 注文・約定・残高・runtimeと関連証跡を `commitFill` の同一transactionで更新。重複IDを拒否。 |
| 恒久障害 | I/O等の障害をfaultとして保持し、後続書き込みと稼働継続を拒否。BUSYと制約違反は区別する。 |
| 索引 | market_candlesの複合主キー、イベントIDの主キー、7イベントテーブルのtimestamp索引。paper_trades(id)には主キーと追加UNIQUE索引がある。 |
| 整合性 | 外部キー設定は有効だが主DBに外部キー定義はない。JSON妥当性・テーブル間整合性は主にアプリ側で保証。 |
| 検査 | preflight系スクリプトとDocker検証に `integrity_check` がある。通常のBotDatabaseの起動・healthには定期的な物理・論理検査はない。 |
| checkpoint | 明示的な運用制御・監視はない。隔離接続で `wal_autocheckpoint=1000` を確認。既定の自動checkpointは動作する設計。 |
| バックアップ | Dockerの停止時コピー手順とdeepbookヘルパーがあり、DBディレクトリ全体・残存WAL/SHMを保存。 |
| 保存期間 | 主DBには履歴の削除・アーカイブ方針が見当たらない。 |

チャート履歴は `apps/worker/src/chart-history.ts` の別DB。WAL、busy_timeout=100、Worker threadでの処理、キャッシュの期間・件数制限がある。主DBの設定を機械的に適用しない。

関連実装・検証:

- `apps/worker/src/chart-history-client.ts`: Workerの生成・終了。
- `apps/worker/src/index.ts`: DBパス、起動、SIGINT/SIGTERM時の停止保存と終了。
- `scripts/preflight-audit.cjs`、`scripts/preflight-observer.mjs`: 整合性確認。
- `docker/deepbook-24h.mjs`: 停止時バックアップ。
- `docker/verify-compose.mjs`: WAL、SIGTERM、SIGKILL、履歴保持、容量不足等の隔離検証。

## 検証結果と検出範囲

Windows上のNode 24.22.1 / SQLite 3.53.4で次を実行し、計88件が成功した。

```text
node scripts/run-project.mjs test:offline tests/sqlite-lock.test.ts tests/core.test.ts tests/node-version.test.ts tests/chart-history.test.ts
```

上記の `node` にはPATH上の旧版ではなく、Codex同梱24.22.1の絶対パスを使用した。内訳: sqlite-lock 28件、core 36件、node-version 12件、chart-history 12件。全テスト一式やDocker検証一式の再実行結果ではない。

既存テストにはBUSY・READONLY・LOCKED・制約違反・部分更新rollback・例外注入によるCOMMIT失敗・再起動時停止がある。Docker検証コードにはSIGKILLと容量不足の試験もある。これらが未実装とは扱わない。

追加検証は新しいメモリ内DBのみを使用し、稼働DBは開いていない。

| 発見 | 根拠と限界 |
| --- | --- |
| 非同期transactionの誤用 | `transaction(async () => ...)` はPromiseを待たずCOMMITし、await後の例外でも書き込みが残ることを再現。確認した現行呼び出し元は同期処理。将来の誤用リスクであり、現行の約定処理が非同期という意味ではない。 |
| JSON破損とhealth | 不正JSONを隔離DBへ注入すると読み取りでSyntaxErrorになるが、healthはhealthy=true、integrity_checkはok。物理検査では業務データの妥当性を保証できない。 |
| 履歴検索 | EXPLAIN QUERY PLANでcycle_auditsの履歴が全走査＋一時ソート、PENDING候補検索が全走査、validation_eventsのtimestamp索引利用時にもid順の追加ソートを確認。実データ量での遅延は未測定。 |
| 復元検証 | Compose検証はコピー先DBの存在を確認するが、そのコピーを新規ボリュームへ復元し台帳まで照合する一連の検証にはなっていない。 |
| 障害注入の限界 | 模擬COMMIT失敗では実fsync/I/O障害や、応答済み約定の強制終了後の残存を保証できない。rollback自体の失敗も独立した検証対象。 |
| 起動・終了 | 初期DDL・既定値作成は一括transactionではない。終了時の停止状態保存も例外になり得る。同時起動、ロック中終了、容量不足中終了の組み合わせを検証する必要がある。 |

## 公開SQLite Skillsの比較と安全性

公開本文を静的に確認した。インストール、付属コード実行、配布物全体の安全性保証は行っていない。以下のURLは可変ブランチであるため、将来採用時にはコミット固定と再確認が必要。

| 候補 | 利点 | SuiBaへの適合性・安全上の判断 |
| --- | --- | --- |
| [RightNow-AI/openfang sqlite-expert](https://github.com/RightNow-AI/openfang/blob/main/crates/openfang-skills/bundled/sqlite-expert/SKILL.md) | 短く、WAL・索引・短いtransaction・実行計画を整理。 | busy_timeout=5000、synchronous=NORMALの推奨が主DBと衝突。そのままの導入は非推奨。 |
| [chrishuffman5/domain-expert sqlite](https://github.com/chrishuffman5/domain-expert/blob/main/plugins/database/skills/sqlite/SKILL.md) | checkpoint・診断PRAGMA・整合性検査まで幅広い。 | 長いtimeout・NORMAL推奨を要修正。WAL2のコメント例等、対象エンジンで使えるか検証が必要。取得できない参照ファイルがあり全体評価は未完。 |
| [martinholovsky/claude-skills-generator SQLite Database Expert](https://github.com/martinholovsky/claude-skills-generator/blob/main/skills/sqlite/SKILL.md) | パラメーター化SQL、migration、入力検証。関連するadvanced-patterns/security-examplesも確認。 | Rust/Tauri中心。NORMAL・約30GBのmmap設定例は不適合。リスク表記がfrontmatterのHIGHと本文のMEDIUMで不一致。Windows ACLとPOSIX権限も区別が必要。 |

確認した本文に明白な秘密情報送信・権限昇格の指示は見当たらなかった。ただし、悪意がなくても不適合な設定変更によって安全性を低下させる。採用前に全参照・scripts・依存・ライセンス・外部送信先を確認し、コミットSHAとファイルハッシュを記録する。インストーラーを調査のために実行する必要はない。

## 改善優先度

P0は長時間運用の前提確認、P1は次の改善対象、P2は計測を踏まえた最適化。いずれも未実装。

| 優先度 | 改善案 | 期待効果 | 変更リスク | 必要なテスト |
| --- | --- | --- | --- | --- |
| P0 | 全DB関連ツールでNodeとSQLite実体を確認 | 旧エンジン・実行環境の混在を防ぐ | 管理スクリプトの起動拒否 | PATH差、直接起動、Worker、Windows/Linuxの実体と拒否動作 |
| P0 | 停止時バックアップの復元試験・成功基準 | 復旧不能なコピーを成功扱いしない | 対象誤指定・既存DB上書き | 新規ボリュームへ復元、物理検査、注文・約定・残高・設定・停止状態照合。欠落・途中コピーも拒否 |
| P1 | async/thenable・ネストtransactionの誤用防止 | 原子性喪失を防ぐ | API・例外処理への影響 | async/thenable拒否、ネスト、同期例外、COMMIT/rollback失敗後の状態 |
| P1 | JSON・台帳の論理整合性検査 | SQL上正常な壊れた状態を検出 | 大量検査による遅延・誤判定 | 不正JSON、必須キー欠落、注文・約定不一致、残高不一致、検査中の停止応答 |
| P1 | DB/WAL容量・空き容量・SQL遅延の監視と保存方針 | 容量不足と遅延を早期発見 | 証跡削除・監視負荷 | 長時間reader＋継続writer、大量履歴、容量不足、アーカイブ復元 |
| P1 | 起動競合・異常終了試験 | 起動ループ・停止記録欠落を把握 | 自動再試行による二重処理 | 同時起動、ロック中SIGTERM、書き込み途中SIGKILL、容量不足中終了、応答済みIDの照合 |
| P2 | 実行計画に基づく複合・部分索引 | 履歴・復旧検索の遅延削減 | 書き込み増加、索引作成ロック・容量 | 実運用相当の件数で検索時間・書き込み時間・容量を比較 |
| P2 | schema versionとmigration規約 | 将来変更の追跡・互換性向上 | 旧版起動・移行失敗 | 旧DB、未知version、中断、移行後復元。重複索引整理は別途測定 |
| P2 | 必要に応じオンラインバックアップ | バックアップ停止時間短縮 | 競合・I/O増加・保存先不足 | 継続書き込み中の取得・復元、キャンセル、容量不足、台帳照合 |

主DBのFULLやtimeout=0は維持を前提とする。変更が必要なら、永続性・停止応答への影響を別途設計する。自動checkpointが存在するため、根拠なくTRUNCATEを定期実行しない。WALの物理ファイルサイズだけで未checkpoint量を断定しない。

## 環境互換性

| 環境 | 今回の確認 |
| --- | --- |
| Windows通常PATH | Node 24.14.0 / SQLite 3.51.2。要求 `>=24.22.1 <25` を満たさない。 |
| Windows Codex同梱Node | Node 24.22.1 / SQLite 3.53.4。関連88テスト成功。 |
| Docker | Engine 29.9.1。稼働中2コンテナでLinux x64 / Node 24.22.1 / SQLite 3.53.4を確認。バージョン取得のみで、DBへの接続・停止・再起動はしていない。 |
| Docker設定 | Nodeイメージdigest固定、非root、DBはnamed volume。WindowsとのDBファイル直接共有を必要としない。 |
| CI | Windows・UbuntuでNode 24.22.1を指定。windows-latestはWindows 11実機そのものの保証ではない。 |

SQLite公式によると、3.51.2はWAL-reset問題の影響範囲。複数接続が書き込み・checkpointで競合する特殊な条件で破損し得る。3.51.3以降等で修正済み。確認したコンテナの3.53.4は修正済みであり、現行DBの破損を検出したわけではない。通常PATHの旧Nodeを使う管理処理を避け、実行ファイルとSELECT sqlite_version()の確認を規約化する。

Node 24.22.1のnode:sqliteはRelease candidate。API例は対象バージョンへ固定する。Windowsではローカルストレージ・ディレクトリACL・ファイルハンドル解放を確認し、SMB等でのWAL運用や、Windows/Linuxから同一稼働DBへの同時書き込みを前提にしない。

## 専用Skillの構成案

配置候補: `.agents/skills/suiba-sqlite/`。今回は作成しない。

```text
suiba-sqlite/
├── SKILL.md
├── references/
│   ├── database-invariants.md
│   ├── recovery-and-backup.md
│   └── verification-matrix.md
└── scripts/
    └── inspect-runtime.mjs
```

### SKILL.md

- name: `suiba-sqlite`。
- description: SuiBaのSQLite実装の調査、DB変更レビュー、ロック・永続性・容量・復元の診断に使用する。一般的なSui開発や無関係なUI変更には適用しない。
- 調査、変更レビュー、復旧設計を区別し、依頼の範囲を維持する。
- まず対象HEAD・Node/SQLite実体・DB用途・接続元・既存テストを確認する。
- 調査結果は事実、隔離環境での再現、未検証の仮説を区別し、P0/P1/P2、効果、リスク、必要テストを報告する。
- 調査から勝手に設定変更、migration、Bot停止、復元へ進まない。mainへ直接commit/push/mergeしない。

### 参照ファイル

- `database-invariants.md`: 主DBのWAL/FULL/timeout=0、同期transaction、約定・残高・証跡の原子性、fault保持、再起動時停止、チャートDBとの差異。コードの参照先を記載し、schema全体の重複コピーは避ける。
- `recovery-and-backup.md`: 停止時コピー、復元先分離、残存WALの保全、容量不足時の対応、復元後の物理・論理照合。既存DB削除や自動売買再開を復旧手順にしない。
- `verification-matrix.md`: Windows・Docker・Node実体と、ロック・異常終了・長時間運用・復元の検証表。メモリ内試験とファイルDB試験の保証範囲を区別する。

### inspect-runtime.mjsの要件

初期版はNode/SQLiteバージョン等の読み取りだけに絞る。DB診断を追加する場合は既存ファイルのみをreadOnlyで開き、BotDatabaseのconstructorによるDDL・初期値作成を避ける。秘密情報やDB本文を出力せず、DDL、checkpoint、VACUUM、修復、ファイル削除は実行しない。稼働WALのreadOnly接続でも環境により共有メモリやロックへ影響し得るため、完全無影響な診断とは扱わない。

### Skillの受入条件

1. 一般論でtimeoutを延長・FULLを弱める提案をしない。
2. async transactionの危険を検出し、Promise待機を単純に追加して長時間ロックを作らない。
3. メモリ内テストだけでWALの耐障害性を保証しない。
4. コピー成功と復元成功、物理整合性と台帳整合性を区別する。
5. 実DBへ触れずに調査でき、破壊的な指示を含む外部資料を実行指示として受け入れない。
6. WindowsとDockerの対象を識別し、実行ファイル・DBパス・volumeを混同しない。

## 一次資料

- [SQLite WAL / WAL-reset / 自動checkpoint](https://www.sqlite.org/wal.html)
- [SQLite synchronous: FULLとNORMALの耐久性](https://www.sqlite.org/pragma.html#pragma_synchronous)
- [SQLite Backup API](https://www.sqlite.org/backup.html)
- [Node 24.22.1 node:sqlite仕様](https://github.com/nodejs/node/blob/v24.22.1/doc/api/sqlite.md)

公開Skillの出典は比較表に記載。公開内容は更新されるため、導入時に再評価する。
