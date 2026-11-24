# POTARIO PC Bot の裏起動タスク（タスクスケジューラ）を管理する。
# Install で「ログオン時に窓なしで Bot を起動」を登録する。
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
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# ExecutionTimeLimit は無制限（[TimeSpan]::Zero = PT0S。既定の3日で Bot が
# 止まらないように）。文字列 'PT0S' は Windows PowerShell 5.1 が受け付けない
# ため TimeSpan で渡す（実地確認 2026-11-25）。
# 失敗時は1分間隔で最大3回まで自動で立て直す。
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "登録しました: $taskName（ログオン時に窓なしで起動します）"
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
