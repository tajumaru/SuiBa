# SuiBa Windows unattended verification - shared pure functions.
# Dot-sourced by Invoke-SuiBaVerification.ps1, Stop/Watch scripts and the
# self-test. Keep this file free of side effects and external commands so
# it can be unit-tested with synthetic data only.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.

function Compare-SuiBaNodeVersion {
    # Mirrors scripts/verify-node-version.mjs: supported range >=24.22.1 <25.
    param([Parameter(Mandatory = $true)][string]$VersionText)
    $m = [regex]::Match($VersionText.Trim(), '^v?(\d+)\.(\d+)\.(\d+)$')
    if (-not $m.Success) { return $false }
    $major = [int]$m.Groups[1].Value
    $minor = [int]$m.Groups[2].Value
    $patch = [int]$m.Groups[3].Value
    if ($major -ne 24) { return $false }
    if ($minor -gt 22) { return $true }
    if ($minor -eq 22 -and $patch -ge 1) { return $true }
    return $false
}

function Get-SuiBaStats {
    # Same percentile definition as scripts/summarize-preflight.cjs stats().
    param([double[]]$Values)
    $a = @($Values | Where-Object { [double]::IsFinite($_) } | Sort-Object)
    $result = [pscustomobject]@{ N = $a.Count; P50 = $null; P95 = $null; Max = $null }
    if ($a.Count -gt 0) {
        $result.P50 = $a[[math]::Ceiling($a.Count * 0.5) - 1]
        $result.P95 = $a[[math]::Ceiling($a.Count * 0.95) - 1]
        $result.Max = $a[$a.Count - 1]
    }
    return $result
}

function ConvertFrom-SuiBaEvidenceLines {
    # Parses preflight-evidence.jsonl lines written by
    # scripts/preflight-observer.mjs. Bad lines are counted, never fatal.
    param([string[]]$Lines)
    $rows = New-Object System.Collections.ArrayList
    $bad = 0
    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $obj = $line | ConvertFrom-Json -ErrorAction Stop
            [void]$rows.Add($obj)
        } catch { $bad++ }
    }
    return [pscustomobject]@{ Rows = $rows; BadLines = $bad }
}

function Test-SuiBaApiTimeout {
    param($AttemptData)
    if ($null -eq $AttemptData) { return $false }
    $code = "$($AttemptData.code)"
    if ($code -match 'TIMEOUT|TIMED_OUT|DEADLINE') { return $true }
    $f = $AttemptData.failure
    if ($null -ne $f) {
        if ("$($f.timeoutType)" -ne '') { return $true }
        if ("$($f.code)" -match 'TIMEOUT|TIMED_OUT|DEADLINE') { return $true }
        if ("$($f.causeCode)" -match 'TIMEOUT|TIMED_OUT|DEADLINE') { return $true }
    }
    return $false
}

