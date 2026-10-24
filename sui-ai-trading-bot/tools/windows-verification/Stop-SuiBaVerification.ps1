# SuiBa Windows unattended verification - manual stop.
#
# Double-click Stop-SuiBaVerification.bat while a verification runs.
# This script only ever stops the dedicated verification project that
# the running monitor created:
#   1. It asks the monitor (via a STOP_REQUEST file) to finalize
#      gracefully, which also produces the reports.
#   2. If the monitor is already gone, it stops the dedicated project
#      itself - after verifying the container's compose project label
#      and container ID match the recorded run state.
# It never touches any other container, project, volume or database.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
param([string]$RunRoot = '', [int]$WaitSeconds = 60)

$script:ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
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

if ($RunRoot -eq '') { $RunRoot = Join-Path $script:ToolDir 'runs' }
$pointerPath = Join-Path (Join-Path $RunRoot 'active') 'active-run.json'
if (-not (Test-Path $pointerPath)) { Write-Host 'No active verification run was found.'; exit 0 }

# Read the pointer/state JSON defensively: a file that is corrupt (or
# momentarily unreadable) must produce one clear message, not a chain of
# binding/conversion errors.
$corruptMessage = 'The verification pointer/state file is corrupted and could not be read. Nothing was stopped; check the run folder under the runs directory.'
$pointer = $null
try { $pointer = (Get-Content $pointerPath -Raw -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop } catch { $pointer = $null }
if ($null -eq $pointer -or [string]::IsNullOrWhiteSpace([string]$pointer.StateFile)) {
    Write-Host $corruptMessage
    exit 1
}
$statePath = $pointer.StateFile
if (-not (Test-Path $statePath)) { Write-Host 'Run state file is missing.'; exit 1 }
$state = $null
try { $state = (Get-Content $statePath -Raw -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop } catch { $state = $null }
if ($null -eq $state) {
    Write-Host $corruptMessage
    exit 1
}

# The run directory is recorded on the pointer, not on state.json: the
# state object has no RunDir field, so reading $state.RunDir always
# yielded $null and broke the graceful-stop request below with a
# Join-Path binding error. Fall back to the state file's own folder if
# the pointer does not carry a run directory.
$runDir = [string]$pointer.RunDir
if ([string]::IsNullOrWhiteSpace($runDir)) { $runDir = Split-Path -Parent $statePath }

if ($state.Status -eq 'Preparing') {
    Write-Host 'The recorded run is still being prepared (status: Preparing); it cannot be stopped from this menu yet. Wait until it is running, then stop it here.'
    exit 0
}
if ($state.Status -ne 'Running') { Write-Host "The recorded run is not running (status: $($state.Status))."; exit 0 }

Write-Host "Requesting graceful stop for run $($state.RunId)..."
[IO.File]::WriteAllText((Join-Path $runDir 'STOP_REQUEST'), (Get-Date).ToUniversalTime().ToString('o'))

# Give the monitor up to $WaitSeconds seconds to finalize (it stops the
# container and writes the reports). A state read that fails mid-wait -
# the monitor may be rewriting state.json at that moment - counts as
# "not finished yet", never as "finished".
$polls = [Math]::Max(1, [int][Math]::Ceiling($WaitSeconds / 2))
for ($i = 0; $i -lt $polls; $i++) {
    Start-Sleep -Seconds 2
    $now = $null
    try { $now = (Get-Content $statePath -Raw -ErrorAction Stop) | ConvertFrom-Json -ErrorAction Stop } catch { $now = $null }
    if ($null -ne $now -and $now.Status -ne 'Running') {
        Write-Host "Monitor finalized the run (status: $($now.Status)). Reports: $(Join-Path $runDir 'reports')"
        exit 0
    }
}

# Monitor seems gone: stop the dedicated project ourselves, with the
# same identity verification the monitor uses.
Write-Host 'Monitor did not finalize in time. Stopping the dedicated project directly (identity-checked)...'
$inspResult = Invoke-Docker @('inspect', $state.ContainerId)
if ($inspResult.ExitCode -ne 0) { Write-Host 'Container is already gone.'; Set-ObjProp $state 'Status' 'StoppedByUser'; Set-ObjProp $state 'Reason' 'USER_STOPPED_CONTAINER_GONE' }
else {
    $insp = (($inspResult.Output -join "`n") | ConvertFrom-Json)[0]
    $proj = $insp.Config.Labels.'com.docker.compose.project'
    if ($proj -ne $state.Project -or $insp.Id -ne $state.ContainerId) {
        Write-Host 'REFUSED: the recorded container does not belong to the dedicated verification project. Nothing was stopped.'
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
    Set-ObjProp $state 'Status' 'StoppedByUser'
    Set-ObjProp $state 'Reason' 'USER_STOPPED_MONITOR_ABSENT'
}
[IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-Host 'Dedicated verification container stopped. No other container was touched.'
exit 0
