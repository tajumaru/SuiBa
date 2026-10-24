# Test double for the docker CLI, used only by Invoke-SelfTest.ps1.
# It mimics the exact subcommands Invoke-SuiBaVerification.ps1 calls and
# records every invocation to $env:SUIBA_WINVERIFY_STUB_HOME/calls.log.
# It never touches a real Docker engine. Failures are signalled by
# throwing (the caller treats a throw like a non-zero exit).
$home2 = $env:SUIBA_WINVERIFY_STUB_HOME
$fixtures = $env:SUIBA_WINVERIFY_STUB_FIXTURES
$scenario = if ($env:SUIBA_WINVERIFY_STUB_SCENARIO) { $env:SUIBA_WINVERIFY_STUB_SCENARIO } else { 'happy' }
$joined = $args -join ' '
if ($home2) {
    if (-not (Test-Path $home2)) { New-Item -ItemType Directory -Path $home2 -Force | Out-Null }
    Add-Content -Path (Join-Path $home2 'calls.log') -Value $joined -Encoding UTF8
}
$stateFile = Join-Path $home2 'stub-state.json'
$stubState = [pscustomobject]@{ running = $false }
if (Test-Path $stateFile) { $stubState = (Get-Content $stateFile -Raw) | ConvertFrom-Json }
function Save-StubState { [IO.File]::WriteAllText($stateFile, ($stubState | ConvertTo-Json), [Text.UTF8Encoding]::new($false)) }
function Set-StubProp {
    param([string]$Name, $Value)
    if ($stubState.PSObject.Properties[$Name]) { $stubState.$Name = $Value }
    else { $stubState | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

$imageId = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
$containerId = 'stubcontainerid0001'
$project = $env:SUIBA_PREFLIGHT_PROJECT
if (-not $project) { $project = 'suiba-stub' }

if ($joined -match '^(down|.*\bprune\b|.*volume rm|.*\bkill\b)') { throw "FORBIDDEN COMMAND RECORDED: $joined" }

switch -Regex ($joined) {
    '^exec' { Write-Output '{"event":"NODE_VERSION_VERIFIED","version":"v24.22.1","execPath":"/usr/local/bin/node"}'; break }
    '^version' { if ($scenario -eq 'docker-down') { throw 'Docker engine unavailable (stub)' }; Write-Output '27.3.1'; break }
    '^compose .* version' { Write-Output 'Docker Compose version v2.29.0'; break }
    '^compose .* config' { break }
    '^compose .* up' { Set-StubProp 'running' $true; Save-StubState; break }
    '^compose .* ps' { Write-Output $containerId; break }
    '^compose .* exec' {
        $auditText = [IO.File]::ReadAllText((Join-Path $fixtures 'audit.json'))
        $prefix = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString().Substring(0, 8)
        Write-Output ($auditText -replace '10000000', $prefix)
        break
    }
    '^compose .* stop' { Set-StubProp 'running' $false; Save-StubState; break }
    '^build' { Set-StubProp 'imageBuilt' $true; Save-StubState; Write-Output 'stub build ok'; break }
    '^image inspect' { if ($stubState.imageBuilt) { Write-Output $imageId } else { throw 'No such image (stub)' }; break }
    '^run .*summarize-preflight' {
        foreach ($a in $args) {
            if ($a -match '^(.*):/out$') {
                [IO.File]::WriteAllText((Join-Path $Matches[1] 'preflight-summary.json'), '{"verdict":"INCONCLUSIVE"}', [Text.UTF8Encoding]::new($false))
            }
        }
        Write-Output '{"verdict":"INCONCLUSIVE"}'
        break
    }
    '^run' {
        if ($joined -match '--version') {
            if ($scenario -eq 'node-mismatch') { Write-Output 'v24.14.0' }
            else { Write-Output 'v24.22.1' }
        }
        else { Write-Output '{"event":"NODE_VERSION_VERIFIED","version":"v24.22.1","execPath":"/usr/local/bin/node","platform":"linux","arch":"x64"}' }
    }
    '^inspect' {
        $obj = @([ordered]@{
            Id = $containerId; Image = $imageId; RestartCount = 0
            State = @{ Status = $(if ($stubState.running) { 'running' } else { 'exited' }); Running = [bool]$stubState.running; OOMKilled = $false; ExitCode = 0; Health = @{ Status = 'healthy' } }
            Config = @{ Labels = @{ 'com.docker.compose.project' = $project } }
            Mounts = @(
                @{ Type = 'volume'; Name = "${project}_preflight-data"; Destination = '/app/validation' },
                @{ Type = 'volume'; Name = "${project}_preflight-reports"; Destination = '/app/reports' }
            )
        })
        Write-Output ($obj | ConvertTo-Json -Depth 6 -Compress)
    }
    '^cp' {
        $src = $args[1]; $dest = $args[2]
        if ($scenario -eq 'userstop') {
            $evidenceDir = if (Test-Path -LiteralPath $dest -PathType Container) { $dest } else { Split-Path -Parent $dest }
            [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $evidenceDir) 'STOP_REQUEST'), 'stub user stop')
        }
        $fixtureName = if ($scenario -eq 'safety') { 'evidence-safety.jsonl' } else { 'evidence-happy.jsonl' }
        $text = [IO.File]::ReadAllText((Join-Path $fixtures $fixtureName))
        $prefix = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).ToString().Substring(0, 8)
        $text = $text -replace '10000000', $prefix
        if ($src -like '*:/app/reports/.') {
            [IO.File]::WriteAllText((Join-Path $dest 'preflight-evidence.jsonl'), $text, [Text.UTF8Encoding]::new($false))
            if ($scenario -eq 'happy') {
                foreach ($pair in @(@('perf-sqlite-timing.jsonl', 'sqlite-timing.jsonl'), @('perf-event-loop-spikes.jsonl', 'event-loop-spikes.jsonl'))) {
                    $perfText = [IO.File]::ReadAllText((Join-Path $fixtures $pair[0]))
                    $perfText = $perfText -replace '10000000', $prefix
                    [IO.File]::WriteAllText((Join-Path $dest $pair[1]), $perfText, [Text.UTF8Encoding]::new($false))
                }
            }
        } else {
            [IO.File]::WriteAllText($dest, $text, [Text.UTF8Encoding]::new($false))
        }
    }
    '^logs' {
        $m = '{"event":"PREFLIGHT_PASSIVE_METRICS","scope":"CUMULATIVE","at":1000000000000,"eventLoop":{"count":1000,"p50Ms":10.1,"p95Ms":10.4,"maxMs":20.5},"sqlite":{"append":{"count":10,"p50Ms":50,"p95Ms":70,"maxMs":90,"failures":0},"set":{"count":30,"p50Ms":55,"p95Ms":80,"maxMs":100,"failures":0},"transaction":{"count":5,"p50Ms":60,"p95Ms":120,"maxMs":150,"failures":0}},"sqliteBusy":0,"sqliteLocked":0}'
        Write-Output "2026-10-24T00:00:00.000000000Z $m"
        if ($scenario -eq 'happy') {
            $pd = '{"event":"PREFLIGHT_PERF_DETAIL_STATUS","enabled":true,"startedAt":1000000000000,"endedAt":1000000100000,"eventLoopThresholdMs":500,"spikesDetected":1,"sinkErrors":0,"eventLoopCumulative":{"count":6000,"p50Ms":20.1,"p95Ms":100.2,"p99Ms":1400.0,"maxMs":1450.5},"sqliteWriter":{"file":"sqlite-timing.jsonl","written":4,"dropped":0,"bytesWritten":1200,"flushCount":2,"flushFailures":0,"flushTotalMs":55.0,"flushMaxMs":50.0,"truncated":false,"queued":0},"spikeWriter":{"file":"event-loop-spikes.jsonl","written":2,"dropped":0,"bytesWritten":600,"flushCount":1,"flushFailures":0,"flushTotalMs":3.0,"flushMaxMs":3.0,"truncated":false,"queued":0}}'
            Write-Output "2026-10-24T00:00:01.000000000Z $pd"
        }
    }
    '^stats' { Write-Output '120MiB / 7.50GiB'; break }
    '^stop' { Set-StubProp 'running' $false; Save-StubState; break }
    default { }
}
$global:LASTEXITCODE = 0
