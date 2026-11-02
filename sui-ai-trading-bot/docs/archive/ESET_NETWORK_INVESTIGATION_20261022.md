# ESETとDeepBook通信の追加調査（2026-10-22）

## 結論

ESET自身の起動不良を確認したが、SuiBaの通信タイムアウトとの因果関係は未確定。ESETの停止・SSL/TLS除外の追加を、根拠がある解決策とは扱わない。

本調査は設定変更なしで実施した。PC・Dockerの再起動、PAPER再開、実注文は行っていない。

## ESETの確認結果

- `ekrn`と`ekrnEpfw`の停止を、CIM、Get-Service、sc.exeで照合した。対象プロセスも未検出。
- Windowsのシステムイベント7001に、署名確認に関する理由で依存サービスを開始できない記録が複数あった。
- Code Integrityイベント3033に、`eamsi.dll`がWindowsの署名レベル要件を満たさず読み込みを拒否された記録があった。
- `ekrn.exe`、`egui.exe`、`eamsi.dll`の通常のAuthenticode署名検証はすべてValidで、タイムスタンプも存在した。
- 保護サービスの署名要件と通常のAuthenticode署名検証は異なる。ファイル破損、証明書期限、ELAM登録不整合などのいずれが原因かは未確定。
- 読み取れた範囲では稼働中のESET通信ドライバー・アダプターバインディングを検出しなかった。ただし管理者権限を必要とするWFP詳細取得は未実施で、残存フィルターを完全には除外できない。
- 調査時点でWindows DefenderのAntivirusEnabled、RealTimeProtectionEnabledはtrueだった。

端末固有情報、Windowsイベントの生ログ、証明書情報の詳細はローカルのGit除外領域に保存した。この文書には含めない。

## 読み取り専用の通信比較

WindowsとDockerで新規HTTPS接続をそれぞれ4回実施した。1試行8秒上限、再試行なし。DeepBookは公開statusエンドポイント、対照はGoogleのgenerate_204を使用した。合計8件すべて成功した。

| 実行環境 | 接続先 | HTTP | 全体の所要時間（ms） |
|---|---|---|---|
| Windows | DeepBook Indexer | 200 | 372 / 381 |
| Docker | DeepBook Indexer | 200 | 1,601 / 803 |
| Windows | Google（対照） | 204 | 611 / 148 |
| Docker | Google（対照） | 204 | 667 / 193 |

2026-10-22 20:24〜20:27（日本時間）の短時間試験であり、断続的な通信障害が解消した証明ではない。今回の試行ではESET発行証明書への置換は見られなかった。

## ネットワークの補足

- 調査時点でWindowsの手動プロキシとPACは未設定だった。Dockerの`http.docker.internal:3128`は内部プロキシであり、これだけで外部プロキシ使用とは判断しない。
- 今回の比較ではDNS解決に失敗しなかった。
- ゲートウェイと公開対照への少数のICMP試験は成功した。これだけではHTTPSの安定性を保証しない。
- TCP再送カウンターの増加はあったが、他アプリの通信も含むためDeepBookへ帰属できない。
- 調査時点の接続数・取得できたイベントに、TCPポート枯渇を示す証拠はなかった。
- 取得できたDocker backendログに対象ホストの遮断を示す行は見つからなかった。ログに全通信が記録されるとは限らない。

## SuiBaの実ログとの照合

DeepBookの1分足で本文待ちのタイムアウト、statusでTLS待ちのタイムアウト、Sui gRPCで10秒のタイムアウトが発生している。statusの一例はDNS完了13ms、TCP完了4,378ms、その後TLSが完了せず約8秒で打ち切りだった。

前回のDNS完了後にTCP接続が確立しなかったケースも含め、複数の通信段階で断続的な遅延を確認している。HTTP 429の応答を確認した事象ではない。

取得成功にも戻っており、最後の確認ではデータ取得一式4,136msだった。PAPER停止、既存検証セッションの保持、integrityFault=nullを確認した。ESET起動不良と通信障害の両方が存在することだけで因果関係は証明できない。

## 次の調査・対応

1. ESETのイベント7001/3033と通常の署名検証がValidである点を、ESETサポートへ伝えて起動不良を確認する。サポートへの情報送信は今回実施していない。
2. PC再起動を伴う修復・再インストールは、24時間検証終了後の保守作業として計画する。
3. 通信障害の発生中に別回線と比較するか、管理者権限で対象IP・TCP443に限定したWFP・パケット調査を行う。いずれも未実施。
4. 署名強制や保護機能の無効化、根拠のないDNS/MTU変更は行わない。既存の取引安全条件も変更しない。

## 公式参照

- [Microsoft：保護されたマルウェア対策サービスと署名要件](https://learn.microsoft.com/en-us/windows/win32/services/protecting-anti-malware-services-)
- [ESET：修復のための再インストール手順](https://support.eset.com/en/kb2788-uninstall-and-reinstall-my-eset-windows-home-product?locale=en_US)
- [Docker Desktop：ネットワーク・プロキシ設定](https://docs.docker.com/desktop/settings-and-maintenance/settings/)

既存のコード側対策については[DeepBook通信タイムアウト調査・対策](DEEPBOOK_TIMEOUT_20261022.md)を参照。
