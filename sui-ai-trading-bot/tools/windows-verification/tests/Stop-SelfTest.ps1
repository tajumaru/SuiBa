# Self-test for Stop-SuiBaVerification.ps1 (menu item 6 / Stop bat).
#
# Runs the real Stop script as a child process against fake run roots -
# no Docker engine, no network, no AI. A fake monitor process stands in
# for Invoke-SuiBaVerification.ps1 where a graceful stop is expected.
# Safe to run anywhere:
#   pwsh -File tests/Stop-SelfTest.ps1
# Exit code = number of failed assertions (0 = all passed).
#
# Regression context: state.json has no RunDir field (RunDir lives on the
# active-run pointer). The old Stop script read $state.RunDir anyway, so
# the graceful-stop STOP_REQUEST write always failed with a Join-Path
# null binding error and menu item 6 could never stop a run gracefully.
$script:ToolDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:TestsDir = Join-Path $script:ToolDir 'tests'

$script:Failures = 0
function Assert {
    param([string]$Name, [bool]$Condition)
    if ($Condition) { Write-Host "PASS: $Name" } else { Write-Host "FAIL: $Name"; $script:Failures++ }
}
$pwshExe = (Get-Process -Id $PID).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('suiba-stop-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

function New-FakeState {
    param([string]$Status)
    # Same field set Invoke-SuiBaVerification.ps1 writes - note there is
    # deliberately no RunDir here; that is the production shape.
    return [ordered]@{
        RunId = 'winverify-fake001'; Project = 'suiba-winverify-fake001'
        ImageTag = 'suiba-winverify:fake'; ImageId = 'sha256:1111'; Sha = 'deadbeef'
        ContainerId = 'stubcontainerid0001'; SecretFile = 'x'; RepoRoot = $work
        OverrideFile = $null; DurationMinutes = 30; StartedAtUtc = $null; DeadlineUtc = $null
        PerfDetailEnabled = $true; Status = $Status; Reason = $null
    }
}

function New-FakeRunRoot {
    param([string]$Tag, [string]$Status, [switch]$OmitPointerRunDir,
        [string]$PointerRaw = '', [string]$StateRaw = '', [switch]$OmitPointerStateFile)
    $root = Join-Path $work "runs-$Tag"
    $runDir = Join-Path $root 'winverify-fake001'
    New-Item -ItemType Directory -Path (Join-Path $root 'active') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $runDir 'reports') -Force | Out-Null
    $statePath = Join-Path $runDir 'state.json'
    if ($StateRaw -ne '') { [IO.File]::WriteAllText($statePath, $StateRaw, [Text.UTF8Encoding]::new($false)) }
    else { [IO.File]::WriteAllText($statePath, ((New-FakeState $Status) | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false)) }
    if ($PointerRaw -ne '') { [IO.File]::WriteAllText((Join-Path (Join-Path $root 'active') 'active-run.json'), $PointerRaw, [Text.UTF8Encoding]::new($false)) }
    else {
        $pointer = [ordered]@{ RunId = 'winverify-fake001'; StateFile = $statePath; Status = $Status }
        if (-not $OmitPointerRunDir) { $pointer.RunDir = $runDir }
        if ($OmitPointerStateFile) { $pointer.Remove('StateFile') }
        [IO.File]::WriteAllText((Join-Path (Join-Path $root 'active') 'active-run.json'), ($pointer | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    }
    return [pscustomobject]@{ Root = $root; RunDir = $runDir; StatePath = $statePath }
}

function Invoke-StopProcess {
    param([string]$RunRoot, [string[]]$ExtraArgs = @(), [int]$TimeoutSec = 90)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $pwshExe
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $script:ToolDir 'Stop-SuiBaVerification.ps1') + '"'), '-RunRoot', ('"' + $RunRoot + '"')) + $ExtraArgs
    $psi.Arguments = $argList -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = New-Object Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        $proc.Kill()
        throw "Stop script exceeded ${TimeoutSec}s for RunRoot $RunRoot"
    }
    $result = [pscustomobject]@{ ExitCode = $proc.ExitCode; StdOut = $outTask.Result; StdErr = $errTask.Result }
    $proc.Dispose()
    return $result
}

