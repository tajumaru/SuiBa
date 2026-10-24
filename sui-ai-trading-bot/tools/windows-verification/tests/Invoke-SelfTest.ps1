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

    # ------------------------------------------ PS 5.1 finite number
    # Field failure: the .bat launchers run Windows PowerShell 5.1
    # (.NET Framework), which has no [double]::IsFinite. The monitor
    # survived startup, first sample included, and then died with a
    # "method not found" error the first time Get-SuiBaSuccessSummary
    # aggregated evidence in the monitoring loop (this self-test runs
    # on pwsh 7, where the method exists, so it could not catch that).
    # Test-SuiBaFiniteNumber must reproduce the exact same verdicts
    # using only Double.IsNaN / Double.IsInfinity (both runtimes).
    Assert 'finite: ordinary value is finite' (Test-SuiBaFiniteNumber 1.5)
    Assert 'finite: zero is finite' (Test-SuiBaFiniteNumber 0)
    Assert 'finite: negative value is finite' (Test-SuiBaFiniteNumber (-273.15))
    Assert 'finite: large value is finite' (Test-SuiBaFiniteNumber 1.0e300)
    Assert 'finite: NaN is not finite' (-not (Test-SuiBaFiniteNumber ([double]::NaN)))
    Assert 'finite: +Infinity is not finite' (-not (Test-SuiBaFiniteNumber ([double]::PositiveInfinity)))
    Assert 'finite: -Infinity is not finite' (-not (Test-SuiBaFiniteNumber ([double]::NegativeInfinity)))
    $stMixed = Get-SuiBaStats -Values @(5, [double]::NaN, 15, [double]::PositiveInfinity, [double]::NegativeInfinity)
    Assert 'stats: non-finite values are excluded' ($stMixed.N -eq 2 -and $stMixed.P50 -eq 5 -and $stMixed.P95 -eq 15 -and $stMixed.Max -eq 15)

    # ------------------------------------------ PS 5.1 source guard
    # Regression guard for the same class of bug: APIs and cmdlet
    # parameters that exist only on .NET Core / PowerShell 7 must
    # never come back into the product scripts (the .bat launchers
    # run them under Windows PowerShell 5.1). The scan covers every
    # product .ps1 - this self-test and the stubs are excluded, they
    # are not shipped runtime code. Patterns were confirmed absent
    # by a manual audit of all product scripts; ::IsFinite is the
    # one that actually shipped and broke on the real machine.
    $ps51Forbidden = @(
        '::IsFinite', '::Clamp\s*\(', 'GetRelativePath',
        '::ToHexString', '-Parallel\b', '-AsHashtable\b', '-SkipLast\b',
        '-AsByteStream\b', '\bJoin-String\b', '\bTest-Json\b', 'Sort-Object[^\r\n]*-Stable\b')
    $ps51ProductScripts = @(
        (Join-Path $script:ToolDir 'Invoke-SuiBaVerification.ps1'),
        (Join-Path $script:ToolDir 'Stop-SuiBaVerification.ps1'),
        (Join-Path $script:ToolDir 'Watch-SuiBaVerification.ps1'),
        (Join-Path (Join-Path $script:ToolDir 'lib') 'Verification.Common.ps1'))
    Assert 'ps51 guard: patterns are capable of matching' ([regex]::IsMatch('filter { [double]::IsFinite($_) }', $ps51Forbidden[0]))
    foreach ($productScript in $ps51ProductScripts) {
        $source = [IO.File]::ReadAllText($productScript)
        $hits = @($ps51Forbidden | Where-Object { [regex]::IsMatch($source, $_) })
        Assert "ps51 guard: $(Split-Path -Leaf $productScript) uses no PS7/.NET Core-only APIs" ($hits.Count -eq 0)
    }

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

    # -------------------------------------------- docker data location
    # Path normalization is the regression test for the real machine:
    # WSL records docker-desktop BasePath values with a Win32 device
    # prefix, which the old drive-root regex silently rejected.
    Assert 'path normalization: device-prefixed registry BasePath yields D drive' ((Get-SuiBaDriveRoot '\\?\D:\DockerData\DockerDesktopWSL\distro') -eq 'D:\')
    Assert 'path normalization: device-prefixed vhdx path yields C drive' ((Get-SuiBaDriveRoot '\\?\C:\Users\suiba\AppData\Local\Docker\wsl\data\ext4.vhdx') -eq 'C:\')
    Assert 'path normalization: dotted device prefix yields D drive' ((Get-SuiBaDriveRoot '\\.\D:\DockerData\DockerDesktopWSL') -eq 'D:\')
    Assert 'path normalization: forward-slash Windows path yields D drive' ((Get-SuiBaDriveRoot 'D:/DockerData/DockerDesktopWSL') -eq 'D:\')
    Assert 'path normalization: POSIX path is not evidence' ($null -eq (Get-SuiBaDriveRoot '/var/lib/docker'))
    Assert 'path normalization: UNC share path is not evidence' ($null -eq (Get-SuiBaDriveRoot '\\server\share\DockerData'))
    Assert 'path normalization: extended UNC path is not evidence' ($null -eq (Get-SuiBaDriveRoot '\\?\UNC\server\share\DockerData'))
    Assert 'path normalization: relative path is not evidence' ($null -eq (Get-SuiBaDriveRoot 'DockerData\DockerDesktopWSL'))
    Assert 'path normalization: drive-relative path is not evidence' ($null -eq (Get-SuiBaDriveRoot 'D:DockerData\DockerDesktopWSL'))

    # The actual field configuration: DockerRootDir is the Linux VM
    # path, while the registry identifies D as the data drive. Feeding
    # that drive into the unchanged stop rules must not abort for the
    # user's C=83%/37.83 GiB free and D=10.6% used measurements.
    $fieldRoots = @(Get-SuiBaDockerDataDriveRootsFromEvidence -DockerRootDir '/var/lib/docker' -RegistryBasePaths @('\\?\D:\DockerData\DockerDesktopWSL\distro'))
    Assert 'docker location regression: prefixed registry BasePath identifies only D' ($fieldRoots.Count -eq 1 -and $fieldRoots[0] -eq 'D:\')
    $fieldDisk = Test-SuiBaDiskStopCondition -DockerDataDetermined ($null -ne $fieldRoots -and $fieldRoots.Count -gt 0) -Drives @(
        (New-DiskDrive 'C:\' @('System', 'Temp') 83 37.82),
        (New-DiskDrive 'D:\' @('DockerData', 'Output') 10.6 832.64))
    Assert 'docker location regression: field disk measurements pass' (-not $fieldDisk.Abort)

    # Docker Desktop layouts nest the data folder below wslDistros in
    # some versions; recursive settings traversal must still find it.
    $nestedSettings = '{"wslDistros":{"docker-desktop-data":{"dataFolder":"D:\\DockerData\\DockerDesktopWSL"}}}' | ConvertFrom-Json
    $nestedRoots = @(Get-SuiBaDockerDataDriveRootsFromSettings $nestedSettings)
    Assert 'docker location: nested wslDistros dataFolder identifies D' ($nestedRoots.Count -eq 1 -and $nestedRoots[0] -eq 'D:\')
    $nestedEvidenceRoots = @(Get-SuiBaDockerDataDriveRootsFromEvidence -SettingsDocuments @($nestedSettings))
    Assert 'docker location: nested settings evidence identifies D' ($nestedEvidenceRoots.Count -eq 1 -and $nestedEvidenceRoots[0] -eq 'D:\')
    $diskImageSettings = '{"resources":{"DiskImageLocation":"E:\\DockerImages"}}' | ConvertFrom-Json
    $diskImageRoots = @(Get-SuiBaDockerDataDriveRootsFromSettings $diskImageSettings)
    Assert 'docker location: nested DiskImageLocation identifies E' ($diskImageRoots.Count -eq 1 -and $diskImageRoots[0] -eq 'E:\')

    # --------------------------------------------- compose project name
    # Field regression: a run ID embeds an uppercase T/Z timestamp
    # (winverify-20261024T080741Z-b8f4467). Used verbatim as the
    # Compose project name it was rejected on the real machine at
    # 'compose config' resolution, after the image build and Node
    # check had already succeeded.
    $fieldProject = Get-SuiBaComposeProjectName 'winverify-20261024T080741Z-b8f4467'
    Assert 'project name regression: field run ID normalizes to lowercase' ($fieldProject -eq 'suiba-winverify-20261024t080741z-b8f4467')
    Assert 'project name regression: field project name is compose-valid' (Test-SuiBaComposeProjectName $fieldProject)
    Assert 'project name: already-lowercase name passes' (Test-SuiBaComposeProjectName 'suiba-winverify-20261024t080741z-b8f4467')
    Assert 'project name: uppercase is rejected' (-not (Test-SuiBaComposeProjectName 'suiba-Winverify'))
    Assert 'project name: leading hyphen is rejected' (-not (Test-SuiBaComposeProjectName '-suiba'))
    Assert 'project name: other characters are rejected' (-not (Test-SuiBaComposeProjectName 'suiba.winverify'))
    Assert 'project name: empty is rejected' (-not (Test-SuiBaComposeProjectName ''))

    # ------------------------------------------ detailed perf metrics
    # Report-side correlation coverage: missing files are stated as
    # missing with a reason (never zeros), overlap correlation is by
    # timestamp, BUSY/LOCKED counting uses failure error codes, and
    # only whitelisted fields survive (a planted non-whitelisted value
    # must not reach the output).
    $perfDir = Join-Path $work 'perf-unit'
    New-Item -ItemType Directory -Path $perfDir -Force | Out-Null
    $sqliteFixture = Join-Path $perfDir 'sqlite-timing.jsonl'
    [IO.File]::WriteAllText($sqliteFixture, (@(
        '{"v":1,"kind":"sqlite","op":"transaction","table":null,"key":null,"context":"saveCandles","cycleId":"u-cycle","rows":60,"startedAt":1000000042500,"endedAt":1000000043300,"durationMs":800.5,"jsonMs":null,"sqlMs":null,"beginMs":1.2,"bodyMs":790.1,"commitMs":9.2,"rollbackMs":null,"ok":true,"errorCode":null,"note":"PLANTED-SECRET-VALUE"}',
        '{"v":1,"kind":"sqlite","op":"set","table":"bot_runtime_state","key":"k","context":null,"cycleId":null,"rows":1,"startedAt":1000000058000,"endedAt":1000000059500,"durationMs":1500.0,"jsonMs":0.2,"sqlMs":1499.0,"beginMs":null,"bodyMs":null,"commitMs":null,"rollbackMs":null,"ok":true,"errorCode":null}',
        '{"v":1,"kind":"sqlite","op":"append","table":"validation_events","key":null,"context":null,"cycleId":null,"rows":1,"startedAt":1000000073000,"endedAt":1000000073010,"durationMs":10.0,"jsonMs":0.1,"sqlMs":9.0,"beginMs":null,"bodyMs":null,"commitMs":null,"rollbackMs":null,"ok":false,"errorCode":5}',
        'broken line'
    ) -join "`n"), [Text.UTF8Encoding]::new($false))
    $spikeFixture = Join-Path $perfDir 'event-loop-spikes.jsonl'
    [IO.File]::WriteAllText($spikeFixture, '{"v":1,"kind":"event-loop-spike","startedAt":1000000042800,"endedAt":1000000044300,"windowMs":1500,"maxDelayMs":1450.5,"p50Ms":21.0,"p95Ms":900.0,"p99Ms":1400.0,"thresholdMs":500,"cycleId":"u-cycle","memory":{"rss":100,"heapTotal":90,"heapUsed":50,"external":1,"arrayBuffers":1}}', [Text.UTF8Encoding]::new($false))
    $readSqlite = Read-SuiBaPerfJsonl -Path $sqliteFixture
    Assert 'perf: jsonl parsed with bad line counted' ($readSqlite.Available -and $readSqlite.Rows.Count -eq 3 -and $readSqlite.BadLines -eq 1)
    $readMissing = Read-SuiBaPerfJsonl -Path (Join-Path $perfDir 'does-not-exist.jsonl')
    Assert 'perf: missing file is unavailable with a reason' ((-not $readMissing.Available) -and $readMissing.Reason -match '存在しません')
    $statusRec = Get-SuiBaPerfDetailStatus -Lines @('noise {"event":"PREFLIGHT_PERF_DETAIL_STATUS","eventLoopThresholdMs":500,"spikesDetected":1,"eventLoopCumulative":{"count":1,"p50Ms":1,"p95Ms":2,"p99Ms":3,"maxMs":4},"sqliteWriter":{"file":"sqlite-timing.jsonl","written":3,"dropped":0,"bytesWritten":1,"flushCount":1,"flushFailures":0,"flushTotalMs":5.0,"flushMaxMs":5.0,"truncated":false,"queued":0},"spikeWriter":{"file":"event-loop-spikes.jsonl","written":1,"dropped":0,"bytesWritten":1,"flushCount":1,"flushFailures":0,"flushTotalMs":1.0,"flushMaxMs":1.0,"truncated":false,"queued":0}}')
    Assert 'perf: status record parsed from log lines' ($null -ne $statusRec -and $statusRec.eventLoopThresholdMs -eq 500)
    $cycleRows = @([pscustomobject]@{ kind = 'cycle'; began = 1000000042000; at = 1000000045000; durationMs = 3000; action = 'WAIT'; error = $null })
    $corr = Get-SuiBaPerfCorrelation -Enabled $true -SqlitePath $sqliteFixture -SpikePath $spikeFixture -StatusRecord $statusRec -EvidenceRows $cycleRows
    Assert 'perf: correlation available' ($corr.available -eq $true)
    Assert 'perf: slowest sqlite op is the 1500ms set' ($corr.sqlite.topSlowest[0].durationMs -eq 1500.0)
    Assert 'perf: busy counted from failed errorCode 5' ($corr.sqlite.busyOrLocked -eq 1 -and $corr.sqlite.failures -eq 1)
    Assert 'perf: spike overlaps the saveCandles transaction' ($corr.spikes.topDelays[0].overlappingSqlite.Count -ge 1 -and $corr.spikes.topDelays[0].overlappingSqlite[0].context -eq 'saveCandles')
    Assert 'perf: spike is inside the evidence cycle' ($corr.spikes.topDelays[0].cycleRelation -match 'サイクル実行中')
    Assert 'perf: non-whitelisted values never reach the correlation' (-not (($corr | ConvertTo-Json -Depth 10).Contains('PLANTED-SECRET-VALUE')))
    $corrMissing = Get-SuiBaPerfCorrelation -Enabled $true -SqlitePath (Join-Path $perfDir 'nope1.jsonl') -SpikePath (Join-Path $perfDir 'nope2.jsonl') -StatusRecord $null -EvidenceRows @()
    Assert 'perf: both files missing stays unavailable with reason' ((-not $corrMissing.available) -and $corrMissing.reason -match '得られませんでした')
    $corrOff = Get-SuiBaPerfCorrelation -Enabled $false -SqlitePath $sqliteFixture -SpikePath $spikeFixture -StatusRecord $statusRec -EvidenceRows $cycleRows
    Assert 'perf: disabled states its reason and is not available' ((-not $corrOff.available) -and $corrOff.reason -match '無効')
    $perfMd = New-SuiBaPerfAnalysisMarkdown -Perf $corr
    Assert 'perf: analysis markdown has TOP10 and the no-causation caveat' ($perfMd -match '遅いSQLite処理 TOP10' -and $perfMd -match '因果関係の証明ではありません')
    $perfMdMissing = New-SuiBaPerfAnalysisMarkdown -Perf $corrMissing
    Assert 'perf: missing data markdown states the reason instead of zeros' ($perfMdMissing -match '計測データが得られませんでした')

    # ------------------------------------------------------------ stub setup
    $env:SUIBA_WINVERIFY_DOCKER = Join-Path (Join-Path $script:TestsDir 'stubs') 'docker-stub.ps1'
    $env:SUIBA_WINVERIFY_GIT = Join-Path (Join-Path $script:TestsDir 'stubs') 'git-stub.ps1'
    $env:SUIBA_WINVERIFY_STUB_FIXTURES = Join-Path $script:TestsDir 'fixtures'

    function Invoke-MainRun {
        param([string]$Scenario, [string]$Tag, [string[]]$ExtraArgs = @())
        $stubHome = Join-Path $work "stub-$Tag"
        New-Item -ItemType Directory -Path $stubHome -Force | Out-Null
        $env:SUIBA_WINVERIFY_STUB_HOME = $stubHome
        $env:SUIBA_WINVERIFY_STUB_SCENARIO = $Scenario
        $runsRoot = Join-Path $work "runs-$Tag"
        $out = @(& $pwshExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:ToolDir 'Invoke-SuiBaVerification.ps1') -DurationMinutes 0.3 -PollSeconds 2 -NonInteractive -SkipWatchdog -RunRoot $runsRoot @ExtraArgs 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        $runDir = $null
        if (Test-Path -LiteralPath $runsRoot) { $runDir = Get-ChildItem $runsRoot -Directory | Where-Object { $_.Name -like 'winverify-*' } | Select-Object -First 1 }
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
        Assert 'happy: next-actions.md exists' (Test-Path (Join-Path $reports 'next-actions.md'))
        Assert 'happy: events.csv exists' (Test-Path (Join-Path $reports 'events.csv'))
        Assert 'happy: samples.csv exists' (Test-Path (Join-Path $reports 'samples.csv'))
        Assert 'happy: preflight summary produced by stub summarizer' (Test-Path (Join-Path $reports 'preflight-summary.json'))
        $report = [IO.File]::ReadAllText((Join-Path $reports 'report.json')) | ConvertFrom-Json -ErrorAction Stop
        Assert 'happy: DeepBook 5/6 with 1 timeout' ($report.summary.Apis.'DeepBook Indexer'.Successes -eq 5 -and $report.summary.Apis.'DeepBook Indexer'.Failures -eq 1 -and $report.summary.Apis.'DeepBook Indexer'.Timeouts -eq 1)
        Assert 'happy: Sui gRPC 2/2' ($report.summary.Apis.'Sui gRPC'.Successes -eq 2)
        Assert 'happy: cycles 3/3' ($report.summary.Cycles.Count -eq 3 -and $report.summary.Cycles.Successes -eq 3)
        Assert 'happy: reason COMPLETED' ($report.reason -eq 'COMPLETED')
        Assert 'happy: COMPLETED is INCONCLUSIVE quality, not PASS' ($report.overallVerdict -eq 'INCONCLUSIVE')
        $stateHappy = (Get-Content (Join-Path $happy.RunDir.FullName 'state.json') -Raw) | ConvertFrom-Json
        Assert 'happy: state Completed' ($stateHappy.Status -eq 'Completed')
        Assert 'happy: state project name is compose-valid lowercase' (Test-SuiBaComposeProjectName $stateHappy.Project)
        $secret = [IO.File]::ReadAllText((Join-Path (Join-Path $happy.RunDir.FullName 'secret') 'admin.txt'))
        $leaked = $false
        foreach ($f in @('report.md', 'report.json', 'events.csv', 'samples.csv')) {
            if ([IO.File]::ReadAllText((Join-Path $reports $f)).Contains($secret)) { $leaked = $true }
        }
        Assert 'happy: secret value appears in no report' (-not $leaked)
        $override = [IO.File]::ReadAllText((Join-Path $happy.RunDir.FullName 'compose.override.yaml'))
        Assert 'happy: in-container deadline armed via override' ($override -match 'winverify-deadline' -and $override -match 'SUIBA_WINVERIFY_MAX_RUNTIME_MS')
        Assert 'happy: override enables detailed perf metrics' ($override -match 'SUIBA_PERF_DETAIL')
        Assert 'happy: state records perf detail enabled' ($stateHappy.PerfDetailEnabled -eq $true)
        Assert 'happy: sqlite-timing.jsonl copied to reports' (Test-Path (Join-Path $reports 'sqlite-timing.jsonl'))
        Assert 'happy: event-loop-spikes.jsonl copied to reports' (Test-Path (Join-Path $reports 'event-loop-spikes.jsonl'))
        Assert 'happy: performance-correlation.json exists' (Test-Path (Join-Path $reports 'performance-correlation.json'))
        Assert 'happy: performance-analysis.md exists' (Test-Path (Join-Path $reports 'performance-analysis.md'))
        Assert 'happy: report.json carries the performance correlation' ($null -ne $report.performance -and $report.performance.available -eq $true -and $report.performance.sqlite.topSlowest[0].durationMs -eq 1500.0)
        $reportMd = [IO.File]::ReadAllText((Join-Path $reports 'report.md'))
        Assert 'happy: report.md has the perf section with TOP10' ($reportMd -match '性能詳細計測' -and $reportMd -match '遅いSQLite処理 TOP10')
        $perfLeaked = $false
        foreach ($f in @('performance-correlation.json', 'performance-analysis.md', 'sqlite-timing.jsonl', 'event-loop-spikes.jsonl')) {
            if ([IO.File]::ReadAllText((Join-Path $reports $f)).Contains($secret)) { $perfLeaked = $true }
        }
        Assert 'happy: secret value appears in no perf report' (-not $perfLeaked)
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

    $off = Invoke-MainRun -Scenario 'happy' -Tag 'detail-off' -ExtraArgs @('-SkipPerfDetail')
    Assert 'detail OFF run completed' ($off.ExitCode -eq 0)
    $offReport = [IO.File]::ReadAllText((Join-Path $off.RunDir.FullName 'reports/report.json')) | ConvertFrom-Json -ErrorAction Stop
    Assert 'detail OFF remains explicitly disabled' (-not $offReport.performance.enabled)
    $stopped = Invoke-MainRun -Scenario 'userstop' -Tag 'userstop'
    Assert 'user stop exits normally' ($stopped.ExitCode -eq 0)
    $stopReport = [IO.File]::ReadAllText((Join-Path $stopped.RunDir.FullName 'reports/report.json')) | ConvertFrom-Json -ErrorAction Stop
    Assert 'user stop produces incomplete report' ($stopReport.reason -eq 'USER_STOPPED' -and $stopReport.overallVerdict -eq 'INCONCLUSIVE')
    Assert 'user stop produces next actions' (Test-Path -LiteralPath (Join-Path $stopped.RunDir.FullName 'reports/next-actions.md'))
    foreach ($scenario in @('docker-down', 'node-mismatch')) {
        $bad = Invoke-MainRun -Scenario $scenario -Tag $scenario
        Assert "$scenario aborts" ($bad.ExitCode -ne 0)
        $badCalls = [IO.File]::ReadAllText((Join-Path $bad.StubHome 'calls.log'))
        Assert "$scenario never starts a container" ($badCalls -notmatch 'compose .* up')
    }

    # Actual interactive entry: Enter chooses 30m, fixture asks for user stop.
    # No 30m real communication and no Explorer window are launched.
    $menuHome = Join-Path $work 'stub-menu'
    New-Item -ItemType Directory -Path $menuHome -Force | Out-Null
    $env:SUIBA_WINVERIFY_STUB_HOME = $menuHome
    $env:SUIBA_WINVERIFY_STUB_SCENARIO = 'userstop'
    $menuRoot = Join-Path $work 'runs-menu'
    $inputFile = Join-Path $work 'menu-input.txt'
    [IO.File]::WriteAllText($inputFile, "`r`n")
    $menuScript = Join-Path $script:ToolDir 'Invoke-SuiBaVerification.ps1'
    $menuOut = Join-Path $work 'menu-out.log'
    $menuErr = Join-Path $work 'menu-err.log'
    $menuProc = New-Object Diagnostics.Process
    $menuProc.StartInfo = New-Object Diagnostics.ProcessStartInfo
    $menuProc.StartInfo.FileName = $pwshExe
    $menuProc.StartInfo.Arguments = (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $menuScript + '"'), '-PollSeconds', '2', '-SkipWatchdog', '-NoOpenResults', '-RunRoot', ('"' + $menuRoot + '"')) -join ' ')
    $menuProc.StartInfo.UseShellExecute = $false
    $menuProc.StartInfo.CreateNoWindow = $true
    $menuProc.StartInfo.RedirectStandardInput = $true
    $menuProc.StartInfo.RedirectStandardOutput = $true
    $menuProc.StartInfo.RedirectStandardError = $true
    [void]$menuProc.Start()
    $outputTask = $menuProc.StandardOutput.ReadToEndAsync()
    $errorTask = $menuProc.StandardError.ReadToEndAsync()
    $menuProc.StandardInput.WriteLine('')
    $menuProc.StandardInput.Close()
    if (-not $menuProc.WaitForExit(60000)) {
        $menuProc.Kill()
        throw 'Menu smoke test exceeded 60s (stub-only child terminated)'
    }
    Assert '30m menu starts and stops with fixture' ($menuProc.ExitCode -eq 0)
    [IO.File]::WriteAllText($menuOut, $outputTask.Result)
    [IO.File]::WriteAllText($menuErr, $errorTask.Result)
    $menuProc.Dispose()
    $menuRun = Get-ChildItem -LiteralPath $menuRoot -Directory | Where-Object { $_.Name -like 'winverify-*' } | Select-Object -First 1
    $menuReport = [IO.File]::ReadAllText((Join-Path $menuRun.FullName 'reports/report.json')) | ConvertFrom-Json -ErrorAction Stop
    Assert 'Enter really selects 30m in monitor' ($menuReport.durationMinutesPlanned -eq 30)
    Assert 'menu smoke never enables trading' (-not $menuReport.facts.RunningTrueSeen -and -not $menuReport.facts.NonzeroOrdersSeen)

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
} catch {
    $script:Failures++
    Write-Host "FAIL: self-test aborted: $($_.Exception.Message)"
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:SUIBA_WINVERIFY_DOCKER, Env:SUIBA_WINVERIFY_GIT, Env:SUIBA_WINVERIFY_STUB_HOME, Env:SUIBA_WINVERIFY_STUB_FIXTURES, Env:SUIBA_WINVERIFY_STUB_SCENARIO -ErrorAction SilentlyContinue
}

Write-Host "Self-test failures: $script:Failures"
exit $script:Failures
