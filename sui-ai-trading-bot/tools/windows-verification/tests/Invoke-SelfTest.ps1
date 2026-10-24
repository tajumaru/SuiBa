# Self-test for the Windows unattended verification tool.
#
# Runs the real Invoke-SuiBaVerification.ps1 end-to-end against stub
# docker/git executables (tests/stubs) - no Docker engine, no network,
# no AI. Also unit-tests the pure functions in lib/Verification.Common.ps1
# and the watchdog. Safe to run anywhere:
#   pwsh -File tests/Invoke-SelfTest.ps1
# Exit code = number of failed assertions (0 = all passed).
$script:ToolDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:TestsDir = Join-Path $script:ToolDir 'tests'
. (Join-Path (Join-Path $script:ToolDir 'lib') 'Verification.Common.ps1')

$script:Failures = 0
function Assert {
    param([string]$Name, [bool]$Condition)
    if ($Condition) { Write-Host "PASS: $Name" } else { Write-Host "FAIL: $Name"; $script:Failures++ }
}
$pwshExe = (Get-Process -Id $PID).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('suiba-winverify-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    # ------------------------------------------------------------ unit tests
    Assert 'node v24.22.1 accepted' (Compare-SuiBaNodeVersion 'v24.22.1')
    Assert 'node v24.22.0 rejected' (-not (Compare-SuiBaNodeVersion 'v24.22.0'))
    Assert 'node v24.23.0 accepted' (Compare-SuiBaNodeVersion 'v24.23.0')
    Assert 'node v25 rejected' (-not (Compare-SuiBaNodeVersion 'v25.0.0'))
    Assert 'node garbage rejected' (-not (Compare-SuiBaNodeVersion 'not-a-version'))
    $st = Get-SuiBaStats -Values @(10, 20, 30, 40)
    Assert 'stats percentile' ($st.N -eq 4 -and $st.P50 -eq 20 -and $st.P95 -eq 40 -and $st.Max -eq 40)

    $safeState = [pscustomobject]@{
        RunningTrueSeen = $false; NonzeroOrdersSeen = $false; SessionSeen = $false
        IntegrityFaultSeen = $false; IntegrityBadSeen = $false
        SqliteBusy = 0; SqliteLocked = 0; SqliteFailures = 0
        OOMKilled = $false; RestartCount = 0; ContainerRunning = $true
        BuildVariantCount = 1; ConsecutiveFailedCycles = 0
        HasSuccessfulCycleHistory = $true; LastSuccessCycleAgeSec = 60
        SampleCount = 5; MaxSampleGapSec = 15; ElapsedSec = 600
        UnhealthyStreak = 0; MonitorCopyFailStreak = 0; DiskAbort = $false; DiskAbortReason = ''
    }
    Assert 'abort: safe state passes' ($null -eq (Test-SuiBaAbortCondition -State $safeState))
    $s2 = $safeState.PSObject.Copy(); $s2.RunningTrueSeen = $true
    Assert 'abort: running=true' ((Test-SuiBaAbortCondition -State $s2) -eq 'SAFETY_RUNNING_TRUE')
    $s3 = $safeState.PSObject.Copy(); $s3.ConsecutiveFailedCycles = 3
    Assert 'abort: 3 failed cycles' ((Test-SuiBaAbortCondition -State $s3) -eq 'CYCLES_FAILED_3_CONSECUTIVE')
    $s4 = $safeState.PSObject.Copy(); $s4.SqliteBusy = 1
    Assert 'abort: sqlite busy' ((Test-SuiBaAbortCondition -State $s4) -eq 'DB_SQLITE_FAULT')
    $s5 = $safeState.PSObject.Copy(); $s5.LastSuccessCycleAgeSec = 301
    Assert 'abort: no successful cycle 5min' ((Test-SuiBaAbortCondition -State $s5) -eq 'NO_SUCCESSFUL_CYCLE_5MIN')

    # ------------------------------------------------------------ disk conditions
    # Definitions reconciled with docs/PREFLIGHT_30M_20261024.md
    # section 14 ("D80% / C free 10 GiB"): the >= 80% used rule judges
    # ONLY the Docker data drive; system / output / temp drives are
    # judged by free space < 10 GiB and never by used percentage; an
    # undeterminable Docker data location aborts (fail-closed).
    function New-DiskDrive { param([string]$Name, [string[]]$Roles, [double]$UsedPct, [double]$FreeGiB) [pscustomobject]@{ Name = $Name; Roles = $Roles; UsedPct = $UsedPct; FreeGiB = $FreeGiB } }
    # Regression for the field report: C used 83% but free 37.83 GiB,
    # Docker data on D at 10.6% used - the old code aborted on C's
    # used percentage; the reconciled rules must let this start.
    $diskUser = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System', 'Temp') 83 37.83),
        (New-DiskDrive 'D:\' @('DockerData', 'Output') 10.6 832.64))
    Assert 'disk regression: C 83% used / 37.83 GiB free does not abort' (-not $diskUser.Abort)
    $diskDocker80 = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System') 50 100), (New-DiskDrive 'D:\' @('DockerData') 80.0 100))
    Assert 'disk boundary: docker data drive at exactly 80% aborts' ($diskDocker80.Abort -and $diskDocker80.Reason -match 'docker data drive')
    $diskDocker799 = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System') 50 100), (New-DiskDrive 'D:\' @('DockerData') 79.9 100))
    Assert 'disk boundary: docker data drive at 79.9% passes' (-not $diskDocker799.Abort)
    $diskDockerOnC = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System', 'DockerData') 83 37.83))
    Assert 'disk: docker data on C at 83% aborts by the docker rule' ($diskDockerOnC.Abort -and $diskDockerOnC.Reason -match 'docker data drive')
    $diskFree10 = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System') 95 10), (New-DiskDrive 'D:\' @('DockerData') 10 800))
    Assert 'disk boundary: system free exactly 10 GiB passes' (-not $diskFree10.Abort)
    $diskFree999 = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System') 95 9.99), (New-DiskDrive 'D:\' @('DockerData') 10 800))
    Assert 'disk boundary: system free 9.99 GiB aborts' ($diskFree999.Abort -and $diskFree999.Reason -match 'system drive')
    $diskOutput = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System') 50 100), (New-DiskDrive 'D:\' @('DockerData') 10 800), (New-DiskDrive 'E:\' @('Output') 40 9.5))
    Assert 'disk: output drive free < 10 GiB aborts' ($diskOutput.Abort -and $diskOutput.Reason -match 'output drive')
    $diskTemp = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @(
        (New-DiskDrive 'C:\' @('System') 50 100), (New-DiskDrive 'D:\' @('DockerData') 10 800), (New-DiskDrive 'F:\' @('Temp') 40 5))
    Assert 'disk: temp drive free < 10 GiB aborts' ($diskTemp.Abort -and $diskTemp.Reason -match 'temp drive')
    $diskUndet = Test-SuiBaDiskStopCondition -DockerDataDetermined $false -Drives @(
        (New-DiskDrive 'C:\' @('System') 50 100))
    Assert 'disk: undeterminable docker data location aborts (fail-closed)' ($diskUndet.Abort -and $diskUndet.Reason -match 'could not be determined')
    $diskEmpty = Test-SuiBaDiskStopCondition -DockerDataDetermined $true -Drives @()
    Assert 'disk: no facts aborts (fail-closed)' ($diskEmpty.Abort)

    # ------------------------------------------------------------ stub setup
    $env:SUIBA_WINVERIFY_DOCKER = Join-Path (Join-Path $script:TestsDir 'stubs') 'docker-stub.ps1'
    $env:SUIBA_WINVERIFY_GIT = Join-Path (Join-Path $script:TestsDir 'stubs') 'git-stub.ps1'
    $env:SUIBA_WINVERIFY_STUB_FIXTURES = Join-Path $script:TestsDir 'fixtures'

    function Invoke-MainRun {
        param([string]$Scenario, [string]$Tag)
        $stubHome = Join-Path $work "stub-$Tag"
        New-Item -ItemType Directory -Path $stubHome -Force | Out-Null
        $env:SUIBA_WINVERIFY_STUB_HOME = $stubHome
        $env:SUIBA_WINVERIFY_STUB_SCENARIO = $Scenario
        $runsRoot = Join-Path $work "runs-$Tag"
        $out = @(& $pwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:ToolDir 'Invoke-SuiBaVerification.ps1') -DurationMinutes 0.3 -PollSeconds 2 -NonInteractive -SkipWatchdog -RunRoot $runsRoot 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        $runDir = Get-ChildItem $runsRoot -Directory | Where-Object { $_.Name -like 'winverify-*' } | Select-Object -First 1
        return [pscustomobject]@{ ExitCode = $code; Output = $out; RunDir = $runDir; StubHome = $stubHome }
    }

    # ------------------------------------------------------------ happy path
    $happy = Invoke-MainRun -Scenario 'happy' -Tag 'happy'
    Assert 'happy: exit code 0' ($happy.ExitCode -eq 0)
    Assert 'happy: run dir created' ($null -ne $happy.RunDir)
    if ($happy.RunDir) {
        $reports = Join-Path $happy.RunDir.FullName 'reports'
        Assert 'happy: report.md exists' (Test-Path (Join-Path $reports 'report.md'))
        Assert 'happy: report.json exists' (Test-Path (Join-Path $reports 'report.json'))
        Assert 'happy: events.csv exists' (Test-Path (Join-Path $reports 'events.csv'))
        Assert 'happy: samples.csv exists' (Test-Path (Join-Path $reports 'samples.csv'))
        Assert 'happy: preflight summary produced by stub summarizer' (Test-Path (Join-Path $reports 'preflight-summary.json'))
        $report = (Get-Content (Join-Path $reports 'report.json') -Raw) | ConvertFrom-Json
        Assert 'happy: DeepBook 5/6 with 1 timeout' ($report.summary.Apis.'DeepBook Indexer'.Successes -eq 5 -and $report.summary.Apis.'DeepBook Indexer'.Failures -eq 1 -and $report.summary.Apis.'DeepBook Indexer'.Timeouts -eq 1)
        Assert 'happy: Sui gRPC 2/2' ($report.summary.Apis.'Sui gRPC'.Successes -eq 2)
        Assert 'happy: cycles 3/3' ($report.summary.Cycles.Count -eq 3 -and $report.summary.Cycles.Successes -eq 3)
        Assert 'happy: reason COMPLETED' ($report.reason -eq 'COMPLETED')
        $stateHappy = (Get-Content (Join-Path $happy.RunDir.FullName 'state.json') -Raw) | ConvertFrom-Json
        Assert 'happy: state Completed' ($stateHappy.Status -eq 'Completed')
        $secret = [IO.File]::ReadAllText((Join-Path (Join-Path $happy.RunDir.FullName 'secret') 'admin.txt'))
        $leaked = $false
        foreach ($f in @('report.md', 'report.json', 'events.csv', 'samples.csv')) {
            if ([IO.File]::ReadAllText((Join-Path $reports $f)).Contains($secret)) { $leaked = $true }
        }
        Assert 'happy: secret value appears in no report' (-not $leaked)
        $override = [IO.File]::ReadAllText((Join-Path $happy.RunDir.FullName 'compose.override.yaml'))
        Assert 'happy: in-container deadline armed via override' ($override -match 'winverify-deadline' -and $override -match 'SUIBA_WINVERIFY_MAX_RUNTIME_MS')
    }
    $calls = [IO.File]::ReadAllText((Join-Path $happy.StubHome 'calls.log'))
    Assert 'happy: no forbidden docker commands' ($calls -notmatch 'prune|volume rm|\bkill\b|\bdown\b')
    Assert 'happy: dedicated project was stopped at finalize' ($calls -match 'compose .* stop')

    # ------------------------------------------------------------ safety path
    $safety = Invoke-MainRun -Scenario 'safety' -Tag 'safety'
    Assert 'safety: non-zero exit' ($safety.ExitCode -ne 0)
    $callsSafety = [IO.File]::ReadAllText((Join-Path $safety.StubHome 'calls.log'))
    Assert 'safety: dedicated container was stopped' ($callsSafety -match 'compose .* stop| stop ')
    if ($safety.RunDir) {
        $stateSafety = (Get-Content (Join-Path $safety.RunDir.FullName 'state.json') -Raw) | ConvertFrom-Json
        Assert 'safety: state Failed' ($stateSafety.Status -eq 'Failed')
    }

    # ------------------------------------------------------------ watchdog
    $wdRun = Join-Path $work 'wd-run'
    New-Item -ItemType Directory -Path (Join-Path $wdRun 'logs') -Force | Out-Null
    $wdStubHome = Join-Path $work 'stub-wd'
    New-Item -ItemType Directory -Path $wdStubHome -Force | Out-Null
    $env:SUIBA_WINVERIFY_STUB_HOME = $wdStubHome
    $env:SUIBA_PREFLIGHT_PROJECT = 'suiba-wdtest'
    $wdState = [ordered]@{
        RunId = 'wdtest'; Project = 'suiba-wdtest'; ContainerId = 'stubcontainerid0001'
        ImageId = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
        Sha = '4d24126285c35471397e968734a8a53fcd375808'; SecretFile = 'x'
        RepoRoot = $script:RepoRootForTest; OverrideFile = $null
        Status = 'Running'; DeadlineUtc = (Get-Date).ToUniversalTime().AddMinutes(-1).ToString('o')
        RunDir = $wdRun
    }
    if (-not $wdState.RepoRoot) { $wdState.RepoRoot = (Resolve-Path (Join-Path (Join-Path $script:ToolDir '..') '..')).Path }
    [IO.File]::WriteAllText((Join-Path $wdRun 'state.json'), ($wdState | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    # Mark the stub container as running.
    [IO.File]::WriteAllText((Join-Path $wdStubHome 'stub-state.json'), '{"running":true}', [Text.UTF8Encoding]::new($false))
    $wdOut = @(& $pwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:ToolDir 'Watch-SuiBaVerification.ps1') -RunDir $wdRun -GraceSeconds 0 -PollSeconds 1 2>&1 | ForEach-Object { "$_" })
    $wdStateAfter = (Get-Content (Join-Path $wdRun 'state.json') -Raw) | ConvertFrom-Json
    Assert 'watchdog: state WatchdogStopped' ($wdStateAfter.Status -eq 'WatchdogStopped')
    $wdCalls = [IO.File]::ReadAllText((Join-Path $wdStubHome 'calls.log'))
    Assert 'watchdog: stopped the dedicated project' ($wdCalls -match 'stop')
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:SUIBA_WINVERIFY_DOCKER, Env:SUIBA_WINVERIFY_GIT, Env:SUIBA_WINVERIFY_STUB_HOME, Env:SUIBA_WINVERIFY_STUB_FIXTURES, Env:SUIBA_WINVERIFY_STUB_SCENARIO -ErrorAction SilentlyContinue
}

Write-Host "Self-test failures: $script:Failures"
exit $script:Failures