function Get-SuiBaSuccessSummary {
    # Aggregates observer evidence rows into success rates and freshness.
    param([Parameter(Mandatory = $true)]$Rows)
    $attempts = @($Rows | Where-Object { $_.kind -eq 'api' } | ForEach-Object { $_.data })
    $apis = [ordered]@{}
    foreach ($name in @('Sui gRPC', 'DeepBook Indexer')) {
        $a = @($attempts | Where-Object { $_.api -eq $name })
        $failed = @($a | Where-Object { -not $_.success })
        $apis[$name] = [pscustomobject]@{
            Attempts    = $a.Count
            Successes   = $a.Count - $failed.Count
            Failures    = $failed.Count
            SuccessRate = if ($a.Count -gt 0) { ($a.Count - $failed.Count) / $a.Count } else { $null }
            Retries     = @($a | Where-Object { $_.attempt -gt 0 }).Count
            Timeouts    = @($failed | Where-Object { Test-SuiBaApiTimeout $_ }).Count
            LatencyMs   = Get-SuiBaStats -Values @($a | ForEach-Object { [double]$_.latencyMs })
        }
    }
    $cycles = @($Rows | Where-Object { $_.kind -eq 'cycle' })
    $okCycles = @($cycles | Where-Object { -not $_.error })
    $samples = @($Rows | Where-Object { $_.kind -eq 'sample' })
    $bookAges = @($okCycles | Where-Object { $null -ne $_.market.bookAt } | ForEach-Object { [double]($_.at - $_.market.bookAt) })
    $lags = @($okCycles | Where-Object { $null -ne $_.market.diagnostics.indexerLagMs } | ForEach-Object { [double]$_.market.diagnostics.indexerLagMs })
    return [pscustomobject]@{
        Apis = $apis
        Cycles = [pscustomobject]@{
            Count       = $cycles.Count
            Successes   = $okCycles.Count
            Failures    = $cycles.Count - $okCycles.Count
            SuccessRate = if ($cycles.Count -gt 0) { $okCycles.Count / $cycles.Count } else { $null }
            LatencyMs   = Get-SuiBaStats -Values @($cycles | ForEach-Object { [double]$_.durationMs })
        }
        Samples        = $samples.Count
        BookAgeMs      = Get-SuiBaStats -Values $bookAges
        IndexerLagMs   = Get-SuiBaStats -Values $lags
        FirstSampleAt  = if ($samples.Count) { [long]$samples[0].at } else { $null }
        LastSampleAt   = if ($samples.Count) { [long]$samples[$samples.Count - 1].at } else { $null }
        LastCycleAt    = if ($cycles.Count) { [long]$cycles[$cycles.Count - 1].at } else { $null }
    }
}

function Get-SuiBaEvidenceFacts {
    # Safety/monitoring facts derived from evidence rows, used both for the
    # live abort evaluation and for the final report.
    param([Parameter(Mandatory = $true)]$Rows)
    $samples = @($Rows | Where-Object { $_.kind -eq 'sample' })
    $cycles = @($Rows | Where-Object { $_.kind -eq 'cycle' })
    $facts = [pscustomobject]@{
        SampleCount            = $samples.Count
        RunningTrueSeen        = $false
        NonzeroOrdersSeen      = $false
        SessionSeen            = $false
        IntegrityFaultSeen     = $false
        IntegrityBadSeen       = $false
        MaxSampleGapSec        = 0.0
        LastSampleAgeSec       = $null
        ConsecutiveFailedCycles = 0
        LastSuccessCycleAgeSec = $null
        BuildVariantCount      = 0
    }
    $builds = @{}
    $prevAt = $null
    foreach ($s in $samples) {
        if ($s.runtime -and $s.runtime.running) { $facts.RunningTrueSeen = $true }
        if ($s.counts) {
            foreach ($k in @('paper_orders', 'paper_trades', 'paper_checks', 'operation_candidates')) {
                if ($s.counts.$k -ne 0 -and $null -ne $s.counts.$k) { $facts.NonzeroOrdersSeen = $true }
            }
        }
        if ($null -ne $s.validationSession) { $facts.SessionSeen = $true }
        if ($null -ne $s.integrityFault) { $facts.IntegrityFaultSeen = $true }
        if ($s.integrity) {
            foreach ($row in @($s.integrity)) {
                if ($row.integrity_check -ne 'ok') { $facts.IntegrityBadSeen = $true }
            }
        }
        if ($s.build) { $builds[($s.build | ConvertTo-Json -Compress)] = $true }
        if ($null -ne $prevAt) {
            $gap = ([long]$s.at - $prevAt) / 1000.0
            if ($gap -gt $facts.MaxSampleGapSec) { $facts.MaxSampleGapSec = $gap }
        }
        $prevAt = [long]$s.at
    }
    $facts.BuildVariantCount = $builds.Count
    $run = 0
    foreach ($c in $cycles) {
        if ($c.error) { $run++ } else { $run = 0 }
    }
    $facts.ConsecutiveFailedCycles = $run
    if ($samples.Count -gt 0) {
        $facts.LastSampleAgeSec = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$samples[$samples.Count - 1].at) / 1000.0
    }
    $okCycles = @($cycles | Where-Object { -not $_.error })
    if ($okCycles.Count -gt 0) {
        $facts.LastSuccessCycleAgeSec = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$okCycles[$okCycles.Count - 1].at) / 1000.0
    }
    return $facts
}

