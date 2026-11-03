# Windowsワンクリック通信観測：実装・検証報告

ベース：PR #6マージ後のmain、`045230d68748a607983fa0d43790f7e423d5fe54`。

## 既存機能と今回の追加

| 項目 | 既存 | 今回 |
| --- | --- | --- |
| 起動 | BATから既存PowerShell monitorを起動 | 同じ入口に7項目メニュー、Enterで30分、前回結果・安全停止を追加 |
| Docker分離 | 新規project/image/volume/secret、3105、restart=no | 再利用。起動準備から名前付きmutexで排他、前回Preparing/Runningも拒否 |
| 実行前確認 | Git clean/HEAD、Docker/Compose、ディスク、ポート、イメージ内Node | 再利用。SHA取得の作業ディレクトリを固定。起動した専用コンテナでもNode guardを実行 |
| 長時間 | 30分/2時間/6時間/24時間 | 360分以上は条件表示とSTART確認。非対話ではConfirmLongRun必須 |
| 停止・期限 | 既存Stop、Watch、コンテナdeadline、既存安全停止判定 | 変更せず再利用。メニュー6から既存停止スクリプトを呼ぶ |
| 詳細計測 | 検証時SUIBA_PERF_DETAIL=1、通常Botは既定OFF、同期I/O・cycle・通信等 | 変更せず再利用。sink損失を相関結果にも残し品質判定に使用 |
| レポート | report.md/json、性能分析/相関、SQLite/スパイクJSONL | 再利用しnext-actions.md、overallVerdict、比較条件、結果フォルダ案内を追加 |

新規ライブラリ `tools/windows-verification/lib/Verification.OneClick.ps1` はUIと終了後案内のみを扱い、
既存monitor・集計・相関・停止機構を呼ぶ。DB・戦略・注文ゲート・安全停止閾値・通信timeout/retryは変更していない。

## 判定と証拠

- COMPLETEDは予定終了。PASS / FAIL / INCONCLUSIVEと別表示する。
- 既知の異常停止、SQLite失敗、詳細フラッシュ失敗、インシデントはFAIL。通信母数不足で隠さない。
- 計測OFF、欠落、損失、上限、不正行、品質チェック未達・未確認はPASSにしない。
- 既存summarize-preflightの閾値・判定は変更せず、未達チェックをnext-actionsに併記する。
- TOP10と同時刻処理は既存の性能分析を再利用。「原因未確定」と相関≠因果を明記する。
- 前回比較は両方COMPLETEDかつSHA・image・Node・予定時間・設定ハッシュ・計測モードが確認できる場合だけ。
- 結果は日時（ミリ秒）とSHA別。同名ディレクトリがあれば中止する。Explorer失敗は保存結果を消さない。
- 通信観測のPASSでも、PAPER取引・LIVE取引は未検証であり開始承認ではない。

## 実行した検証

| 検証 | 結果 |
| --- | --- |
| Windows PowerShell 5.1、Invoke-SelfTest.ps1 | 113 assertions成功、失敗0、exit 0 |
| PowerShell 7、Invoke-SelfTest.ps1 | 113 assertions成功、失敗0、exit 0 |
| Windows PowerShell 5.1、Invoke-OneClickSelfTest.ps1 | 34 assertions成功、失敗0、exit 0 |
| PowerShell 7、Invoke-OneClickSelfTest.ps1 | 34 assertions成功、失敗0、exit 0 |
| pnpm test、Node v24.22.1 | 46ファイル、664件成功、失敗0、exit 0 |
| pnpm run build、Node v24.22.1 | 型チェックを含め成功、exit 0。既存chunk size等の警告あり |

全PowerShell実行はスタブ/fixture。DockerエンジンとSui/DeepBookへ接続していない。
対話起動テストではEnterで予定30分を選び、スタブから即座に停止要求を出し短時間終了させた。
予定時間30分、running=false、注文等なし、USER_STOPPED、レポート生成を確認した。
詳細ON/OFF、異常・途中停止、Docker到達不能、Node不一致、ディスク閾値、二重起動、期限監視、
レポートのsecret除去、Explorer失敗、比較可能/不可能、母数不足下の保存障害を確認した。

初回のメニュー試験はStart-ProcessからのExitCode取得が不確実で1 assertion失敗した。
起動・中断と30分選択は確認できていたが成功扱いせず、明示的なProcessで標準入力/出力と終了コードを
取得するテストに修正し、上記最終結果で再確認した。製品の終了コードを無視する対応はしていない。

## 起動方法・未検証事項

`tools/windows-verification/Start-SuiBaVerification.bat` をダブルクリックし、Enterで30分。
クリーンな検証対象コミットが必要。git pullや変更破棄は自動実行しない。
Codex/Muse Metaは不要。PowerShell監視画面は開いておく。消失時も既存の独立watchdog/deadlineを維持する。

実Docker Desktopの新規ビルド/起動・実通信30分以上・実際のExplorer画面・6時間/24時間実行は未実施。
ディスク検証は閾値fixtureであり、実ドライブを満杯にはしていない。
終了後の自動フォルダ表示失敗は注記されるがレポートを失わない。
古いPreparing/Runningの記録は安全性不明のまま自動削除しないため、残留時は手動で状態確認が必要。
詳細計測には既存の保存件数/容量上限があり、長時間時の損失はINCONCLUSIVEとして明示する。
PAPER/LIVE運転、注文・送金は実施していない。実通信検証はユーザー承認を待つ。
