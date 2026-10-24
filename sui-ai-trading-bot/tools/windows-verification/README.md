# Windows無人検証ツール（ダブルクリック実行）

AIエージェントを起動し続けなくても、Windows 11 上で .bat のダブルクリックだけで
Docker実通信の長時間検証（30分／2時間／6時間／24時間）を実行し、終了後に
Markdown・JSON・CSVレポートを自動生成するツールです。実行中の処理はすべて
ローカルの PowerShell と Docker だけで完結し、外部AIへの問い合わせは一切行いません。

基盤は既存の隔離済み passive preflight（`docker/compose.preflight-30m.yaml`）です。
PAPER専用・`running=false` の停止状態観測であり、注文運転は開始しません。
LIVE取引は行いません。

## 前提

- Windows 11 + Docker Desktop（起動済みであること）
- このリポジトリを clone 済みで、作業ツリーがクリーンなこと
  （検証対象の commit を固定するため。dirty の場合は開始しません）
- ポート `127.0.0.1:3105` が空いていること（使用中なら開始しません）
- ディスク: Dockerデータ保存先ドライブの使用率が80%未満、かつシステム／
  出力（runs/）／一時ファイルの各ドライブの空きが10GiB以上
  （30分検証レポート §14 の合意「D80% / C空き10GiB」をドライブの役割別に
  適用しています。詳細は下記「ディスク判定」を参照）

## 使い方

1. `Start-SuiBaVerification.bat` をダブルクリックします。
2. 検証時間を選んで Enter を押します（1=30分 / 2=2時間 / 3=6時間 / 4=24時間）。
3. 専用イメージのビルド（初回は数分かかります）とコンテナ内Node検証
   （`>=24.22.1 <25`）が自動で行われ、検証コンテナが起動します。
4. 監視画面に残り時間、市場サイクルの成功率、Sui gRPC / DeepBook の成功率が
   定期表示されます。ウィンドウは開いたままにしてください。
5. 指定時間が終わると自動で監査・レポート生成・専用コンテナ停止まで行われます。

途中で止めたいときは `Stop-SuiBaVerification.bat` をダブルクリックしてください。
監視プロセスへ終了要求を出し、レポートを生成してから停止します（最大約60秒＋
ファイナライズ時間）。監視プロセスが既に消えている場合は、身元確認
（compose projectラベルとコンテナIDの一致）の上で専用コンテナだけを直接停止します。

## レポートの場所

`tools/windows-verification/runs/<Run ID>/` 配下に生成されます（Git管理外）。

| ファイル | 内容 |
| --- | --- |
| `reports/report.md` | 人間向けサマリ（成功率、鮮度、SQLite、イベントループ、メモリ、安全確認、インシデント） |
| `reports/report.json` | 機械可読の同内容 |
| `reports/events.csv` | API失敗・タイムアウト・インシデントの一覧 |
| `reports/samples.csv` | observerサンプル（running、注文数、整合性、市場状態）の時系列 |
| `reports/preflight-summary.json` | 既存集計ツール（summarize-preflight）の出力。2時間未満では INCONCLUSIVE になり得ます |
| `evidence/` | 生の証拠（evidence JSONL、監査JSON、redact済み inspect、コンテナログ） |
| `state.json` | 実行状態と身元情報（project名、コンテナID、image ID、対象SHA） |

成功率は「観測窓内の実試行」だけを分母にします（DeepBook の cache hit は含みません）。
30分検証レポートと同じ定義です。

## 安全設計

- **独立環境**: run毎に一意な compose project名・イメージタグ・volume・管理用secret
  ファイルを生成します。既存コンテナ・DB・volume には一切触れません。
  イメージタグが既に存在する場合は上書きせず中止します。
- **受動的観測のみ**: 既存 preflight の observer 経路を再利用します。
  control start は呼びません。初回サンプルで `running=false`・注文0・
  validation session なしを確認できなければ即座に安全停止します。