function Test-SuiBaAbortCondition {
    # Stop conditions preserved from docs/NODE_DOCKER_30M_PREFLIGHT.md and
    # docs/PREFLIGHT_30M_20261024.md: safety violations, DB/evidence faults,
    # 3 consecutive failed cycles, no successful cycle for 5 minutes,
    # disk thresholds, monitor blindness, unexpected container state.
    # Returns a reason string, or $null when the run may continue.
    param([Parameter(Mandatory = $true)]$State)
    if ($State.RunningTrueSeen) { return 'SAFETY_RUNNING_TRUE' }
    if ($State.NonzeroOrdersSeen) { return 'SAFETY_NONZERO_ORDERS' }
    if ($State.SessionSeen) { return 'SAFETY_VALIDATION_SESSION' }
    if ($State.IntegrityFaultSeen -or $State.IntegrityBadSeen) { return 'DB_INTEGRITY_FAULT' }
    if ($State.SqliteBusy -gt 0 -or $State.SqliteLocked -gt 0 -or $State.SqliteFailures -gt 0) { return 'DB_SQLITE_FAULT' }
    if ($State.OOMKilled) { return 'CONTAINER_OOMKILLED' }
    if ($State.RestartCount -gt 0) { return 'CONTAINER_RESTARTED' }
    if (-not $State.ContainerRunning) { return 'CONTAINER_EXITED' }
    if ($State.BuildVariantCount -gt 1) { return 'BUILD_MISMATCH' }
    if ($State.ConsecutiveFailedCycles -ge 3) { return 'CYCLES_FAILED_3_CONSECUTIVE' }
    if ($State.HasSuccessfulCycleHistory -and $null -ne $State.LastSuccessCycleAgeSec -and $State.LastSuccessCycleAgeSec -gt 300) { return 'NO_SUCCESSFUL_CYCLE_5MIN' }
    if ($State.SampleCount -gt 0 -and $State.MaxSampleGapSec -gt 90) { return 'EVIDENCE_STALE' }
    if ($State.SampleCount -eq 0 -and $State.ElapsedSec -gt 240) { return 'EVIDENCE_MISSING' }
    if ($State.UnhealthyStreak -ge 3) { return 'CONTAINER_UNHEALTHY' }
    if ($State.MonitorCopyFailStreak -ge 3) { return 'MONITOR_COPY_FAILED' }
    if ($State.DiskAbort) { return "DISK_THRESHOLD:$($State.DiskAbortReason)" }
    return $null
}

