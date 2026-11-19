# PC の Bot の見張り（healthchecks.io）セットアップシート — 2026-11-18

目的：Windows PC で動く SuiBa（testnet）の Bot が止まったら、たじゅまる に
メールで知らせる。仕組みは「合図が来なくなったら異常」という逆転の発想
（dead-man's switch）。

- PC 側の小さなスクリプトが5分ごとに「生きてる」と合図を送る
- Bot が落ちた／安全停止した → その場で「異常」の合図を送る
- PC が寝た／電源が落ちた → 合図そのものが途絶える → 猶予10分を過ぎたら
  healthchecks.io がメールする
- シロの定期チェックではない（トークンを使わない、いつものルール通り）

## たじゅまる の作業（これだけ）

1. https://healthchecks.io で無料アカウントを作る
2. Checks → Add Check：名前 `SuiBa PC Bot`、Period `5 minutes`、
   Grace `10 minutes` で作成
3. 作成画面に出る Ping URL（https://hc-ping.com/… の形）を控える
4. 下の「PC の Codex への貼り付け文」をそのまま貼り、Ping URL を
   指示された場所に入れる
5. テストで異常メールが届くことを確認する（Codex が -TestFail で送る）

## PC の Codex への貼り付け文

```
SuiBa の見張り合図をセットアップしてください。報告は専門用語なしの
平易な日本語で、結論を1行で先に書いてください。想定外のことがあったら
止めて報告してください。

Ping URL はこれです：（ping URLは healthchecks.io の管理画面と PC 上のスクリプト内のみに保持。この文書には載せない）

手順：
1. フォルダ C:\Users\yuake\suiba-heartbeat を作り、その中に
   suiba-heartbeat.ps1 を以下の内容で作ってください。
2. タスクスケジューラに「SuiBa Heartbeat」というタスクを登録して
   ください：5分ごとに、ログオン中のみ実行、
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File
   "C:\Users\yuake\suiba-heartbeat\suiba-heartbeat.ps1"
   （StartWhenAvailable を有効に）。
3. テストを3つやって結果を報告してください：
   a. 通常実行 → healthchecks の画面でチェックが緑（Up）になること
   b. -TestFail で実行 → 私に異常のメールが届くこと（届いたら私が言う）
   c. Bot を止めずに、タスクが5分間隔で動き続けること（タスクの履歴で確認）

スクリプトの内容：

param([switch]$TestFail)

$PingUrl = "（ping URLは healthchecks.io の管理画面と PC 上のスクリプト内のみに保持。この文書には載せない）"
$AppDir  = "D:\SuiBa5\sui-ai-trading-bot"

function Send-Ping([string]$Suffix) {
  try { Invoke-WebRequest -Uri ($PingUrl + $Suffix) -TimeoutSec 10 -UseBasicParsing | Out-Null } catch {}
}

if ($TestFail) { Send-Ping "/fail"; Write-Host "テスト用の異常合図を送りました"; return }

$Port = 3100; $Token = ""
foreach ($line in Get-Content (Join-Path $AppDir ".env")) {
  if ($line -match '^\s*PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
  if ($line -match '^\s*ADMIN_TOKEN\s*=\s*(.+)$') { $Token = $Matches[1].Trim() }
}
$Base = "http://127.0.0.1:$Port"

try {
  $h = Invoke-WebRequest -Uri "$Base/healthz" -TimeoutSec 5 -UseBasicParsing
  if ($h.StatusCode -ne 200) { throw "healthz" }
} catch { Send-Ping "/fail"; return }

$state = $null
try {
  $headers = @{}
  if ($Token) { $headers["Authorization"] = "Bearer $Token" }
  $s = Invoke-RestMethod -Uri "$Base/api/operations" -TimeoutSec 5 -Headers $headers
  if ($s.safety -and $s.safety.controlState) { $state = $s.safety.controlState }
} catch {}

if ($state -eq "FAULTED" -or $state -eq "STOPPED") { Send-Ping "/fail"; return }
if ($state) { Send-Ping "" }
# 状態が取れなかったときは合図を送らない（猶予10分後にアラートになる）
```

## 運用メモ

- Bot をわざと止めている間（リハーサルや停止窓）は異常メールが来る。
  うるさい時は healthchecks のチェック画面で Pause できる。
- チェックアウトが D:\SuiBa6 などに移ったら、スクリプト内の $AppDir を
  新しい場所に直す（.env を読むためだけに使っている）。
- PC が夜にスリープすると合図が途絶えてメールが来る。Phase 1 の間
  Bot を回し続けたいなら、電源接続時はスリープしない設定にする：
  `powercfg /change standby-timeout-ac 0`
- 判定している状態：/api/operations の safety.controlState を見る。
  FAULTED（安全停止）と STOPPED を異常とし、RUNNING／PAUSED／DEGRADED
  は正常の合図を送る。状態が取れないときは合図を送らない（沈黙＝
  猶予10分後にアラート）。初版は /api/status を見ていて 404 だったため
  PC 側 Codex が設定前に止めて指摘し、/api/operations に修正した。
