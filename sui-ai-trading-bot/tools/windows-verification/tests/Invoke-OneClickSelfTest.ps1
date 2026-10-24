# Pure UI/report tests: no Docker engine, RPC or trading.
$ErrorActionPreference = 'Stop'
$tool = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $tool 'lib/Verification.Common.ps1')
. (Join-Path $tool 'lib/Verification.OneClick.ps1')
$failed = 0
function Assert($Name, $Condition) {
    if ($Condition) { Write-Host "PASS: $Name" } else { Write-Host "FAIL: $Name"; $script:failed++ }
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('suiba-oneclick-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Assert 'Enter selects 30 minute menu item' ((Read-SuiBaMenuChoice -ReadInput { '' }) -eq '1')
    foreach ($n in 1..7) {
        $read = { "$n" }.GetNewClosure()
        Assert "menu item $n accepted" ((Read-SuiBaMenuChoice -ReadInput $read) -eq "$n")
    }
    Assert '30m needs no long-run confirmation' (Confirm-SuiBaLongRun -Minutes 30 -ReadInput { throw 'Must not ask' })
    Assert '6h declines without START' (-not (Confirm-SuiBaLongRun -Minutes 360 -ReadInput { '' }))
    Assert '24h explicit START accepted' (Confirm-SuiBaLongRun -Minutes 1440 -ReadInput { 'START' })
    $rejected = $false
    try { Confirm-SuiBaLongRun -Minutes 360 -NonInteractive | Out-Null } catch { $rejected = $true }
    Assert 'unconfirmed noninteractive long run rejected' $rejected
    Assert 'explicit noninteractive long run allowed' (Confirm-SuiBaLongRun -Minutes 360 -NonInteractive -Confirmed)
    $r = [pscustomobject]@{ reason='COMPLETED'; incidents=@(); containerExitCode=0; containerOOMKilled=$false; preflightSummaryVerdict='INCONCLUSIVE'; performance=$null }
    Assert 'COMPLETED is not PASS' ((Get-SuiBaOverallVerdict $r) -eq 'INCONCLUSIVE')
    $r.reason = 'USER_STOPPED'
    Assert 'user stop stays incomplete' ((Get-SuiBaOverallVerdict $r) -eq 'INCONCLUSIVE')
    $r.reason = 'SQLITE_FAILURE'
    Assert 'abnormal stop fails' ((Get-SuiBaOverallVerdict $r) -eq 'FAIL')
    $r.reason = 'COMPLETED'; $r.preflightSummaryVerdict = 'NO-GO'
    Assert 'NO-GO fails' ((Get-SuiBaOverallVerdict $r) -eq 'FAIL')
    $r.preflightSummaryVerdict='GO'
    Assert 'GO with missing checks is incomplete' ((Get-SuiBaOverallVerdict $r) -eq 'INCONCLUSIVE')
    $r | Add-Member qualityChecks ([pscustomobject]@{ sufficient=$true })
    $writer = [pscustomobject]@{ flushFailures=0; truncated=$false; dropped=0; queued=0 }
    $r.performance = [pscustomobject]@{ enabled=$true; reason=$null; sqlite=@{ available=$true; badLines=0 }; spikes=@{ available=$true; badLines=0 }; writers=@{sqlite=$writer;spikes=$writer} }
    Assert 'complete GO can PASS' ((Get-SuiBaOverallVerdict $r) -eq 'PASS')
    $writer.truncated=$true
    Assert 'truncated detail is incomplete' ((Get-SuiBaOverallVerdict $r) -eq 'INCONCLUSIVE')
    $writer.truncated=$false; $writer.flushFailures=1
    Assert 'detail persistence failure fails' ((Get-SuiBaOverallVerdict $r) -eq 'FAIL')
    $r.preflightSummaryVerdict='INCONCLUSIVE'
    Assert 'small sample cannot hide persistence failure' ((Get-SuiBaOverallVerdict $r) -eq 'FAIL')
    $r.preflightSummaryVerdict='GO'
    $writer.flushFailures=0
    $r.performance | Add-Member -NotePropertyName sinkErrors -NotePropertyValue 1
    Assert 'sink losses are not PASS' ((Get-SuiBaOverallVerdict $r) -eq 'INCONCLUSIVE')
    $run = Join-Path $work 'winverify-20261024T000000000Z-fixture'
    $reports = Join-Path $run 'reports'
    New-Item -ItemType Directory -Path $reports | Out-Null
    $r.performance=$null; $r.preflightSummaryVerdict='INCONCLUSIVE'
    $r | Add-Member sha 'fixture-sha'; $r | Add-Member runId 'fixture-run'
    [IO.File]::WriteAllText((Join-Path $reports 'report.json'), ($r | ConvertTo-Json -Depth 10))
    [IO.File]::WriteAllText((Join-Path $reports 'report.md'), '# report')
    [IO.File]::WriteAllText((Join-Path $reports 'preflight-summary.json'), '{"verdict":"INCONCLUSIVE","checks":{"suiMinAttempts":false,"safety":true}}')
    [IO.File]::WriteAllText((Join-Path $reports 'events.csv'), "atUtc,kind,apiOrScope,codeOrError,latencyMs,detail`n2026-10-24T00:00:00Z,api_failure,Sui gRPC,UPSTREAM_TIMEOUT,10000,TLS")
    $verdict = New-SuiBaNextActions -ReportsDir $reports -RunRoot $work -Forbidden @('fixture-sha')
    $text=[IO.File]::ReadAllText((Join-Path $reports 'next-actions.md'))
    Assert 'next actions states unmet criterion' ($text.Contains('suiMinAttempts'))
    Assert 'next actions includes timeout evidence' ($text.Contains('UPSTREAM_TIMEOUT') -and $text.Contains('2026-10-24T00:00:00Z'))
    Assert 'unknown cause explicitly stated' ($text.Contains('原因未確定') -and $text.Contains('因果関係の証明ではありません'))
    Assert 'secrets scrubbed in next actions' (-not $text.Contains('fixture-sha'))
    Assert 'latest result selected without Docker' ((Get-SuiBaLatestReport -RunRoot $work).FullName -eq $run)
    Assert 'current run excluded from comparison' ($null -eq (Get-SuiBaLatestReport -RunRoot $work -ExcludeRun $run))
    $r.sha='same-sha'; $r.performance=[pscustomobject]@{ enabled=$false }
    $r | Add-Member -NotePropertyName imageId -NotePropertyValue 'same-image'
    $r | Add-Member -NotePropertyName nodeVersion -NotePropertyValue 'v24.22.1'
    $r | Add-Member -NotePropertyName durationMinutesPlanned -NotePropertyValue 30
    $r | Add-Member -NotePropertyName settingsHashes -NotePropertyValue @('same-settings')
    $r | Add-Member -NotePropertyName summary -NotePropertyValue @{ Apis=@{ 'Sui gRPC'=@{Successes=1;Attempts=2}; 'DeepBook Indexer'=@{Successes=3;Attempts=4} } }
    $previousReports=Join-Path $work 'winverify-20261023T000000000Z-previous/reports'
    New-Item -ItemType Directory -Path $previousReports -Force | Out-Null
    $fixtureJson=$r | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $previousReports 'report.json'), $fixtureJson)
    [IO.File]::WriteAllText((Join-Path $reports 'report.json'), $fixtureJson)
    New-SuiBaNextActions -ReportsDir $reports -RunRoot $work -Rows @([pscustomobject]@{kind='sample';settingsSha256='same-settings'}) | Out-Null
    Assert 'matching evidence permits comparison' ([IO.File]::ReadAllText((Join-Path $reports 'next-actions.md')).Contains('成功/試行 1/2 → 1/2'))
    $r.sha='different-sha'
    [IO.File]::WriteAllText((Join-Path $previousReports 'report.json'), ($r | ConvertTo-Json -Depth 10))
    New-SuiBaNextActions -ReportsDir $reports -RunRoot $work -Rows @([pscustomobject]@{kind='sample';settingsSha256='same-settings'}) | Out-Null
    Assert 'different target refuses numeric comparison' ([IO.File]::ReadAllText((Join-Path $reports 'next-actions.md')).Contains('数値比較しません'))
    Open-SuiBaResultFolder -Path $reports -OpenFolder { throw 'Explorer unavailable' }
    Assert 'Explorer failure preserves report' (Test-Path -LiteralPath (Join-Path $reports 'next-actions.md'))
    Assert 'Docker error explanation is Japanese' ((Get-SuiBaFriendlyError 'Docker engine unavailable').Contains('Docker Desktopを起動'))
    # Cross-process mutex is also used during image preparation, before port bind.
    $mutex = New-Object Threading.Mutex($false, 'Local\SuiBaWindowsVerification')
    $owns=$mutex.WaitOne(0)
    if ($owns) {
        try {
            $exe=(Get-Process -Id $PID).Path
            $out=@(& $exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tool 'Invoke-SuiBaVerification.ps1') -DurationMinutes 30 -NonInteractive -RunRoot $work 2>&1)
            Assert 'second monitor rejected before Docker' ($LASTEXITCODE -ne 0 -and ($out -join '').Contains('二重起動'))
        } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
    } else { throw 'Cannot isolate singleton test while a real verification is running' }
} catch { $failed++; Write-Host "FAIL: $($_.Exception.Message)" }
finally {
    $resolved=[IO.Path]::GetFullPath($work)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -like 'suiba-oneclick-test-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
Write-Host "One-click self-test failures: $failed"
exit $failed