function Test-NoErrorText {
    param($Result)
    return ($Result.StdErr -notmatch 'Join-Path|Cannot bind argument|ConvertFrom-Json|ParameterBinding') -and ($Result.StdOut -notmatch 'Join-Path|Cannot bind argument')
}

# Fake monitor: waits for STOP_REQUEST, then finalizes the state exactly
# like the real monitor would (status leaves 'Running').
$fakeMonitorPath = Join-Path $work 'fake-monitor.ps1'
[IO.File]::WriteAllText($fakeMonitorPath, @'
param([string]$RunDir, [string]$StatePath)
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    if (Test-Path (Join-Path $RunDir 'STOP_REQUEST')) { break }
    Start-Sleep -Milliseconds 200
}
Start-Sleep -Milliseconds 500
$state = (Get-Content $StatePath -Raw) | ConvertFrom-Json
$state.Status = 'StoppedByUser'
[IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
'@, [Text.UTF8Encoding]::new($false))

function Start-FakeMonitor {
    param([string]$RunDir, [string]$StatePath)
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $pwshExe
    $psi.Arguments = (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $fakeMonitorPath + '"'), '-RunDir', ('"' + $RunDir + '"'), '-StatePath', ('"' + $StatePath + '"')) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    return $proc
}

try {
    # ------------------------------------------------ no pointer at all
    $noRoot = Join-Path $work 'runs-none'
    New-Item -ItemType Directory -Path $noRoot -Force | Out-Null
    $r1 = Invoke-StopProcess -RunRoot $noRoot
    Assert 'no pointer: exit 0' ($r1.ExitCode -eq 0)
    Assert 'no pointer: friendly message' ($r1.StdOut -match 'No active verification run was found')
    Assert 'no pointer: no error text' (Test-NoErrorText $r1)

    # ------------------------------------------------ completed run
    $done = New-FakeRunRoot -Tag 'done' -Status 'Completed'
    $r2 = Invoke-StopProcess -RunRoot $done.Root
    Assert 'completed: exit 0' ($r2.ExitCode -eq 0)
    Assert 'completed: reported as not running' ($r2.StdOut -match 'not running \(status: Completed\)')
    Assert 'completed: no STOP_REQUEST written' (-not (Test-Path (Join-Path $done.RunDir 'STOP_REQUEST')))
    Assert 'completed: no error text' (Test-NoErrorText $r2)

    # --------------------------------------- running + monitor finalizes
    # The core regression: STOP_REQUEST must land in the run folder taken
    # from the pointer, with no Join-Path error, and the finalized
    # message must show the reports path.
    $grace = New-FakeRunRoot -Tag 'grace' -Status 'Running'
    $mon = Start-FakeMonitor -RunDir $grace.RunDir -StatePath $grace.StatePath
    try {
        $r3 = Invoke-StopProcess -RunRoot $grace.Root
    } finally {
        if (-not $mon.WaitForExit(10000)) { $mon.Kill() }
        $mon.Dispose()
    }
    Assert 'graceful: exit 0' ($r3.ExitCode -eq 0)
    Assert 'graceful: STOP_REQUEST written into the run folder' (Test-Path (Join-Path $grace.RunDir 'STOP_REQUEST'))
    Assert 'graceful: monitor finalized message' ($r3.StdOut -match 'Monitor finalized the run \(status: StoppedByUser\)')
    Assert 'graceful: reports path shown' ($r3.StdOut.Contains((Join-Path $grace.RunDir 'reports')))
    Assert 'graceful: no error text' (Test-NoErrorText $r3)

    # --------------------------- running + monitor, pointer lacks RunDir
    # Fallback: the state file's own folder is the run folder.
    $fb = New-FakeRunRoot -Tag 'fallback' -Status 'Running' -OmitPointerRunDir
    $mon2 = Start-FakeMonitor -RunDir $fb.RunDir -StatePath $fb.StatePath
    try {
        $r4 = Invoke-StopProcess -RunRoot $fb.Root
    } finally {
        if (-not $mon2.WaitForExit(10000)) { $mon2.Kill() }
        $mon2.Dispose()
    }
    Assert 'fallback: exit 0' ($r4.ExitCode -eq 0)
    Assert 'fallback: STOP_REQUEST written next to state.json' (Test-Path (Join-Path $fb.RunDir 'STOP_REQUEST'))
    Assert 'fallback: monitor finalized message' ($r4.StdOut -match 'Monitor finalized the run')
    Assert 'fallback: no error text' (Test-NoErrorText $r4)

    # ------------------------------ running, monitor gone, docker absent
    $gone = New-FakeRunRoot -Tag 'gone' -Status 'Running'
    $env:SUIBA_WINVERIFY_DOCKER = Join-Path $work 'no-such-docker-executable'
    try {
        $r5 = Invoke-StopProcess -RunRoot $gone.Root -ExtraArgs @('-WaitSeconds', '4')
    } finally {
        Remove-Item Env:SUIBA_WINVERIFY_DOCKER -ErrorAction SilentlyContinue
    }
    Assert 'monitor gone: exit 0' ($r5.ExitCode -eq 0)
    Assert 'monitor gone: STOP_REQUEST was written before waiting' (Test-Path (Join-Path $gone.RunDir 'STOP_REQUEST'))
    Assert 'monitor gone: direct stop path taken' ($r5.StdOut -match 'Monitor did not finalize in time')
    Assert 'monitor gone: unreachable docker reads as container gone' ($r5.StdOut -match 'Container is already gone')
    $stateGone = (Get-Content $gone.StatePath -Raw) | ConvertFrom-Json
    Assert 'monitor gone: state marked StoppedByUser / USER_STOPPED_CONTAINER_GONE' ($stateGone.Status -eq 'StoppedByUser' -and $stateGone.Reason -eq 'USER_STOPPED_CONTAINER_GONE')
    Assert 'monitor gone: no error text' (Test-NoErrorText $r5)

    # ------------------------------------------------ corrupt JSON input
    $badPointer = New-FakeRunRoot -Tag 'badpointer' -Status 'Running' -PointerRaw '{ this is not json'
    $r6 = Invoke-StopProcess -RunRoot $badPointer.Root
    Assert 'corrupt pointer: exit 1' ($r6.ExitCode -eq 1)
    Assert 'corrupt pointer: single corruption message' ($r6.StdOut -match 'pointer/state file is corrupted')
    Assert 'corrupt pointer: no chained error text' (Test-NoErrorText $r6)

    $noStateFile = New-FakeRunRoot -Tag 'nostatefile' -Status 'Running' -OmitPointerStateFile
    $r7 = Invoke-StopProcess -RunRoot $noStateFile.Root
    Assert 'pointer without StateFile: exit 1' ($r7.ExitCode -eq 1)
    Assert 'pointer without StateFile: corruption message' ($r7.StdOut -match 'pointer/state file is corrupted')

    $badState = New-FakeRunRoot -Tag 'badstate' -Status 'Running' -StateRaw 'not json at all'
    $r8 = Invoke-StopProcess -RunRoot $badState.Root
    Assert 'corrupt state: exit 1' ($r8.ExitCode -eq 1)
    Assert 'corrupt state: single corruption message' ($r8.StdOut -match 'pointer/state file is corrupted')
    Assert 'corrupt state: no chained error text' (Test-NoErrorText $r8)

    # ------------------------------------------------ preparing run
    $prep = New-FakeRunRoot -Tag 'prep' -Status 'Preparing'
    $r9 = Invoke-StopProcess -RunRoot $prep.Root
    Assert 'preparing: exit 0' ($r9.ExitCode -eq 0)
    Assert 'preparing: accurate guidance, not "not running"' ($r9.StdOut -match 'still being prepared' -and $r9.StdOut -match 'cannot be stopped from this menu' -and $r9.StdOut -notmatch 'is not running')
    Assert 'preparing: no STOP_REQUEST written' (-not (Test-Path (Join-Path $prep.RunDir 'STOP_REQUEST')))
    $statePrep = (Get-Content $prep.StatePath -Raw) | ConvertFrom-Json
    Assert 'preparing: state left untouched' ($statePrep.Status -eq 'Preparing')
    Assert 'preparing: no error text' (Test-NoErrorText $r9)
} catch {
    $script:Failures++
    Write-Host "FAIL: stop self-test aborted: $($_.Exception.Message)"
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:SUIBA_WINVERIFY_DOCKER -ErrorAction SilentlyContinue
}

Write-Host "Stop self-test failures: $script:Failures"
exit $script:Failures