function ConvertTo-SuiBaNormalizedWindowsPath {
    # Canonical form used before extracting a drive root from evidence
    # supplied by Docker, the WSL registry, Docker Desktop settings or
    # the file system. Only an absolute drive-letter path is evidence:
    #   * forward slashes become backslashes,
    #   * Win32 device prefixes (\\?\, \\.\) and the NT prefix (\??\)
    #     are removed,
    #   * UNC paths (including \\?\UNC\...) have no drive letter and
    #     therefore return $null,
    #   * POSIX paths, relative paths and drive-relative paths such as
    #     "D:folder" also return $null.
    # The return value is the normalized full path, or $null when the
    # input cannot identify a host drive.
    param([AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $normalized = $Path.Trim()
    if ($normalized.Length -ge 2 -and $normalized.StartsWith('"') -and $normalized.EndsWith('"')) {
        $normalized = $normalized.Substring(1, $normalized.Length - 2).Trim()
    }
    $normalized = $normalized.Replace('/', '\')
    foreach ($uncPrefix in @('\\?\UNC\', '\\.\UNC\', '\??\UNC\')) {
        if ($normalized.StartsWith($uncPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    }
    foreach ($devicePrefix in @('\\?\', '\\.\', '\??\')) {
        if ($normalized.StartsWith($devicePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $normalized = $normalized.Substring($devicePrefix.Length)
            break
        }
    }
    if ($normalized.StartsWith('\\')) { return $null }
    if ($normalized -notmatch '^[A-Za-z]:\\') { return $null }
    $drive = $normalized.Substring(0, 1).ToUpperInvariant()
    $rest = '\' + $normalized.Substring(2).TrimStart('\')
    return ($drive + ':' + $rest)
}

function Get-SuiBaDriveRoot {
    # Returns the canonical root (for example 'D:\') of an absolute
    # Windows path after ConvertTo-SuiBaNormalizedWindowsPath, or $null
    # when the path does not identify a host drive.
    param([AllowEmptyString()][string]$Path)
    $normalized = ConvertTo-SuiBaNormalizedWindowsPath $Path
    if ($null -eq $normalized) { return $null }
    return $normalized.Substring(0, 3).ToUpperInvariant()
}

function Get-SuiBaComposeProjectName {
    # Docker Compose project names may contain only lowercase letters,
    # digits, hyphens and underscores, and must start with a letter or
    # digit (^[a-z0-9][a-z0-9_-]*$). A run ID embeds a UTC timestamp
    # whose literal 'T' and 'Z' are uppercase (for example
    # 'winverify-20261024T080741Z-b8f4467'), so used verbatim as a
    # project name it is rejected by Compose. The project name is
    # therefore the lowercased run ID behind the 'suiba-' prefix. The
    # run ID itself keeps its original case: it is only a folder name
    # and an image tag, where uppercase is valid. Normalization
    # happens exactly once, at generation; the result is stored in
    # state and every later reference (compose -p, container labels,
    # volume prefixes, Stop/Watch) reads the stored value.
    param([Parameter(Mandatory = $true)][string]$RunId)
    return ('suiba-' + $RunId.ToLowerInvariant())
}

function Test-SuiBaComposeProjectName {
    # Case-sensitive on purpose: PowerShell's -match is case-insensitive
    # and would wave an uppercase name through, so -cmatch guards the
    # exact Compose rule ^[a-z0-9][a-z0-9_-]*$.
    param([AllowEmptyString()][string]$Name)
    if ([string]::IsNullOrEmpty($Name)) { return $false }
    return ($Name -cmatch '^[a-z0-9][a-z0-9_-]*$')
}

function Test-SuiBaDockerDataSettingName {
    # Docker Desktop has used several names for the disk-image/data
    # location across versions. Accept the known stems case-insensitively
    # anywhere in a setting name; the caller separately requires the
    # value to be a string containing an absolute Windows path.
    param([AllowEmptyString()][string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    return ($Name -match '(?i)(datafolder|diskimage|wsldisk|wsldatafolder|dockerdatafolder)')
}

function Get-SuiBaDockerDataDriveRootsFromSettings {
    # Recursively walks a parsed Docker Desktop settings document
    # (objects, arrays and dictionaries, up to depth 32) and returns the
    # sorted drive roots named by string values of data-folder-like
    # settings. Keeping this independent of file I/O makes nested
    # layouts such as wslDistros.<distro>.dataFolder unit-testable.
    param([AllowNull()]$Settings)
    $roots = @{}
    $pending = New-Object System.Collections.ArrayList
    [void]$pending.Add([pscustomobject]@{ Node = $Settings; Key = ''; Depth = 0 })
    $visited = 0
    while ($pending.Count -gt 0 -and $visited -lt 10000) {
        $last = $pending.Count - 1
        $item = $pending[$last]
        $pending.RemoveAt($last)
        $visited++
        if ($null -eq $item.Node -or $item.Depth -gt 32) { continue }
        $node = $item.Node
        if ($node -is [string]) {
            if (Test-SuiBaDockerDataSettingName ([string]$item.Key)) {
                $root = Get-SuiBaDriveRoot ([string]$node)
                if ($root) { $roots[$root] = $true }
            }
            continue
        }
        if ($node -is [System.Collections.IDictionary]) {
            foreach ($key in @($node.Keys)) {
                [void]$pending.Add([pscustomobject]@{ Node = $node[$key]; Key = [string]$key; Depth = ($item.Depth + 1) })
            }
            continue
        }
        if ($node -is [System.Collections.IEnumerable]) {
            foreach ($child in $node) {
                [void]$pending.Add([pscustomobject]@{ Node = $child; Key = [string]$item.Key; Depth = ($item.Depth + 1) })
            }
            continue
        }
        foreach ($prop in @($node.PSObject.Properties)) {
            [void]$pending.Add([pscustomobject]@{ Node = $prop.Value; Key = [string]$prop.Name; Depth = ($item.Depth + 1) })
        }
    }
    return @($roots.Keys | Sort-Object)
}

function Get-SuiBaDockerDataDriveRootsFromEvidence {
    # Aggregates raw Docker-data evidence without performing I/O. The
    # caller supplies the DockerRootDir string, matching WSL registry
    # BasePath values, parsed settings documents and existing vhdx
    # paths; every value passes through the same path normalization.
    # Returns sorted drive roots, or $null when no source identifies a
    # host drive (the caller must fail closed in that case).
    param(
        [AllowEmptyString()][string]$DockerRootDir = '',
        [AllowEmptyCollection()][string[]]$RegistryBasePaths = @(),
        [AllowEmptyCollection()][object[]]$SettingsDocuments = @(),
        [AllowEmptyCollection()][string[]]$ExistingVhdxPaths = @()
    )
    $roots = @{}
    foreach ($candidate in @($DockerRootDir) + @($RegistryBasePaths) + @($ExistingVhdxPaths)) {
        $root = Get-SuiBaDriveRoot ([string]$candidate)
        if ($root) { $roots[$root] = $true }
    }
    foreach ($document in $SettingsDocuments) {
        foreach ($root in @(Get-SuiBaDockerDataDriveRootsFromSettings $document)) {
            $roots[$root] = $true
        }
    }
    if ($roots.Count -eq 0) { return $null }
    return @($roots.Keys | Sort-Object)
}

function Test-SuiBaDiskStopCondition {
    # Disk stop conditions, reconciled with the 30-minute validation
    # agreement (docs/PREFLIGHT_30M_20261024.md section 14: "D80% /
    # C free 10 GiB", i.e. the two numbers judge DIFFERENT drives):
    #   * the drive that holds Docker's data (the Docker Desktop disk
    #     image) stops the run at >= 80% used,
    #   * the system drive, the output drive (runs/: logs, reports,
    #     evidence, secret, compose override) and the temp drive stop
    #     the run at < 10 GiB free; their used percentage is NOT judged,
    #   * if the Docker data location cannot be determined, or no disk
    #     facts were collected at all, the run stops (fail-closed):
    #     an unjudgeable disk state never starts or continues a run.
    # $Drives entries: Name (e.g. 'C:\'), Roles (string[]; any of
    # 'System', 'DockerData', 'Output', 'Temp'), UsedPct, FreeGiB.
    # Pure function: the caller collects the facts; this function only
    # judges them, so it is unit-testable with synthetic values.
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()]$Drives,
        [Parameter(Mandatory = $true)][bool]$DockerDataDetermined
    )
    $result = [pscustomobject]@{ Abort = $false; Reason = ''; Checks = @() }
    $list = @($Drives)
    if ($list.Count -eq 0) {
        $result.Abort = $true
        $result.Reason = 'disk facts unavailable (fail-closed)'
        return $result
    }
    foreach ($d in $list) {
        $result.Checks += "$($d.Name) roles=$($d.Roles -join '+') used=$([math]::Round([double]$d.UsedPct, 1))% freeGiB=$([math]::Round([double]$d.FreeGiB, 2))"
    }
    if (-not $DockerDataDetermined) {
        $result.Abort = $true
        $result.Reason = 'docker data location could not be determined (fail-closed)'
        return $result
    }
    foreach ($d in $list) {
        if ($d.Roles -contains 'DockerData' -and [double]$d.UsedPct -ge 80) {
            $result.Abort = $true
            $result.Reason = "docker data drive $($d.Name) used $([math]::Round([double]$d.UsedPct, 1))% >= 80%"
            return $result
        }
    }
    foreach ($d in $list) {
        $freeRoles = @($d.Roles | Where-Object { $_ -in @('System', 'Output', 'Temp') })
        if ($freeRoles.Count -gt 0 -and [double]$d.FreeGiB -lt 10) {
            $result.Abort = $true
            $result.Reason = "$($freeRoles[0].ToLower()) drive $($d.Name) free $([math]::Round([double]$d.FreeGiB, 2)) GiB < 10 GiB"
            return $result
        }
    }
    return $result
}

function Protect-SuiBaText {
    # Last-resort scrub so secret values can never reach a report file,
    # even if a log line quoted them.
    param([string]$Text, [string[]]$Forbidden)
    $out = $Text
    foreach ($f in $Forbidden) {
        if (-not [string]::IsNullOrEmpty($f)) { $out = $out.Replace($f, '***') }
    }
    return $out
}

function ConvertTo-SuiBaCsvField {
    param($Value)
    if ($null -eq $Value) { return '' }
    $s = "$Value"
    if ($s -match '[",\r\n]') { return '"' + $s.Replace('"', '""') + '"' }
    return $s
}

function New-SuiBaReportFiles {
    # Writes report.json / report.md / events.csv / samples.csv.
    # Only whitelisted, already-parsed data reaches this function.
    param(
        [Parameter(Mandatory = $true)]$Meta,
        [Parameter(Mandatory = $true)]$Summary,
        [Parameter(Mandatory = $true)]$Facts,
        [Parameter(Mandatory = $true)]$Rows,
        [Parameter(Mandatory = $true)]$Incidents,
        [Parameter(Mandatory = $true)][string]$OutDir,
        [string[]]$Forbidden = @()
    )
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $report = [ordered]@{
        tool = 'SuiBa Windows unattended verification'
        runId = $Meta.RunId
        project = $Meta.Project
        sha = $Meta.Sha
        imageId = $Meta.ImageId
        nodeVersion = $Meta.NodeVersion
        durationMinutesPlanned = $Meta.DurationMinutes
        startedAtUtc = $Meta.StartedAtUtc
        endedAtUtc = $Meta.EndedAtUtc
        reason = $Meta.Reason
        containerExitCode = $Meta.ContainerExitCode
        containerOOMKilled = $Meta.ContainerOOMKilled
        maxMemoryBytes = $Meta.MaxMemoryBytes
        passiveMetrics = $Meta.PassiveMetrics
        preflightSummaryVerdict = $Meta.PreflightSummaryVerdict
        summary = $Summary
        facts = $Facts
        incidents = $Incidents
    }
    $json = $report | ConvertTo-Json -Depth 9
    [IO.File]::WriteAllText((Join-Path $OutDir 'report.json'), (Protect-SuiBaText $json $Forbidden), [Text.UTF8Encoding]::new($false))

    # events.csv: incidents + failed API attempts + failed cycles.
    $csvLines = New-Object System.Collections.ArrayList
    [void]$csvLines.Add('atUtc,kind,apiOrScope,codeOrError,latencyMs,detail')
    foreach ($i in $Incidents) {
        [void]$csvLines.Add((@($i.AtUtc, 'incident', '', $i.Reason, '', $i.Detail) | ForEach-Object { ConvertTo-SuiBaCsvField $_ }) -join ',')
    }
    foreach ($r in @($Rows | Where-Object { $_.kind -eq 'api' -and -not $_.data.success })) {
        $iso = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$r.at).UtcDateTime.ToString('o')
        [void]$csvLines.Add((@($iso, 'api_failure', $r.data.api, $r.data.code, $r.data.latencyMs, "$($r.data.failure.phase)") | ForEach-Object { ConvertTo-SuiBaCsvField $_ }) -join ',')
    }
    foreach ($r in @($Rows | Where-Object { $_.kind -eq 'cycle' -and $_.error })) {
        $iso = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$r.at).UtcDateTime.ToString('o')
        [void]$csvLines.Add((@($iso, 'cycle_failure', 'market-cycle', $r.error, $r.durationMs, '') | ForEach-Object { ConvertTo-SuiBaCsvField $_ }) -join ',')
    }
    [IO.File]::WriteAllText((Join-Path $OutDir 'events.csv'), (Protect-SuiBaText ($csvLines -join "`r`n") $Forbidden), [Text.UTF8Encoding]::new($false))

    # samples.csv: one row per observer sample.
    $sampleLines = New-Object System.Collections.ArrayList
    [void]$sampleLines.Add('atUtc,running,paperOrders,paperTrades,integrityFault,marketHealthy,marketLatencyMs')
    foreach ($s in @($Rows | Where-Object { $_.kind -eq 'sample' })) {
        $iso = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$s.at).UtcDateTime.ToString('o')
        [void]$sampleLines.Add((@($iso, $s.runtime.running, $s.counts.paper_orders, $s.counts.paper_trades, [bool]$s.integrityFault, $s.market.healthy, $s.market.latencyMs) | ForEach-Object { ConvertTo-SuiBaCsvField $_ }) -join ',')
    }
    [IO.File]::WriteAllText((Join-Path $OutDir 'samples.csv'), (Protect-SuiBaText ($sampleLines -join "`r`n") $Forbidden), [Text.UTF8Encoding]::new($false))

    $md = New-Object Text.StringBuilder
    [void]$md.AppendLine('# SuiBa Windows無人検証レポート')
    [void]$md.AppendLine('')
    [void]$md.AppendLine("- Run ID: $($Meta.RunId)")
    [void]$md.AppendLine("- Docker project: $($Meta.Project)")
    [void]$md.AppendLine("- 対象SHA: $($Meta.Sha)")
    [void]$md.AppendLine("- Image ID: $($Meta.ImageId)")
    [void]$md.AppendLine("- コンテナ内Node: $($Meta.NodeVersion)（要求 >=24.22.1 <25）")
    [void]$md.AppendLine("- 予定時間: $($Meta.DurationMinutes) 分")
    [void]$md.AppendLine("- 開始(UTC): $($Meta.StartedAtUtc)")
    [void]$md.AppendLine("- 終了(UTC): $($Meta.EndedAtUtc)")
    [void]$md.AppendLine("- 終了理由: $($Meta.Reason)")
    [void]$md.AppendLine("- コンテナ終了コード: $($Meta.ContainerExitCode) / OOMKilled: $($Meta.ContainerOOMKilled)")
    [void]$md.AppendLine('')
    [void]$md.AppendLine('## 通信・市場サマリ')
    [void]$md.AppendLine('')
    [void]$md.AppendLine('| 対象 | 試行 | 成功 | 失敗 | 成功率 | retry | timeout | latency P50/P95/最大(ms) |')
    [void]$md.AppendLine('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
    foreach ($name in @('Sui gRPC', 'DeepBook Indexer')) {
        $a = $Summary.Apis[$name]
        $rate = if ($null -ne $a.SuccessRate) { '{0:P2}' -f $a.SuccessRate } else { '-' }
        [void]$md.AppendLine("| $name | $($a.Attempts) | $($a.Successes) | $($a.Failures) | $rate | $($a.Retries) | $($a.Timeouts) | $($a.LatencyMs.P50) / $($a.LatencyMs.P95) / $($a.LatencyMs.Max) |")
    }
    $crate = if ($null -ne $Summary.Cycles.SuccessRate) { '{0:P2}' -f $Summary.Cycles.SuccessRate } else { '-' }
    [void]$md.AppendLine('')
    [void]$md.AppendLine("- 市場サイクル: $($Summary.Cycles.Count) 回（成功 $($Summary.Cycles.Successes) / 失敗 $($Summary.Cycles.Failures)、成功率 $crate、所要 P50/P95/最大 = $($Summary.Cycles.LatencyMs.P50) / $($Summary.Cycles.LatencyMs.P95) / $($Summary.Cycles.LatencyMs.Max) ms）")
    [void]$md.AppendLine("- 板の鮮度（取得完了時 book age）: P50/P95/最大 = $($Summary.BookAgeMs.P50) / $($Summary.BookAgeMs.P95) / $($Summary.BookAgeMs.Max) ms")
    [void]$md.AppendLine("- Indexer lag: 最大 $($Summary.IndexerLagMs.Max) ms")
    [void]$md.AppendLine("- サンプル数: $($Summary.Samples)")
    if ($Meta.PassiveMetrics) {
        $pm = $Meta.PassiveMetrics
        [void]$md.AppendLine("- イベントループ遅延（累積）: P50/P95/最大 = $($pm.eventLoop.p50Ms) / $($pm.eventLoop.p95Ms) / $($pm.eventLoop.maxMs) ms")
        [void]$md.AppendLine("- SQLite（累積）: append P95 $($pm.sqlite.append.p95Ms) ms / set P95 $($pm.sqlite.set.p95Ms) ms / transaction P95 $($pm.sqlite.transaction.p95Ms) ms、失敗 append $($pm.sqlite.append.failures) / set $($pm.sqlite.set.failures) / transaction $($pm.sqlite.transaction.failures)、BUSY $($pm.sqliteBusy) / LOCKED $($pm.sqliteLocked)")
    }
    if ($Meta.MaxMemoryBytes) { [void]$md.AppendLine("- コンテナメモリ最大: $($Meta.MaxMemoryBytes) bytes（docker stats 実測）") }
    [void]$md.AppendLine('')
    [void]$md.AppendLine('## 安全性')
    [void]$md.AppendLine('')
    [void]$md.AppendLine("- running=true のサンプル: $(if ($Facts.RunningTrueSeen) { 'あり（安全違反）' } else { 'なし' })")
    [void]$md.AppendLine("- 注文・約定等の非ゼロ: $(if ($Facts.NonzeroOrdersSeen) { 'あり（安全違反）' } else { 'なし' })")
    [void]$md.AppendLine("- validation session: $(if ($Facts.SessionSeen) { 'あり（安全違反）' } else { 'なし' })")
    [void]$md.AppendLine("- DB整合性 fault: $(if ($Facts.IntegrityFaultSeen -or $Facts.IntegrityBadSeen) { 'あり' } else { 'なし' })")
    [void]$md.AppendLine('- 停止したのは検証専用 project のコンテナだけです。既存コンテナ・DB・volume には触れていません。')
    [void]$md.AppendLine("- 既存集計（summarize-preflight）の verdict: $($Meta.PreflightSummaryVerdict)")
    [void]$md.AppendLine('')
    [void]$md.AppendLine('## インシデント')
    [void]$md.AppendLine('')
    if ($Incidents.Count -eq 0) { [void]$md.AppendLine('記録されたインシデントはありません。') }
    foreach ($i in $Incidents) { [void]$md.AppendLine("- $($i.AtUtc) : $($i.Reason) $($i.Detail)") }
    [void]$md.AppendLine('')
    [void]$md.AppendLine('※ 成功率は観測窓内の実試行だけを分母にしています（cache hit は含みません）。認証情報・secret の値はこのレポートに含まれません。')
    [IO.File]::WriteAllText((Join-Path $OutDir 'report.md'), (Protect-SuiBaText $md.ToString() $Forbidden), [Text.UTF8Encoding]::new($false))
}
