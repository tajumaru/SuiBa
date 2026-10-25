# SuiBa Windows unattended verification - main monitor.
#
# Double-click Start-SuiBaVerification.bat, choose a duration
# (30m / 2h / 6h / 24h), and this script runs the whole verification
# with no AI agent involved:
#   * builds a dedicated image and verifies the real Node.js version
#     inside a network-less container (>=24.22.1 <25),
#   * starts ONLY a new dedicated Docker Compose project based on
#     docker/compose.preflight-30m.yaml (MODE=PAPER, running=false,
#     no order operation is ever started, LIVE is never used),
#   * passively monitors Sui gRPC / DeepBook / market freshness /
#     SQLite / event loop / memory via the existing preflight observer
#     evidence (scripts/preflight-observer.mjs) and passive metrics,
#   * stops ONLY the dedicated project when a stop condition from
#     docs/NODE_DOCKER_30M_PREFLIGHT.md fires, and
#   * writes Markdown / JSON / CSV reports at the end.
#
# Existing containers, databases and volumes are never modified: the
# project name, image tag, volumes and secret are unique per run.
# Anti-runaway layers: compose restart="no", a detached watchdog
# process (Watch-SuiBaVerification.ps1), and an in-container deadline
# (scripts/winverify-deadline.mjs via NODE_OPTIONS) that terminates the
# worker even if every host process dies.
#
# Detailed performance metrics (SQLite per-operation timing and
# event-loop spikes, scripts/preflight-detailed-metrics.mjs) are ON
# for verification runs via SUIBA_PERF_DETAIL=1 in the compose
# override; -SkipPerfDetail turns them back off. They add no RPC
# and never change abort/recovery judgments.
#
# Compatible with Windows PowerShell 5.1 and PowerShell 7.
param(
    [double]$DurationMinutes = 0,
    [int]$PollSeconds = 20,
    [string]$RunRoot = '',
    [switch]$NonInteractive,
    [switch]$SkipWatchdog,
    [switch]$SkipPerfDetail,
    [switch]$ConfirmLongRun,
    [switch]$NoOpenResults
)

$script:ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:RepoRoot = (Resolve-Path (Join-Path (Join-Path $script:ToolDir '..') '..')).Path
. (Join-Path (Join-Path $script:ToolDir 'lib') 'Verification.Common.ps1')
. (Join-Path (Join-Path $script:ToolDir 'lib') 'Verification.OneClick.ps1')

$script:DockerExe = if ($env:SUIBA_WINVERIFY_DOCKER) { $env:SUIBA_WINVERIFY_DOCKER } else { 'docker' }
$script:GitExe = if ($env:SUIBA_WINVERIFY_GIT) { $env:SUIBA_WINVERIFY_GIT } else { 'git' }
$script:Incidents = New-Object System.Collections.ArrayList
$script:State = $null
$script:RunDir = $null
$script:SecretValue = $null
$script:Finalized = $false
$script:RunMutex = $null
$script:OwnsMutex = $false

function Invoke-External {
    param([string]$Exe, [string[]]$CommandArgs, [int]$TimeoutSec = 0)
    if ($TimeoutSec -gt 0) {
        $job = Start-Job -ScriptBlock {
            param($e, $a)
            $ErrorActionPreference = 'Continue'
            # Arguments crossing the job boundary arrive double-wrapped
            # as ArrayList; flatten them back into a plain string array
            # or splatting would pass the whole list as one argument.
            function Flatten-Args($x) {
                $r = @()
                foreach ($i in $x) {
                    if ($i -is [System.Collections.IList]) { $r += Flatten-Args $i } else { $r += "$i" }
                }
                return $r
            }
            [string[]]$a = Flatten-Args $a
            $o = @(& $e @a 2>&1 | ForEach-Object { "$_" })
            $c = $LASTEXITCODE
            [pscustomobject]@{ ExitCode = $(if ($null -eq $c) { 0 } else { [int]$c }); Output = [string[]]$o }
        } -ArgumentList $Exe, (,$CommandArgs)
        try {
            if (Wait-Job $job -Timeout $TimeoutSec) {
                $r = Receive-Job $job
                return [pscustomobject]@{ ExitCode = [int]$r.ExitCode; Output = [string[]]$r.Output }
            }
            Stop-Job $job
            return [pscustomobject]@{ ExitCode = 124; Output = [string[]]@('TIMEOUT') }
        } finally { Remove-Job $job -Force -ErrorAction SilentlyContinue }
    }
    $ErrorActionPreference = 'Continue'
    $out = @()
    $code = 0
    try {
        $out = @(& $Exe @CommandArgs 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } catch {
        $out = @("$($_.Exception.Message)")
        $code = 1
    }
    if ($null -eq $code) { $code = 0 }
    return [pscustomobject]@{ ExitCode = [int]$code; Output = [string[]]$out }
}

function Invoke-Docker { param([string[]]$DockerArgs, [int]$TimeoutSec = 0) Invoke-External -Exe $script:DockerExe -CommandArgs $DockerArgs -TimeoutSec $TimeoutSec }
function Invoke-Git { param([string[]]$GitArgs) Invoke-External -Exe $script:GitExe -CommandArgs $GitArgs }

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $Message
    Write-Host $line
    if ($script:RunDir) {
        $logPath = Join-Path (Join-Path $script:RunDir 'logs') 'monitor.log'
        Add-Content -Path $logPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    }
}

function Add-Incident {
    param([string]$Reason, [string]$Detail = '')
    $rec = [pscustomobject]@{
        AtUtc  = (Get-Date).ToUniversalTime().ToString('o')
        Reason = $Reason
        Detail = $Detail
    }
    [void]$script:Incidents.Add($rec)
    Write-Log "INCIDENT: $Reason $Detail"
}

