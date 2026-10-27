# 検証証拠

基点main `a6eb77e443ba358383420c2ba9d9db9634eecbc5`。Node.js v24.22.1、Windows x64、Vitest 3.2.7、SDK @mysten/sui 2.37.0。productionファイル変更0。

- `historical-extract.json`：退避JSONLをオフライン再集計。元SHA256 `fd22a73695a3a4e9a707c87cc84049290513db28d6c574b9b0fb69bc156769a4`、1,508行、Sui失敗5件、失敗周期4件。元実行SHAは8b05f2a、稼働中Bot停止の最新mainログではない。coin未記録。元の行番号と次sampleを保持。
- `offline-vitest.json`：最終の全オフラインVitest結果。2026-10-27 12:24:08.926 JST開始。67ファイル、965成功・0失敗・8skip、success=true。socket拒否setupを維持。skip8件および対象外2ファイルは既存offline configの実loopback等で、新規除外は追加していない。
- Node標準テスト45件成功（同じtest:offlineランナーの前段）。TypeScript型検査成功。
- 新規7ケース：gRPC14／metadata欠損／decimals不正／decode／HTTP403のEngine停止と回復後ラッチ、補助balance DNSのtick外pause、SDK欠損balanceの0補完。

最初の全体実行は964成功・1失敗・8skip。失敗は既存レポート出力試験のOS一時ディレクトリrename EPERM。TEMP/TMPを専用worktreeの`data/offline-tmp`へ限定した再実行は全件成功。製品実装は変更していない。追加テスト作成時には共通breakerのfixture後処理不足でも失敗し、成功probeによる隔離を加えて解消した。

ローカル依存は既存インストールから専用worktreeへコピー（.pnpm/.vite/.vite-tempを除外）。依存更新・package/lock変更なし。Bot起動、稼働サービスへのHTTPアクセス、Docker操作、既存SQLite参照・操作、外部Sui/DeepBook要求はなし。既存オフライン回帰に含まれる一時DBの会計・ロック試験は実行した。

抽出スクリプトは上記SHA256以外の入力を拒否し、allowlistの構造化値だけを新規出力先へ保存する。実際の停止時刻の新しいエクスポートには別の相関確認が必要。詳細は[調査報告](../../SUI_RPC_STOP_INVESTIGATION_20261027.md)。
