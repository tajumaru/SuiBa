# 板履歴アーカイブの永続化・検証・復元（2026-10-26）

PR #16最終指摘対応。作業開始時に取得したmainは8881fb2。既存ブランチへmergeして追従し、PR #17の修正は含めない。

## 削除を許可する順序

workerを終了し、DBのバックアップを取得してから明示保守CLIを実行する。runtime.runningだけでなくpaper_safety.resumePendingもトランザクション内で拒否する。通常workerによる自動削除は引き続き無効。

1. BEGIN IMMEDIATE、停止確認、削除候補のID・SQL時刻・JSONを固定。
2. 最終パスをwx（排他的新規作成）で開く。既存ファイルを上書きしない。
3. 内容を書き込み、ファイルfdをfsyncしclose。
4. 再読込、期待SHA-256との一致、形式・行ID重複・時刻・JSONオブジェクトを検証。
5. Linuxで親ディレクトリfdをO_DIRECTORYで開き、fsyncしclose。失敗・非対応なら例外にし、DB行を削除しない。
6. 完全一致する元行だけDELETE、receiptを同じDBトランザクションにINSERT、COMMIT。

renameは不要。最終名を排他的作成して同期するため、別の公開名への変更はない。途中失敗したファイルは残すが、成功receiptがないファイルを削除完了の証拠として扱わない。COMMIT失敗時は元行とreceiptをロールバックし、余分なアーカイブだけ残り得る。再試行には新しい一意のファイル名を使用する。失敗ファイルの自動上書き・再利用・削除は行わない。

## OS別の保証範囲

- Linux: ファイル内容のfsyncだけでは新規ディレクトリエントリの永続化を保証できない。親ディレクトリのfsyncも要求する。[Linux fsync仕様](https://man7.org/linux/man-pages/man2/fsync.2.html)。既に永続化された保存先ディレクトリを事前に用意し、OS/ファイルシステム/デバイスが同期要求を正しく履行するローカルストレージで使う。新規作成した祖先ディレクトリ、ネットワークFS、機器の虚偽のflush成功、媒体破損・後日のファイル紛失まで保証するものではない。
- Windows: [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)にはファイルやボリューム向けの手段があり、ディレクトリhandleには[FILE_FLAG_BACKUP_SEMANTICS](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)が必要。これらの存在をNode標準APIでの検証済みディレクトリ永続化保証と同一視しない。本実装は`BOOK_ARCHIVE_DIRECTORY_SYNC_UNSUPPORTED`で削除を拒否する。ネイティブ補助・ボリュームflush・特権取得や強制続行のオプションは追加しない。
- Linux以外も削除を拒否。Windowsでも検証・復元ツールは使用可能。LinuxコンテナでWindowsホスト共有フォルダの永続化を保証するとは主張しない。ローカルLinuxボリュームで確認する。

## 検証・復元手順

先にworkerを終了し、DB・WALを一貫した方法でバックアップする。アーカイブも別媒体へバックアップする。ハッシュは`book_history_archives`の該当receipt、または別途保管した信頼済みマニフェストから取得する。疑わしいファイル自身から計算したハッシュだけでは完全性の証明にならない。

プロジェクトディレクトリで、指定Nodeバージョンを使用する。

```text
node --import tsx scripts/book-history-archive.ts verify archives/book-20261026.json <trusted-sha256>
node --import tsx scripts/book-history-archive.ts restore archives/book-20261026.json <trusted-sha256> data/restored.sqlite
```

まずバックアップから作った別の停止DBへ復元し、件数・ID・SQL時刻・JSONと比較入力を確認する。restoreは元の文字列をそのままINSERTする。同一ID・同一内容はスキップして冪等、不一致があればバッチ全体をロールバックし、既存行を上書きしない。runningまたはresumePendingがあるDBには復元しない。CLIは検証してから復元先DBを開く。検証のみではDBを開かない。

復元で注文・約定・台帳・戦略判断は追加も削除もしない。複数ファイルを統合する場合は信頼済みハッシュを個別に検証し、重複・矛盾・観測時刻の順序を確認してから比較する。

## 検証と限界

書込・file fsync・再読込・ハッシュ破損・directory open/fsyncの失敗注入でDB行とreceiptが残ることを検証する。Linuxでは実ディレクトリ同期と削除の順序を検証し、DEFERRABLE外部キー制約による実COMMIT失敗、同一パス再試行の拒否、新しいパスでの成功を検証する。

別プロセスを削除直前・削除直後（未COMMIT）・COMMIT後に強制終了し、前2つは元行が保持され、COMMIT後はreceiptのハッシュでアーカイブを検証できることを確認する。これは電源断に関連する処理境界・DB原子性の試験であり、物理電源断やカーネル/デバイスキャッシュの喪失を再現した試験ではない。

全行・候補・シリアライズ・再読込をメモリに持ち、I/O中も書込ロックを保持する制約は残る。巨大履歴の分割処理・本番ディスクの長期検証・実測市場の収益性と校正は未実施。新戦略のworker登録・通常運用有効化・勝率表示は行わない。

Windows / Node v24.22.1: Node標準45件、Vitest898件成功・9件スキップ（Linux専用の削除成功/同期/クラッシュ試験）、型チェック・Vite build成功。既存digest固定のLinux/Node v24.22.1 Docker build成功。Linuxの実同期・境界・rollback試験もネットワーク無効コンテナで実行する。遅いDocker同期I/Oでは通常の5秒テスト制限を超えるため、ローカルLinux検証コマンドだけtestTimeout=60000/直列実行を指定。複数子プロセスを使うCLI試験には30秒を設定し、fsync試験間でイベントループを解放してテストツールの通知を処理する。製品のタイムアウト・リスク制限は変更しない。
