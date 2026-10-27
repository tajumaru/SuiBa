# 検証証拠

## 追加検証（最新main e90840d）

対象：`e90840d916166c58cc040d48e72f2aa606bd557f`。Node v24.22.1。製品コード・依存・lock・既存offline configの変更なし。[追加報告](../../SUI_RPC_STOP_FOLLOWUP_20261027.md)。

| 証拠                             | 結果                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loopback-vitest.json`           | 6ファイル74成功・失敗0・skip0。以前skipした8件、対象外だったDeepBook transport21件／settings API1件を含む。ガード4件も含み、74件すべてが実ソケット試験ではない |
| `offline-vitest-followup.json`   | 最新main上で69ファイル983成功・失敗0・8skip。skip8件は上記loopback suiteで別途成功済み。既存socket禁止setup・除外設定を維持                                    |
| `focused-recovery-followup.json` | 最終fixture調整後のEngine36件＋Sui health14件、計50件成功・失敗0・skip0                                                                                        |
| Node標準／型検査                 | 45件成功／TypeScript成功                                                                                                                                       |

追加再現5件：429→retry成功後の停止理由保持、片coin障害2周期→正常復旧、片coin障害4周期→180秒上限停止、HEALTH/MARKET二重加算、補助balance失敗と遅延health成功の競合。loopback suiteには既存オフライン回帰と重複する試験もあるため、件数を単純加算して独立した試験総数とはしない。

loopbackは専用runner/preloaderで外部TCP接続とwildcard bindを拒否。子processおよびexecArgv空のworker threadにもガードを適用する。settings APIは新規テストworker・動的localhostポート・新規一時DB・生成テスト認証値のみ。稼働Bot／DB／Dockerへの操作・接続、外部Sui／DeepBookへの要求はなし。初回sandbox内のlocalhost接続EACCESは、ガードを維持した許可済みsandbox外実行で切り分けた。

以下は前回検証の履歴。

## 前回検証（main 1d550fb）

基点main `1d550fbc56f1be9f38cc0fd10a574b3849735857`。Node.js v24.22.1、Windows x64、Vitest 3.2.7、SDK @mysten/sui 2.37.0。productionファイル変更0。

- `historical-extract.json`：退避JSONLをオフライン再集計。元SHA256 `fd22a73695a3a4e9a707c87cc84049290513db28d6c574b9b0fb69bc156769a4`、1,508行、Sui失敗5件、失敗周期4件。元実行SHAは8b05f2a、稼働中Bot停止の最新mainログではない。coin未記録。元の行番号と次sampleを保持。
- `offline-vitest.json`：最終の全オフラインVitest結果。最終実行時刻はJSONのstartTimeに保存。67ファイル、965成功・0失敗・8skip、success=true。socket拒否setupを維持。skip8件および対象外2ファイルは既存offline configの実loopback等で、新規除外は追加していない。
- Node標準テスト45件成功（同じtest:offlineランナーの前段）。TypeScript型検査成功。
- 新規7ケース：gRPC14／metadata欠損／decimals不正／decode／HTTP403のEngine停止と回復後ラッチ、補助balance DNSのtick外pause、SDK欠損balanceの0補完。

最初の全体実行は964成功・1失敗・8skip。失敗は既存レポート出力試験のOS一時ディレクトリrename EPERM。TEMP/TMPを専用worktreeの`data/offline-tmp`へ限定した再実行は全件成功。製品実装は変更していない。追加テスト作成時には共通breakerのfixture後処理不足でも失敗し、成功probeによる隔離を加えて解消した。

ローカル依存は既存インストールから専用worktreeへコピー（.pnpm/.vite/.vite-tempを除外）。依存更新・package/lock変更なし。Bot起動、稼働サービスへのHTTPアクセス、Docker操作、既存SQLite参照・操作、外部Sui/DeepBook要求はなし。既存オフライン回帰に含まれる一時DBの会計・ロック試験は実行した。

抽出スクリプトは上記SHA256以外の入力を拒否し、allowlistの構造化値だけを新規出力先へ保存する。実際の停止時刻の新しいエクスポートには別の相関確認が必要。詳細は[調査報告](../../SUI_RPC_STOP_INVESTIGATION_20261027.md)。
