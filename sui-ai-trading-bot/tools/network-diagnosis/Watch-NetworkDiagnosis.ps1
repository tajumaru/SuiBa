#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$RunDirectory,[switch]$Follow)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'progress.ps1')
$run=[IO.Path]::GetFullPath($RunDirectory)
$info=Get-Content -LiteralPath (Join-Path $run 'run-info.json') -Raw | ConvertFrom-Json
$cache=@{}
# Catch up a bounded amount before the first display when attaching to an existing run.
foreach($side in @('windows','docker')){
    for($i=0;$i -lt 16;$i++){
        try {$p=Get-DiagnosticProgress -File (Join-Path $run "$side/events.jsonl") -Cache $cache -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}
        catch {break}
        if($p.Status -ne 'READING_BACKLOG'){break}
    }
}
Write-Host 'Read-only progress viewer. Ctrl+C stops this viewer only; it never stops diagnosis.'
do {
    $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Write-DiagnosticProgress -RunDirectory $run -Cache $cache -NowMs $now -PlannedStart $info.startAt -PlannedEnd $info.endAt
    if(-not $Follow){break}
    $ended=0
    foreach($side in @('windows','docker')){
        $file=Join-Path $run "$side/events.jsonl"
        if($cache.ContainsKey($file) -and $cache[$file].EndReason){$ended++}
    }
    if($ended -eq 2 -or $now -ge $info.endAt+60000){break}
    Start-Sleep -Seconds 10
} while($true)
