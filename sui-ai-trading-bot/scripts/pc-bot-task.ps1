# POTARIO PC Bot の裏起動タスク（タスクスケジューラ）を管理する。
# Install で「ログオンしていなくても Bot を起動」を登録する。
# タスクは画面のないセッション（セッション0）で動くため、コンソール
# 窓は原理的に出ない。対話セッションで .cmd を直接起動すると窓が残り、
# wscript（VBScript）経由の窓隠しは Microsoft の廃止予定（2027年ごろ
# 既定オフ、その後削除）に当たるため、どちらも使わない。
# Bot 本体の起動は pc-bot-launcher.cmd が担い、出力は
# data\logs\bot-console.log に追記される。
param(
[ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Status')]
[string]$Action = 'Install'
)

$ErrorActionPreference = 'Stop'
$taskName = 'PotarioBot'
$launcher = Join-Path $PSScriptRoot 'pc-bot-launcher.cmd'

function Get-BotTask {
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

switch ($Action) {
'Install' {
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) {
throw "ランチャーが見つかりません: $launcher"
}
$taskAction = New-ScheduledTaskAction -Execute $launcher
# 起動のきっかけは「PC 起動時」と「ログオン時」の両方。ログオン前から
# 動けるのがセッション0方式の利点で、二重に発火しても既定の
# MultipleInstances（IgnoreNew）で二重起動にはならない。
$trigger = @(
New-ScheduledTaskTrigger -AtStartup
New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
)
# ExecutionTimeLimit は無制限（[TimeSpan]::Zero = PT0S。既定の3日で Bot が
# 止まらないように）。文字列 'PT0S' は Windows PowerShell 5.1 が受け付けない
# ため TimeSpan で渡す（実地確認 2026-11-25）。
# 失敗時は1分間隔で最大3回まで自動で立て直す。
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# 「ユーザーがログオンしているかどうかにかかわらず実行する」方式。
# 登録にはこの PC のログインパスワードが要る（Windows がタスク側に
# 保存する。このスクリプトは表示も送信もしない）。パスワードを
# 変更したら、そのままでは起動しなくなるので Install をやり直す。
# Register-ScheduledTask は -User/-Password 指定時（パスワードログオンの
# パラメータセット）に -Principal を併用できない（併用すると
# "Parameter set cannot be resolved" で失敗する。実地確認 2026-11-25）。
# -User/-Password/-RunLevel の指定だけでパスワードログオンの登録になる。
$cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Bot をログオンなしで起動するため、この PC のログインパスワードを入力してください（Windows がタスクに保存します）'
if ($null -eq $cred) {
throw 'パスワードが入力されなかったため、登録を中止しました'
}
# -ErrorAction Stop: 登録失敗（アクセス拒否など）を非終了エラーのまま流すと
# 成功メッセージまで進んでしまう（実地確認 2026-11-25：登録失敗でも
# 「登録しました」と表示された）。失敗時はここで止める。
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force -ErrorAction Stop | Out-Null
Write-Host "登録しました: $taskName（ログオンしていなくても窓なしで起動します）"
}
'Uninstall' {
if (Get-BotTask) {
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "削除しました: $taskName"
} else {
Write-Host "登録されていません: $taskName"
}
}
'Start' {
if (!(Get-BotTask)) { throw "登録されていません: $taskName（先に Install を実行してください）" }
Start-ScheduledTask -TaskName $taskName
Write-Host "開始しました: $taskName"
}
'Stop' {
if (!(Get-BotTask)) { throw "登録されていません: $taskName" }
Stop-ScheduledTask -TaskName $taskName
Write-Host "停止しました: $taskName（プロセスが残る場合は 3100 番ポートの所有者を終了してください）"
}
'Status' {
$task = Get-BotTask
if (!$task) {
Write-Host "登録されていません: $taskName"
} else {
Write-Host "登録あり: $taskName 状態: $($task.State)"
}
}
}