- **安全停止条件**: 既存30分検証の停止条件を維持しています（Node/SHA/image不一致、
  意図しない running=true・注文・約定、DB fault / SQLITE_BUSY、証拠保存失敗、
  連続3周期失敗、5分間正常周期なし、監視不能、ディスク閾値 等）。
  停止するのは検証専用 project のコンテナだけで、`down`・`prune`・volume削除は
  コード上どこにも存在しません。停止前には必ず projectラベルとコンテナIDの
  一致を確認します。
- **無期限実行の防止（3層）**:
  1. compose の `restart: "no"`（既存定義）
  2. コンテナ内デッドライン（`scripts/winverify-deadline.mjs`）: 予定時間+10分で
     プロセスへ SIGTERM。環境変数が無い通常起動では完全に無効です
  3. ウォッチドッグ（別プロセス）: 予定終了+5分を過ぎても実行中なら、
     身元確認の上で専用 project だけを停止します
- **ディスク判定**（開始前と検証中の5分毎チェックで同一条件を適用）:
  30分検証 §14 の合意は「Docker保存先ドライブの使用率80%以上、または
  Cドライブ空き10GiB未満」で停止、という役割別の条件です。
  - Dockerデータ保存先ドライブ: 使用率80%以上で停止。保存先は
    `docker info` の DockerRootDir（Windowsパスの場合のみ）、WSL2 の
    レジストリ（docker-desktop ディストリビューションの BasePath）、
    Docker Desktop 設定の dataFolder、既定の vhdx 場所から特定します。
    `docker info` が `/var/lib/docker` のような Linux VM 内パスを返す
    場合はホストのドライブを指さないため証拠に使いません。
    レジストリの BasePath は `\\?\D:\...` のように Win32 デバイス接頭辞を
    含むことがあるため、全ソース共通の正規化で接頭辞を除去してから
    ドライブを特定します。設定ファイルはネストした dataFolder 等も
    再帰的に探索します。UNC・相対パス・POSIXパスはドライブを特定
    できないため証拠に使いません。
    **保存先を特定できない場合は推測で開始せず、安全に停止します**
  - システムドライブ／出力先ドライブ（`runs/` 配下: ログ・レポート・
    証拠・secret・compose override）／一時ファイル（TEMP）のドライブ:
    空き10GiB未満で停止。使用率は判定しません（例: C が使用率83%でも
    空きが10GiB以上あれば、それだけでは停止しません）
  - 事実の収集自体に失敗した場合も停止します（fail-closed）
- **秘匿情報**: 管理用secretは run毎に生成し、`runs/` 配下にのみ保存します
  （Git管理外）。レポート生成時に secret 値を禁止文字列として除去し、
  inspect は必要項目だけに絞って保存します。APIキー等はレポートに出ません。
- 異常停止した場合も証拠とレポートは保持されます（自動削除しません）。

## 終了コード

`Invoke-SuiBaVerification.ps1` の終了コード: 0=完了／ユーザー停止、
2=安全停止（異常検知）、1=致命的エラー。

## テスト（開発者向け）

Docker・ネットワーク無しでロジックを検証する自己テストがあります
（docker/git のスタブ使用。本番検証は開始しません）。

```powershell
pwsh -File tools/windows-verification/tests/Invoke-SelfTest.ps1
```

内容: Node版数判定・異常条件・ディスク判定（境界値と実測値の回帰）の単体テスト、正常系E2E（レポート生成・成功率集計・
secret非混入・禁止コマンド未使用の確認）、安全違反シナリオでの安全停止、
ウォッチドッグの単体テスト。

## 注意（未検証事項）

このツールは Linux 環境で PowerShell 7.4 + スタブにより検証しました。
Windows 実機（Windows PowerShell 5.1 / PowerShell 7、実 Docker Desktop）での
実通信長時間検証は未実施です。初回は30分で様子を見てから長い時間を選んでください。
