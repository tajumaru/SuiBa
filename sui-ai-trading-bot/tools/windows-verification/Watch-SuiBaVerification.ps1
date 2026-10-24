# SuiBa Windows unattended verification - detached watchdog.
#
# Started hidden by Invoke-SuiBaVerification.ps1. If the monitor
# PowerShell dies (window closed, process killed, crash), this
# independent process still stops the dedicated verification project
# shortly after the planned deadline. It acts only while the run state
# says "Running", and it verifies the container's compose project
# label and ID before stopping anything. Together with the in-container
# deadline (scripts/winverify-deadline.mjs) and compose restart="no",
# the dedicated container cannot run indefinitely.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [int]$GraceSeconds = 300,
    [int]$PollSeconds = 15
)

$script:DockerExe = if ($env:SUIBA_WINVERIFY_DOCKER) { $env:SUIBA_WINVERIFY_DOCKER } else { 'docker' }

function Invoke-External {
    param([string]$Exe, [string[]]$CommandArgs)
    $ErrorActionPreference = 'Continue'
    $out = @(); $code = 0
    try {
        $out = @(& $Exe @CommandArgs 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } catch { $out = @("$($_.Exception.Message)"); $code = 1 }
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ ExitCode = [int]$code; Output = [string[]]$out }
}
function Invoke-Docker { param([string[]]$DockerArgs) Invoke-External -Exe $script:DockerExe -CommandArgs $DockerArgs }
function Set-ObjProp {
    param($Obj, [string]$Name, $Value)
    if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name = $Value }
    else { $Obj | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}
function Write-WatchLog {
    param([string]$Message)
    $logPath = Join-Path (Join-Path $RunDir 'logs') 'watchdog.log'
    Add-Content -Path $logPath -Value "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $Message -Encoding UTF8 -ErrorAction SilentlyContinue
}

$statePath = Join-Path $RunDir 'state.json'
if (-not (Test-Path $statePath)) { exit 0 }
try { $state = (Get-Content $statePath -Raw) | ConvertFrom-Json } catch { exit 0 }
if ($state.Status -ne 'Running' -or -not $state.DeadlineUtc) { exit 0 }

$fireAt = [DateTimeOffset]::Parse($state.DeadlineUtc).AddSeconds($GraceSeconds)
Write-WatchLog "Watchdog armed for run $($state.RunId); fires at $($fireAt.ToString('o')) if still running."
while ([DateTimeOffset]::UtcNow -lt $fireAt) {
    Start-Sleep -Seconds $PollSeconds
    if (-not (Test-Path $statePath)) { exit 0 }
    try { $now = (Get-Content $statePath -Raw) | ConvertFrom-Json } catch { continue }
    if ($now.Status -ne 'Running') { Write-WatchLog 'Run finished before the watchdog deadline. Watchdog exiting.'; exit 0 }
}

# Deadline + grace passed and the run still claims to be Running:
# the monitor is presumed dead. Stop only the dedicated project.
try { $state = (Get-Content $statePath -Raw) | ConvertFrom-Json } catch { exit 0 }
if ($state.Status -ne 'Running') { exit 0 }
Write-WatchLog 'Deadline passed with status Running. Stopping the dedicated project.'
$inspResult = Invoke-Docker @('inspect', $state.ContainerId)
if ($inspResult.ExitCode -eq 0) {
    $insp = (($inspResult.Output -join "`n") | ConvertFrom-Json)[0]
    $proj = $insp.Config.Labels.'com.docker.compose.project'
    if ($proj -ne $state.Project -or $insp.Id -ne $state.ContainerId) {
        Write-WatchLog 'REFUSED: container identity does not match the dedicated project.'
        exit 2
    }
    if ($insp.State.Running) {
        $env:SUIBA_PREFLIGHT_PROJECT = $state.Project
        $env:SUIBA_PREFLIGHT_IMAGE = $state.ImageId
        $env:SUIBA_PREFLIGHT_SHA = $state.Sha
        $env:SUIBA_PREFLIGHT_SECRET_FILE = $state.SecretFile
        $composeArgs = @('compose', '-p', $state.Project, '-f', (Join-Path (Join-Path $state.RepoRoot 'docker') 'compose.preflight-30m.yaml'))
        if ($state.OverrideFile -and (Test-Path $state.OverrideFile)) { $composeArgs += @('-f', $state.OverrideFile) }
        $composeArgs += @('stop', '-t', '30')
        $r = Invoke-Docker $composeArgs
        if ($r.ExitCode -ne 0) { [void](Invoke-Docker @('stop', '-t', '30', $state.ContainerId)) }
    }
}
Set-ObjProp $state 'Status' 'WatchdogStopped'
Set-ObjProp $state 'Reason' 'WATCHDOG_DEADLINE'
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-WatchLog 'Dedicated project stopped by watchdog.'
exit 0