function Save-State {
    if ($null -eq $script:State) { return }
    $path = Join-Path $script:RunDir 'state.json'
    $json = $script:State | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
    $activeDir = Join-Path $script:RunRoot 'active'
    if (-not (Test-Path $activeDir)) { New-Item -ItemType Directory -Path $activeDir -Force | Out-Null }
    $pointer = [ordered]@{ RunId = $script:State.RunId; RunDir = $script:RunDir; StateFile = $path; Status = $script:State.Status }
    [IO.File]::WriteAllText((Join-Path $activeDir 'active-run.json'), ($pointer | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

function Get-ContainerInspect {
    param([string]$ContainerId)
    $r = Invoke-Docker @('inspect', $ContainerId)
    if ($r.ExitCode -ne 0 -or $r.Output.Count -eq 0) { return $null }
    try {
        $arr = ($r.Output -join "`n") | ConvertFrom-Json -ErrorAction Stop
        return $arr[0]
    } catch { return $null }
}

function Test-DedicatedContainer {
    # Every stop path must prove the target belongs to this run's
    # dedicated project before touching it.
    param($Inspect)
    if ($null -eq $Inspect) { return $false }
    $labels = $Inspect.Config.Labels
    if ($null -eq $labels) { return $false }
    $proj = $labels.'com.docker.compose.project'
    return ($proj -eq $script:State.Project -and $Inspect.Id -eq $script:State.ContainerId)
}

function Set-ComposeEnvFromState {
    $env:SUIBA_PREFLIGHT_PROJECT = $script:State.Project
    $env:SUIBA_PREFLIGHT_IMAGE = $script:State.ImageId
    $env:SUIBA_PREFLIGHT_SHA = $script:State.Sha
    $env:SUIBA_PREFLIGHT_SECRET_FILE = $script:State.SecretFile
}

function Stop-DedicatedProject {
    param([string]$Why)
    if ($null -eq $script:State -or -not $script:State.ContainerId) { return }
    $insp = Get-ContainerInspect -ContainerId $script:State.ContainerId
    if ($null -eq $insp) { Write-Log 'Stop skipped: container already gone.'; return }
    if (-not (Test-DedicatedContainer $insp)) {
        Add-Incident -Reason 'STOP_REFUSED_NOT_DEDICATED' -Detail $Why
        return
    }
    if (-not $insp.State.Running) { Write-Log 'Container already stopped.'; return }
    Set-ComposeEnvFromState
    $composeArgs = @('compose', '-p', $script:State.Project, '-f', (Join-Path (Join-Path $script:RepoRoot 'docker') 'compose.preflight-30m.yaml'))
    if ($script:State.OverrideFile -and (Test-Path $script:State.OverrideFile)) { $composeArgs += @('-f', $script:State.OverrideFile) }
    $composeArgs += @('stop', '-t', '30')
    Write-Log "Stopping dedicated project only ($Why)..."
    $r = Invoke-Docker $composeArgs
    if ($r.ExitCode -ne 0) {
        # Fallback: stop the single verified container by ID. Still only ours.
        $r2 = Invoke-Docker @('stop', '-t', '30', $script:State.ContainerId)
        if ($r2.ExitCode -ne 0) { Add-Incident -Reason 'STOP_FAILED' -Detail ($r.Output -join ' ') }
    }
}

function Resolve-DockerDataDriveRoots {
    # Determines which host drive(s) hold Docker's data (the Docker
    # Desktop disk image). Returns an array of drive roots, or $null
    # when the location cannot be determined; the caller treats $null
    # as a stop condition (fail-closed) and never guesses a drive.
    #
    # Evidence sources (every drive found by any source is judged;
    # sources never veto each other):
    #  (a) `docker info` DockerRootDir - only when it is an absolute
    #      Windows path. Under Docker Desktop / WSL2 it is
    #      '/var/lib/docker', a path inside the Linux VM that names no
    #      host drive, so a POSIX result is deliberately NOT used as
    #      evidence.
    #  (b) WSL2 distro registry (HKCU:\Software\Microsoft\Windows\
    #      CurrentVersion\Lxss): the BasePath of the docker-desktop
    #      distro(s) is the folder holding the vhdx, and it follows
    #      Docker Desktop's "disk image location" setting. WSL commonly
    #      records this value with a Win32 device prefix; the shared
    #      normalization in lib/Verification.Common.ps1 removes that
    #      prefix before extracting the drive.
    #  (c) Docker Desktop settings (settings-store.json /
    #      settings.json): parsed documents are searched recursively
    #      for string values of data-folder-like settings, including
    #      layouts nested under wslDistros entries.
    #  (d) The default vhdx locations under %LOCALAPPDATA%\Docker\wsl,
    #      including a shallow recursive search (depth 3) for *.vhdx.
    # Raw evidence is aggregated by the pure
    # Get-SuiBaDockerDataDriveRootsFromEvidence function so the exact
    # normalization and settings traversal used here are unit-testable.
    $dockerRootDir = ''
    try {
        $r = Invoke-Docker @('info', '--format', '{{.DockerRootDir}}')
        if ($r.ExitCode -eq 0 -and $r.Output.Count -gt 0) { $dockerRootDir = "$($r.Output[0])" }
    } catch { }
    $registryBasePaths = @()
    try {
        $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
        if (Test-Path $lxss) {
            foreach ($key in (Get-ChildItem $lxss -ErrorAction Stop)) {
                try {
                    $props = Get-ItemProperty $key.PSPath -ErrorAction Stop
                    if ("$($props.DistributionName)" -like 'docker-desktop*') {
                        $registryBasePaths += "$($props.BasePath)"
                    }
                } catch { }
            }
        }
    } catch { }
    $settingsDocuments = @()
    try {
        foreach ($settingsName in @('settings-store.json', 'settings.json')) {
            $settingsPath = Join-Path (Join-Path $env:APPDATA 'Docker') $settingsName
            if (-not (Test-Path $settingsPath)) { continue }
            try {
                $settingsDocuments += ([IO.File]::ReadAllText($settingsPath) | ConvertFrom-Json -ErrorAction Stop)
            } catch { }
        }
    } catch { }
    $vhdxPaths = @()
    try {
        $wslDir = Join-Path $env:LOCALAPPDATA 'Docker\wsl'
        foreach ($candidate in @('data\docker_data.vhdx', 'disk\docker_data.vhdx', 'main\ext4.vhdx', 'data\ext4.vhdx')) {
            $vhdx = Join-Path $wslDir $candidate
            if (Test-Path $vhdx) { $vhdxPaths += $vhdx }
        }
        if (Test-Path $wslDir) {
            foreach ($vhdxFile in @(Get-ChildItem -LiteralPath $wslDir -Filter '*.vhdx' -File -Recurse -Depth 3 -ErrorAction Stop)) {
                $vhdxPaths += $vhdxFile.FullName
            }
        }
    } catch { }
    return Get-SuiBaDockerDataDriveRootsFromEvidence -DockerRootDir $dockerRootDir -RegistryBasePaths $registryBasePaths -SettingsDocuments $settingsDocuments -ExistingVhdxPaths $vhdxPaths
}

function Get-DiskFacts {
    # Collects disk facts and judges them with
    # Test-SuiBaDiskStopCondition (lib/Verification.Common.ps1), which
    # encodes the 30-minute validation agreement
    # (docs/PREFLIGHT_30M_20261024.md section 14: "D80% / C free
    # 10 GiB"): the Docker data drive stops at >= 80% used; the
    # system, output (runs/: logs, reports, evidence, secret, compose
    # override) and temp drives stop at < 10 GiB free, regardless of
    # their used percentage. This one function backs BOTH the start
    # gate and the in-run periodic check (every 5 minutes), so both
    # apply exactly the same conditions.
    # Fail-closed: any collection failure, or a Docker data location
    # that cannot be determined, aborts instead of skipping the check.
    $facts = [pscustomobject]@{ Abort = $false; Reason = ''; Checks = @() }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
        # Non-Windows hosts occur only in the stub-based self-test;
        # the tool ships for Windows, where the collection below
        # always runs and is fail-closed.
        $facts.Checks += 'disk check not applicable (non-Windows test host)'
        return $facts
    }
    try {
        $roles = @{}
        $addRole = {
            param([string]$Root, [string]$Role)
            if (-not $Root) { return }
            if (-not $roles.ContainsKey($Root)) { $roles[$Root] = New-Object System.Collections.ArrayList }
            if (-not $roles[$Root].Contains($Role)) { [void]$roles[$Root].Add($Role) }
        }
        & $addRole (Get-SuiBaDriveRoot ([Environment]::SystemDirectory)) 'System'
        $outBase = if ($script:RunRoot) { $script:RunRoot } else { $script:ToolDir }
        & $addRole (Get-SuiBaDriveRoot $outBase) 'Output'
        & $addRole (Get-SuiBaDriveRoot ([IO.Path]::GetTempPath())) 'Temp'
        $dockerRoots = Resolve-DockerDataDriveRoots
        $dockerDetermined = ($null -ne $dockerRoots)
        if ($dockerDetermined) { foreach ($dr in $dockerRoots) { & $addRole $dr 'DockerData' } }
        $entries = @()
        foreach ($rootName in @($roles.Keys | Sort-Object)) {
            $di = [IO.DriveInfo]::new($rootName)
            if (-not $di.IsReady -or $di.TotalSize -le 0) { throw "drive $rootName is not ready" }
            $entries += [pscustomobject]@{
                Name    = $rootName
                Roles   = [string[]]@($roles[$rootName])
                UsedPct = 100.0 * (1 - $di.AvailableFreeSpace / $di.TotalSize)
                FreeGiB = $di.AvailableFreeSpace / 1GB
            }
        }
        $judged = Test-SuiBaDiskStopCondition -Drives $entries -DockerDataDetermined $dockerDetermined
        $facts.Abort = $judged.Abort
        $facts.Reason = $judged.Reason
        $facts.Checks = $judged.Checks
        if ($dockerDetermined) { $facts.Checks += "docker data drive(s): $($dockerRoots -join ', ')" }
    } catch {
        $facts.Abort = $true
        $facts.Reason = "disk check failed (fail-closed): $($_.Exception.Message)"
    }
    return $facts
}

function Copy-EvidenceFile {
    # Reads the observer evidence out of the dedicated container
    # (read-only operation on our own container).
    $dest = Join-Path (Join-Path $script:RunDir 'evidence') 'preflight-evidence.jsonl'
    $r = Invoke-Docker @('cp', "$($script:State.ContainerId):/app/reports/preflight-evidence.jsonl", $dest)
    return ($r.ExitCode -eq 0 -and (Test-Path $dest))
}

function Get-LatestPassiveMetrics {
    $r = Invoke-Docker @('logs', '--tail', '400', $script:State.ContainerId)
    if ($r.ExitCode -ne 0) { return $null }
    $latest = $null
    foreach ($line in $r.Output) {
        $idx = $line.IndexOf('{')
        if ($idx -lt 0) { continue }
        try {
            $obj = $line.Substring($idx) | ConvertFrom-Json -ErrorAction Stop
            if ($obj.event -eq 'PREFLIGHT_PASSIVE_METRICS') { $latest = $obj }
        } catch { }
    }
    return $latest
}

function Get-MemoryBytes {
    $r = Invoke-Docker @('stats', '--no-stream', '--format', '{{.MemUsage}}', $script:State.ContainerId)
    if ($r.ExitCode -ne 0 -or $r.Output.Count -eq 0) { return $null }
    $used = ($r.Output[0] -split '/')[0].Trim()
    $m = [regex]::Match($used, '^([0-9.]+)\s*([a-zA-Z]+)$')
    if (-not $m.Success) { return $null }
    $mult = @{ 'B' = 1; 'KB' = 1KB; 'MB' = 1MB; 'GB' = 1GB; 'KIB' = 1KB; 'MIB' = 1MB; 'GIB' = 1GB }[$m.Groups[2].Value.ToUpper()]
    if ($null -eq $mult) { return $null }
    return [long]([double]$m.Groups[1].Value * $mult)
}

function Read-SuiBaNewEvidence {
    # Incremental parse of the copied evidence file. Uses script-scope
    # $script:EvidenceState = @{ Offset; Partial; AllRows }.
    if ($null -eq $script:EvidenceState) {
        $script:EvidenceState = @{ Offset = 0L; Partial = ''; AllRows = (New-Object System.Collections.ArrayList) }
    }
    $path = Join-Path (Join-Path $script:RunDir 'evidence') 'preflight-evidence.jsonl'
    if (-not (Test-Path $path)) { return [pscustomobject]@{ AllRows = $script:EvidenceState.AllRows } }
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        if ($fs.Length -lt $script:EvidenceState.Offset) {
            $script:EvidenceState.Offset = 0L
            $script:EvidenceState.Partial = ''
            $script:EvidenceState.AllRows.Clear()
        }
        [void]$fs.Seek($script:EvidenceState.Offset, [IO.SeekOrigin]::Begin)
        $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $script:EvidenceState.Offset = $fs.Length
    } finally { $fs.Dispose() }
    $combined = $script:EvidenceState.Partial + $text
    $lines = $combined -split "`n"
    $script:EvidenceState.Partial = $lines[$lines.Count - 1]
    $complete = @()
    if ($lines.Count -gt 1) { $complete = $lines[0..($lines.Count - 2)] }
    $parsed = ConvertFrom-SuiBaEvidenceLines -Lines $complete
    foreach ($row in $parsed.Rows) { [void]$script:EvidenceState.AllRows.Add($row) }
    return [pscustomobject]@{ AllRows = $script:EvidenceState.AllRows }
}

function Finalize-SuiBaRun {
    param([string]$Reason, [string]$NodeVersion, $LatestMetrics, $MaxMemory, $AllRows)
    if ($script:Finalized) { return }
    $script:Finalized = $true
    $evidenceDir = Join-Path $script:RunDir 'evidence'
    $reportsDir = Join-Path $script:RunDir 'reports'
    $summaryVerdict = $null

    $insp = Get-ContainerInspect -ContainerId $script:State.ContainerId
    $wasRunning = $insp -and $insp.State.Running
    if ($wasRunning) {
        # Final read-only audit inside the dedicated container (uses the
        # per-run secret file inside the container; the token value is
        # never printed or saved by the audit script itself).
        $auditArgs = @('compose', '-p', $script:State.Project, '-f', (Join-Path (Join-Path $script:RepoRoot 'docker') 'compose.preflight-30m.yaml'), '-f', $script:State.OverrideFile, 'exec', '-T', 'bot', 'node', 'scripts/preflight-audit.cjs')
        # Never add an upstream read/delay to an abnormal or user-requested stop.
        if ($Reason -eq 'COMPLETED') { $auditArgs += '--end-book' }
        $audit = Invoke-Docker $auditArgs -TimeoutSec 120
        if ($audit.ExitCode -eq 0 -and $audit.Output.Count -gt 0) {
            [IO.File]::WriteAllText((Join-Path $evidenceDir 'audit.json'), ($audit.Output -join "`n"), [Text.UTF8Encoding]::new($false))
        } else {
            Add-Incident -Reason 'AUDIT_FAILED' -Detail 'Final audit could not be collected.'
        }
    }
    # Evidence + reports out of the dedicated container (still possible
    # after an abnormal exit, before stop).
    [void](Copy-EvidenceFile)
    $cpAll = Invoke-Docker @('cp', "$($script:State.ContainerId):/app/reports/.", $evidenceDir)
    if ($cpAll.ExitCode -ne 0) { Add-Incident -Reason 'EVIDENCE_COPY_PARTIAL' -Detail 'docker cp of /app/reports failed.' }
    $logs = Invoke-Docker @('logs', $script:State.ContainerId)
    [IO.File]::WriteAllLines((Join-Path (Join-Path $script:RunDir 'logs') 'container.log'), [string[]]$logs.Output)

    # Redacted inspection: only whitelisted fields are kept as evidence.
    $inspAfter = Get-ContainerInspect -ContainerId $script:State.ContainerId
    $exitCodeValue = $null; $oom = $null
    if ($inspAfter) {
        $redacted = [ordered]@{
            Id = $inspAfter.Id; Image = $inspAfter.Image; RestartCount = $inspAfter.RestartCount
            State = @{ Status = $inspAfter.State.Status; Running = $inspAfter.State.Running; OOMKilled = $inspAfter.State.OOMKilled; ExitCode = $inspAfter.State.ExitCode }
            Mounts = @($inspAfter.Mounts | ForEach-Object { @{ Type = $_.Type; Name = $_.Name; Destination = $_.Destination } })
            Project = $script:State.Project
        }
        [IO.File]::WriteAllText((Join-Path $evidenceDir 'inspection.json'), ($redacted | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        $oom = [bool]$inspAfter.State.OOMKilled
    }

    # Existing summarizer, run inside a one-off container from the same
    # verified image so the Windows host needs no Node.js installation.
    $contextPath = Join-Path $evidenceDir 'run-context.json'
    $context = [ordered]@{ schemaVersion = 1; runId = $script:State.RunId; project = $script:State.Project
        sha = $script:State.Sha; imageId = $script:State.ImageId; durationMinutes = $script:State.DurationMinutes
        measurementMode = 'passive-health-cache-v1'; perfDetailEnabled = [bool]$script:State.PerfDetailEnabled
        reason = $Reason }
    [IO.File]::WriteAllText($contextPath, ($context | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $auditPath = Join-Path $evidenceDir 'audit.json'
    $evidencePath = Join-Path $evidenceDir 'preflight-evidence.jsonl'
    $inspectPath = Join-Path $evidenceDir 'inspection.json'
    if ((Test-Path $auditPath) -and (Test-Path $evidencePath) -and (Test-Path $inspectPath)) {
        $sum = Invoke-Docker @('run', '--rm', '-v', "${evidenceDir}:/evidence:ro", '-v', "${reportsDir}:/out", '--entrypoint', 'node', $script:State.ImageId, 'scripts/summarize-preflight.cjs', '/evidence/preflight-evidence.jsonl', '/evidence/audit.json', '/evidence/inspection.json', '/out/preflight-summary.json', '/evidence/run-context.json') -TimeoutSec 180
        if ($sum.ExitCode -eq 0 -and (Test-Path (Join-Path $reportsDir 'preflight-summary.json'))) {
            try { $summaryVerdict = ((Get-Content (Join-Path $reportsDir 'preflight-summary.json') -Raw) | ConvertFrom-Json).verdict } catch { }
        } else {
            Add-Incident -Reason 'SUMMARIZER_FAILED' -Detail ($sum.Output -join ' ')
        }
    }

    Stop-DedicatedProject -Why $Reason
    $inspFinal = Get-ContainerInspect -ContainerId $script:State.ContainerId
    if ($inspFinal) { $exitCodeValue = $inspFinal.State.ExitCode; $oom = [bool]$inspFinal.State.OOMKilled }

    $finalParsed = Read-SuiBaNewEvidence
    $rows = $finalParsed.AllRows
    $facts = Get-SuiBaEvidenceFacts -Rows $rows
    $summary = Get-SuiBaSuccessSummary -Rows $rows
    $forbidden = @()
    if ($script:SecretValue) { $forbidden += $script:SecretValue }

    # Detailed performance metrics: the worker flushes its JSONL
    # files and prints PREFLIGHT_PERF_DETAIL_STATUS only at exit, so
    # refresh the copied reports and the container log AFTER the
    # stop before correlating. Missing files are reported as
    # missing with reasons by Get-SuiBaPerfCorrelation; they are
    # never treated as normal values. A failure here must not lose
    # the main report, so it degrades to an incident.
    $perf = $null
    try {
        [void](Invoke-Docker @('cp', "$($script:State.ContainerId):/app/reports/.", $evidenceDir))
        $logsFinal = Invoke-Docker @('logs', $script:State.ContainerId)
        $perfStatus = $null
        if ($logsFinal.ExitCode -eq 0) {
            [IO.File]::WriteAllLines((Join-Path (Join-Path $script:RunDir 'logs') 'container.log'), [string[]]$logsFinal.Output)
            $perfStatus = Get-SuiBaPerfDetailStatus -Lines $logsFinal.Output
        }
        $perfEnabled = $true
        if ($null -ne $script:State.PerfDetailEnabled) { $perfEnabled = [bool]$script:State.PerfDetailEnabled }
        $perf = Get-SuiBaPerfCorrelation -Enabled $perfEnabled -SqlitePath (Join-Path $evidenceDir 'sqlite-timing.jsonl') -SpikePath (Join-Path $evidenceDir 'event-loop-spikes.jsonl') -StatusRecord $perfStatus -EvidenceRows $rows
        foreach ($name in @('sqlite-timing.jsonl', 'event-loop-spikes.jsonl')) {
            $src = Join-Path $evidenceDir $name
            if (Test-Path $src) {
                $rawText = [IO.File]::ReadAllText($src)
                [IO.File]::WriteAllText((Join-Path $reportsDir $name), (Protect-SuiBaText $rawText $forbidden), [Text.UTF8Encoding]::new($false))
            }
        }
        [IO.File]::WriteAllText((Join-Path $reportsDir 'performance-correlation.json'), (Protect-SuiBaText ($perf | ConvertTo-Json -Depth 10) $forbidden), [Text.UTF8Encoding]::new($false))
        $analysis = "# 性能詳細計測レポート`r`n`r`n" + (New-SuiBaPerfAnalysisMarkdown -Perf $perf)
        [IO.File]::WriteAllText((Join-Path $reportsDir 'performance-analysis.md'), (Protect-SuiBaText $analysis $forbidden), [Text.UTF8Encoding]::new($false))
    } catch {
        Add-Incident -Reason 'PERF_DETAIL_FAILED' -Detail "Detailed performance report failed: $($_.Exception.Message)"
    }
    $meta = [pscustomobject]@{
        RunId = $script:State.RunId; Project = $script:State.Project; Sha = $script:State.Sha
        ImageId = $script:State.ImageId; NodeVersion = $NodeVersion
        DurationMinutes = $script:State.DurationMinutes
        StartedAtUtc = $script:State.StartedAtUtc
        EndedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        Reason = $Reason
        ContainerExitCode = $exitCodeValue; ContainerOOMKilled = $oom
        MaxMemoryBytes = $MaxMemory
        PassiveMetrics = $LatestMetrics
        PreflightSummaryVerdict = $summaryVerdict
    }
    New-SuiBaReportFiles -Meta $meta -Summary $summary -Facts $facts -Rows $rows -Incidents $script:Incidents -OutDir $reportsDir -Forbidden $forbidden -Perf $perf
    $overall = New-SuiBaNextActions -ReportsDir $reportsDir -RunRoot $script:RunRoot -Forbidden $forbidden -Rows $rows
    Write-Host "終了理由: $Reason / 総合評価: $overall / 通信品質判定: $summaryVerdict"
    if ($Reason -ne 'COMPLETED') { Write-Host '検証は中断または異常停止しました。' }
    elseif ($overall -ne 'PASS') { Write-Host '観測時間は終了しましたが、品質未達または証拠不足です。成功扱いしません。' }
    else { Write-Host '通信観測の品質基準を達成しました。取引検証の合格ではありません。' }
    Write-Host "レポート: $(Join-Path $reportsDir 'report.md')"
    Write-Host "次の対応: $(Join-Path $reportsDir 'next-actions.md')"
    if (-not $NonInteractive -and -not $NoOpenResults) { Open-SuiBaResultFolder -Path $reportsDir }

    $script:State.Status = if ($Reason -eq 'COMPLETED') { 'Completed' } elseif ($Reason -eq 'USER_STOPPED') { 'StoppedByUser' } else { 'Aborted' }
    $script:State.Reason = $Reason
    Save-State
}

# ---------------------------------------------------------------- preflight
try {
    if ($RunRoot -eq '') { $RunRoot = Join-Path $script:ToolDir 'runs' }
    $script:RunRoot = $RunRoot

    if ($DurationMinutes -le 0) {
        if ($NonInteractive) { throw 'DurationMinutes is required in non-interactive mode.' }
        do {
            $choice = Read-SuiBaMenuChoice
            if ($choice -eq '7') { exit 0 }
            if ($choice -eq '5') {
                $latest = Get-SuiBaLatestReport -RunRoot $RunRoot
                if ($latest) { Open-SuiBaResultFolder -Path (Join-Path $latest.FullName 'reports') }
                else { Write-Host '保存済みの検証結果はありません。' }
            }
            if ($choice -eq '6') {
                & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $script:ToolDir 'Stop-SuiBaVerification.ps1') -RunRoot $RunRoot
            }
        } while ($choice -in @('5', '6'))
        $DurationMinutes = @{ '1' = 30; '2' = 120; '3' = 360; '4' = 1440 }[$choice]
        if ($null -eq $DurationMinutes) { throw 'Invalid selection.' }
    }
    if (@(30, 120, 360, 1440) -notcontains [int]$DurationMinutes -and -not $NonInteractive) {
        throw 'Duration must be 30, 120, 360 or 1440 minutes.'
    }
    Write-Host "Duration: $DurationMinutes minutes"
    if (-not (Confirm-SuiBaLongRun -Minutes $DurationMinutes -NonInteractive:$NonInteractive -Confirmed:$ConfirmLongRun)) {
        Write-Host '開始を取り消しました。'; exit 0
    }
    $script:RunMutex = New-Object Threading.Mutex($false, 'Local\SuiBaWindowsVerification')
    try { $script:OwnsMutex = $script:RunMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $script:OwnsMutex = $true }
    if (-not $script:OwnsMutex) { throw '他のSuiBa検証が起動準備中または実行中です。二重起動を拒否しました。' }
    $pointerPath = Join-Path (Join-Path $RunRoot 'active') 'active-run.json'
    if (Test-Path -LiteralPath $pointerPath) {
        $pointer = [IO.File]::ReadAllText($pointerPath) | ConvertFrom-Json -ErrorAction Stop
        $prior = [IO.File]::ReadAllText($pointer.StateFile) | ConvertFrom-Json -ErrorAction Stop
        if ($prior.Status -in @('Preparing', 'Running')) { throw '前回の検証が準備中・実行中の記録です。安全停止メニューで状態を確認してください。' }
    }

    $dockerVersion = Invoke-Docker @('version', '--format', '{{.Server.Version}}')
    if ($dockerVersion.ExitCode -ne 0) { throw 'Docker engine is not reachable. Start Docker Desktop first.' }
    $composeVersion = Invoke-Docker @('compose', 'version')
    if ($composeVersion.ExitCode -ne 0) { throw 'Docker Compose v2 is not available.' }

    Push-Location $script:RepoRoot
    try { $gitHead = Invoke-Git @('rev-parse', 'HEAD') } finally { Pop-Location }
    if ($gitHead.ExitCode -ne 0) { throw 'Cannot resolve git HEAD; the verification target SHA cannot be fixed.' }
    $sha = ($gitHead.Output[0]).Trim()
    Write-Host "検証対象SHA: $sha（自動git pullは行いません）"
    Push-Location $script:RepoRoot
    try {
        $dirty = Invoke-Git @('status', '--porcelain')
    } finally { Pop-Location }
    if ($dirty.ExitCode -ne 0) { throw 'git status failed.' }
    if (@($dirty.Output | Where-Object { $_ -ne '' }).Count -gt 0) {
        throw 'Working tree is not clean. The verification target must be a fixed commit; commit or stash changes first.'
    }

    # Port 3105 must be free; never fall back to another port.
    $portFree = $true
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('127.0.0.1'), 3105)
        $listener.Start(); $listener.Stop()
    } catch { $portFree = $false }
    if (-not $portFree) { throw 'Port 127.0.0.1:3105 is already in use. Aborting (no fallback, per protocol).' }

    $disk0 = Get-DiskFacts
    foreach ($c in $disk0.Checks) { Write-Host "Disk: $c" }
    if ($disk0.Abort) { throw "Disk stop condition at start: $($disk0.Reason)" }

    # ------------------------------------------------------------ run setup
    $runId = 'winverify-{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ'), $sha.Substring(0, 7)
    # Compose project names are lowercase-only (see
    # Get-SuiBaComposeProjectName in lib): normalize once, here, and
    # guard the result so a future run ID format that smuggles in an
    # invalid character stops BEFORE any Compose call, not inside
    # 'compose config' resolution.
    $project = Get-SuiBaComposeProjectName $runId
    if (-not (Test-SuiBaComposeProjectName $project)) { throw "Generated Compose project name '$project' is invalid: it must consist only of lowercase letters, digits, hyphens and underscores, and start with a letter or digit. Aborting before any Docker Compose call." }
    $imageTag = "suiba-winverify:$runId"
    $script:RunDir = Join-Path $RunRoot $runId
    if (Test-Path -LiteralPath $script:RunDir) { throw '同名の検証結果が存在します。上書きせず中止します。' }
    foreach ($sub in @('evidence', 'reports', 'logs', 'secret')) {
        New-Item -ItemType Directory -Path (Join-Path $script:RunDir $sub) -Force | Out-Null
    }
    Write-Log "Run ID: $runId / project: $project"

    $existing = Invoke-Docker @('image', 'inspect', '--format', '{{.Id}}', $imageTag)
    if ($existing.ExitCode -eq 0) { throw "Image tag $imageTag already exists. Aborting instead of overwriting." }

    # Per-run secret (value is never printed, logged or reported).
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $script:SecretValue = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $secretFile = Join-Path (Join-Path $script:RunDir 'secret') 'admin.txt'
    [IO.File]::WriteAllText($secretFile, $script:SecretValue, [Text.Encoding]::ASCII)

    $script:State = [ordered]@{
        RunId = $runId; Project = $project; ImageTag = $imageTag; ImageId = $null
        Sha = $sha; ContainerId = $null; SecretFile = $secretFile
        RepoRoot = $script:RepoRoot; OverrideFile = $null
        DurationMinutes = $DurationMinutes; StartedAtUtc = $null; DeadlineUtc = $null
        PerfDetailEnabled = (-not $SkipPerfDetail)
        Status = 'Preparing'; Reason = $null
    }
    Save-State

    # ------------------------------------------------------------ build
    Write-Log 'Building dedicated image (unique tag, no overwrite)...'
    Push-Location $script:RepoRoot
    try {
        $build = Invoke-Docker @('build', '--pull', '--no-cache', '-f', (Join-Path 'docker' 'Dockerfile'), '--build-arg', "SUIBA_BUILD_SHA=$sha", '-t', $imageTag, '.')
    } finally { Pop-Location }
    [IO.File]::WriteAllLines((Join-Path (Join-Path $script:RunDir 'logs') 'build.log'), [string[]]$build.Output)
    $img = Invoke-Docker @('image', 'inspect', '--format', '{{.Id}}', $imageTag)
    if ($img.ExitCode -ne 0) { throw 'Image build failed; see logs/build.log.' }
    $imageId = ($img.Output[0]).Trim()
    if ($imageId -notmatch '^sha256:[0-9a-f]{64}$') { throw "Unexpected image ID format: $imageId" }
    $script:State.ImageId = $imageId
    Write-Log "Image ID: $imageId"

    # ------------------------------------------- Node version in container
    $ver = Invoke-Docker @('run', '--rm', '--network', 'none', '--entrypoint', 'node', $imageId, '--version')
    if ($ver.ExitCode -ne 0) { throw 'Node version check container failed to run.' }
    $nodeVersion = ($ver.Output[0]).Trim()
    if (-not (Compare-SuiBaNodeVersion $nodeVersion)) { throw "Node version mismatch in container: $nodeVersion (required >=24.22.1 <25)." }
    $verify = Invoke-Docker @('run', '--rm', '--network', 'none', $imageId, 'node', 'scripts/verify-node-version.mjs')
    if ($verify.ExitCode -ne 0) { throw 'scripts/verify-node-version.mjs rejected the container Node.' }
    Write-Log "Container Node verified: $nodeVersion"

    # ------------------------------------------------------------ compose up
    $maxRuntimeMs = [long](($DurationMinutes + 10) * 60000)
    $overrideFile = Join-Path $script:RunDir 'compose.override.yaml'
    $perfDetailFlag = if ($SkipPerfDetail) { '0' } else { '1' }
    $perfThresholdMs = if ($env:SUIBA_WINVERIFY_PERF_THRESHOLD_MS) { $env:SUIBA_WINVERIFY_PERF_THRESHOLD_MS } else { '500' }
    $overrideYaml = "services:`n  bot:`n    environment:`n      NODE_OPTIONS: `"--import ./scripts/winverify-deadline.mjs`"`n      SUIBA_WINVERIFY_MAX_RUNTIME_MS: `"$maxRuntimeMs`"`n      SUIBA_PERF_DETAIL: `"$perfDetailFlag`"`n      SUIBA_WINVERIFY_RUN_ID: `"$runId`"`n      SUIBA_PREFLIGHT_PROJECT: `"$project`"`n      SUIBA_WINVERIFY_DURATION_MINUTES: `"$DurationMinutes`"`n      SUIBA_PREFLIGHT_MEASUREMENT_MODE: `"passive-health-cache-v1`"`n      SUIBA_PERF_DETAIL_DIR: `"/app/reports`"`n      SUIBA_PERF_EVENT_LOOP_THRESHOLD_MS: `"$perfThresholdMs`"`n"
    [IO.File]::WriteAllText($overrideFile, $overrideYaml, [Text.UTF8Encoding]::new($false))
    $script:State.OverrideFile = $overrideFile

    Set-ComposeEnvFromState
    $baseCompose = Join-Path (Join-Path $script:RepoRoot 'docker') 'compose.preflight-30m.yaml'
    $cfg = Invoke-Docker @('compose', '-p', $project, '-f', $baseCompose, '-f', $overrideFile, 'config', '--quiet')
    if ($cfg.ExitCode -ne 0) { throw "Compose config resolution failed: $($cfg.Output -join ' ')" }

    $startedAt = Get-Date
    $script:State.StartedAtUtc = $startedAt.ToUniversalTime().ToString('o')
    $script:State.DeadlineUtc = $startedAt.AddMinutes($DurationMinutes).ToUniversalTime().ToString('o')
    $script:State.Status = 'Running'
    Save-State

    Write-Log 'Starting dedicated project (PAPER, running=false, no order operation)...'
    $up = Invoke-Docker @('compose', '-p', $project, '-f', $baseCompose, '-f', $overrideFile, 'up', '-d', '--no-build', '--pull', 'never')
    [IO.File]::WriteAllLines((Join-Path (Join-Path $script:RunDir 'logs') 'compose-up.log'), [string[]]$up.Output)
    if ($up.ExitCode -ne 0) { throw "Compose up failed: $($up.Output -join ' ')" }
    $ps = Invoke-Docker @('compose', '-p', $project, '-f', $baseCompose, '-f', $overrideFile, 'ps', '-q', 'bot')
    if ($ps.ExitCode -ne 0 -or $ps.Output.Count -eq 0) { throw 'Cannot find the dedicated bot container after up.' }
    $script:State.ContainerId = ($ps.Output[0]).Trim()
    Save-State

    $insp = Get-ContainerInspect -ContainerId $script:State.ContainerId
    if ($null -eq $insp -or -not (Test-DedicatedContainer $insp)) { throw 'Container identity check failed (not our dedicated project).' }
    if ($insp.Image -ne $imageId) { throw 'Container image does not match the inspected image ID.' }
    $liveGuard = Invoke-Docker @('exec', $script:State.ContainerId, 'node', 'scripts/verify-node-version.mjs')
    if ($liveGuard.ExitCode -ne 0) { throw '実行中コンテナのNode.js確認に失敗しました。' }
    $liveRuntime = ($liveGuard.Output -join "`n") | ConvertFrom-Json -ErrorAction Stop
    if (-not (Compare-SuiBaNodeVersion $liveRuntime.version) -or $liveRuntime.version -ne $nodeVersion) { throw '実行中コンテナのNode.jsバージョンが不一致です。検証を中止します。' }
    foreach ($mnt in @($insp.Mounts)) {
        if ($mnt.Type -eq 'volume' -and $mnt.Name -notlike "$project*") { throw "Unexpected volume mounted: $($mnt.Name)" }
    }
    Write-Log "Container started: $($script:State.ContainerId)"

    # ------------------------------------------------------------ watchdog
    if (-not $SkipWatchdog) {
        try {
            $psExe = (Get-Command 'powershell.exe' -ErrorAction SilentlyContinue).Source
            if (-not $psExe) { $psExe = (Get-Command 'pwsh' -ErrorAction Stop).Source }
            $watchPath = Join-Path $script:ToolDir 'Watch-SuiBaVerification.ps1'
            Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchPath, '-RunDir', $script:RunDir, '-GraceSeconds', '300') -WindowStyle Hidden | Out-Null
            Write-Log 'Watchdog started (stops the dedicated project at deadline + 5 min if this monitor dies).'
        } catch { Write-Log "Watchdog could not be started: $($_.Exception.Message) (in-container deadline still applies)" }
    }

    # ------------------------------------------------- initial sample check
    Write-Log 'Waiting for the first observer sample...'
    $firstDeadline = (Get-Date).AddSeconds(180)
    $gotSample = $false
    $allRows = New-Object System.Collections.ArrayList
    $evidenceOffset = 0L
    $evidencePartial = ''
    while ((Get-Date) -lt $firstDeadline -and -not $gotSample) {
        Start-Sleep -Seconds 5
        if (Copy-EvidenceFile) {
            $parsed = Read-SuiBaNewEvidence
            $allRows = $parsed.AllRows
            if (@($allRows | Where-Object { $_.kind -eq 'sample' }).Count -gt 0) { $gotSample = $true }
        }
    }
    if (-not $gotSample) { throw 'No observer sample within 180 seconds (EVIDENCE_MISSING).' }
    $facts0 = Get-SuiBaEvidenceFacts -Rows $allRows
    if ($facts0.RunningTrueSeen -or $facts0.NonzeroOrdersSeen -or $facts0.SessionSeen) {
        throw 'SAFETY VIOLATION in the first sample (running/orders/session). Stopping.'
    }
    Write-Log 'First sample verified: running=false, orders=0, session=null.'

    # ------------------------------------------------------------ monitor
    # Quality duration starts at the first actual observer sample, not Compose up.
    $firstSampleAt = [long](@($allRows | Where-Object { $_.kind -eq 'sample' })[0].at)
    $observationStart = [DateTimeOffset]::FromUnixTimeMilliseconds($firstSampleAt)
    $deadline = $observationStart.AddMinutes($DurationMinutes).LocalDateTime
    $script:State.ObservationStartedAtUtc = $observationStart.UtcDateTime.ToString('o')
    $script:State.ObservationDeadlineUtc = $observationStart.AddMinutes($DurationMinutes).UtcDateTime.ToString('o')
    Save-State
    $reason = 'COMPLETED'
    $copyFailStreak = 0
    $unhealthyStreak = 0
    $maxMemory = $null
    $lastDiskCheck = Get-Date
    $diskAbort = $false; $diskAbortReason = ''
    $latestMetrics = $null

    # A stop request can arrive during the initial sample wait, before this loop.
    if (Test-Path (Join-Path $script:RunDir 'STOP_REQUEST')) {
        $reason = 'USER_STOPPED'
        Add-Incident -Reason 'USER_STOPPED' -Detail 'Stop requested before monitoring.'
    }
    while ($reason -eq 'COMPLETED' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $PollSeconds
        $stopReq = Join-Path $script:RunDir 'STOP_REQUEST'
        if (Test-Path $stopReq) { $reason = 'USER_STOPPED'; Add-Incident -Reason 'USER_STOPPED' -Detail 'Stop requested via Stop bat.'; break }

        if (Copy-EvidenceFile) {
            $copyFailStreak = 0
            $parsed = Read-SuiBaNewEvidence
            $allRows = $parsed.AllRows
        } else {
            $copyFailStreak++
            Add-Incident -Reason 'MONITOR_COPY_FAILED' -Detail "streak=$copyFailStreak"
        }
        $m = Get-LatestPassiveMetrics
        if ($null -ne $m) { $latestMetrics = $m }
        $mem = Get-MemoryBytes
        if ($null -ne $mem -and ($null -eq $maxMemory -or $mem -gt $maxMemory)) { $maxMemory = $mem }

        if (((Get-Date) - $lastDiskCheck).TotalMinutes -ge 5) {
            $lastDiskCheck = Get-Date
            $df = Get-DiskFacts
            if ($df.Abort) { $diskAbort = $true; $diskAbortReason = $df.Reason }
        }

        $inspNow = Get-ContainerInspect -ContainerId $script:State.ContainerId
        $health = $null
        if ($inspNow -and $inspNow.State.Health) { $health = $inspNow.State.Health.Status }
        if ($health -eq 'unhealthy') { $unhealthyStreak++ } else { $unhealthyStreak = 0 }

        $facts = Get-SuiBaEvidenceFacts -Rows $allRows
        $abortState = [pscustomobject]@{
            RunningTrueSeen = $facts.RunningTrueSeen
            NonzeroOrdersSeen = $facts.NonzeroOrdersSeen
            SessionSeen = $facts.SessionSeen
            IntegrityFaultSeen = $facts.IntegrityFaultSeen
            IntegrityBadSeen = $facts.IntegrityBadSeen
            SqliteBusy = if ($latestMetrics) { [int]$latestMetrics.sqliteBusy } else { 0 }
            SqliteLocked = if ($latestMetrics) { [int]$latestMetrics.sqliteLocked } else { 0 }
            SqliteFailures = if ($latestMetrics) { [int]($latestMetrics.sqlite.append.failures + $latestMetrics.sqlite.set.failures + $latestMetrics.sqlite.transaction.failures) } else { 0 }
            OOMKilled = if ($inspNow) { [bool]$inspNow.State.OOMKilled } else { $false }
            RestartCount = if ($inspNow) { [int]$inspNow.RestartCount } else { 0 }
            ContainerRunning = if ($inspNow) { [bool]$inspNow.State.Running } else { $false }
            BuildVariantCount = $facts.BuildVariantCount
            ConsecutiveFailedCycles = $facts.ConsecutiveFailedCycles
            HasSuccessfulCycleHistory = (@($allRows | Where-Object { $_.kind -eq 'cycle' -and -not $_.error }).Count -gt 0)
            LastSuccessCycleAgeSec = $facts.LastSuccessCycleAgeSec
            SampleCount = $facts.SampleCount
            MaxSampleGapSec = $facts.MaxSampleGapSec
            ElapsedSec = ((Get-Date) - $startedAt).TotalSeconds
            UnhealthyStreak = $unhealthyStreak
            MonitorCopyFailStreak = $copyFailStreak
            DiskAbort = $diskAbort
            DiskAbortReason = $diskAbortReason
        }
        $abort = Test-SuiBaAbortCondition -State $abortState
        $summaryNow = Get-SuiBaSuccessSummary -Rows $allRows
        $remaining = $deadline - (Get-Date)
        if ($remaining.Ticks -lt 0) { $remaining = [TimeSpan]::Zero }
        $cycleRate = if ($null -ne $summaryNow.Cycles.SuccessRate) { '{0:P1}' -f $summaryNow.Cycles.SuccessRate } else { '-' }
        $suiRate = if ($null -ne $summaryNow.Apis['Sui gRPC'].SuccessRate) { '{0:P1}' -f $summaryNow.Apis['Sui gRPC'].SuccessRate } else { '-' }
        $dbRate = if ($null -ne $summaryNow.Apis['DeepBook Indexer'].SuccessRate) { '{0:P1}' -f $summaryNow.Apis['DeepBook Indexer'].SuccessRate } else { '-' }
        Write-Log ("Remaining {0} | cycles {1} ({2}/{3}) | Sui gRPC {4} | DeepBook {5} | samples {6} | incidents {7}" -f $remaining.ToString('hh\:mm\:ss'), $cycleRate, $summaryNow.Cycles.Successes, $summaryNow.Cycles.Count, $suiRate, $dbRate, $summaryNow.Samples, $script:Incidents.Count)
        if ($abort) {
            $reason = $abort
            Add-Incident -Reason $abort -Detail 'Stop condition fired during monitoring.'
            break
        }
        if ($null -eq $inspNow) {
            $reason = 'CONTAINER_INSPECT_FAILED'
            Add-Incident -Reason $reason -Detail 'docker inspect failed during monitoring.'
            break
        }
    }

    # ------------------------------------------------------------ finalize
    $script:State.Reason = $reason
    $exitCode = 0
    if ($reason -ne 'COMPLETED' -and $reason -ne 'USER_STOPPED') { $exitCode = 2 }
    Finalize-SuiBaRun -Reason $reason -NodeVersion $nodeVersion -LatestMetrics $latestMetrics -MaxMemory $maxMemory -AllRows $allRows
    Write-Log "Done. Reason: $reason. Reports: $(Join-Path $script:RunDir 'reports')"
    exit $exitCode
} catch {
    $message = $_.Exception.Message
    Write-Host (Get-SuiBaFriendlyError (Protect-SuiBaText $message @($script:SecretValue)))
    if ($script:State -and $script:State.ContainerId -and -not $script:Finalized) {
        Add-Incident -Reason 'FATAL' -Detail $message
        $script:State.Reason = 'FATAL'
        try { Stop-DedicatedProject -Why 'fatal error' } catch { }
        $script:State.Status = 'Failed'
        Save-State
    }
    if ($script:State) {
        $script:State.Status = 'Failed'
        Save-State
    }
    exit 1
} finally {
    if ($script:OwnsMutex) { $script:RunMutex.ReleaseMutex() }
    if ($script:RunMutex) { $script:RunMutex.Dispose() }
}

