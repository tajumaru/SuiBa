# Read-only progress projection. PowerShell 5.1 / 7. No network or process operations.
function Get-DiagnosticProgress {
    param([string]$File,[hashtable]$Cache,[long]$NowMs)
    if(-not $Cache.ContainsKey($File)){
        $Cache[$File]=@{Offset=0L;Pending='';Decoder=[Text.Encoding]::UTF8.GetDecoder();
            Attempts=0;Success=0;Failed=0;Unavailable=0;Slots=@{};LastAt=$null;
            StartAt=$null;EndReason=$null;LastCode=$null;Gap=$false}
    }
    $state=$Cache[$File]
    if(-not(Test-Path -LiteralPath $File)){
        return [pscustomobject]@{Status='WAITING_FOR_WORKER';Attempts=0;Success=0;Failed=0;Unavailable=0;Slots=0;AgeSeconds=$null;LastCode=$null;StartAt=$null;Gap=$state.Gap}
    }
    $stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try {
        if($stream.Length -lt $state.Offset){
            $state.Gap=$true;$state.Offset=0L;$state.Pending='';$state.Decoder.Reset()
            $state.Attempts=0;$state.Success=0;$state.Failed=0;$state.Unavailable=0;$state.Slots=@{}
            $state.LastAt=$null;$state.StartAt=$null;$state.EndReason=$null;$state.LastCode=$null
        }
        [void]$stream.Seek($state.Offset,[IO.SeekOrigin]::Begin)
        # At most 64 KiB per display tick; retain incomplete UTF-8 / JSON lines.
        $buffer=New-Object byte[] 65536
        $read=$stream.Read($buffer,0,$buffer.Length)
        $state.Offset+=$read
        $chars=New-Object char[] ([Text.Encoding]::UTF8.GetMaxCharCount($read))
        $count=$state.Decoder.GetChars($buffer,0,$read,$chars,0,$false)
        $text=$state.Pending+[string]::new($chars,0,$count)
        $last=$text.LastIndexOf("`n")
        if($last -ge 0){
            $state.Pending=$text.Substring($last+1)
            foreach($line in ($text.Substring(0,$last) -split "`n")){
                if(-not $line.Trim()){continue}
                try {
                    $row=$line|ConvertFrom-Json
                    if($row.observedAt -is [ValueType]){$state.LastAt=[long]$row.observedAt}
                    if($row.kind -eq 'attempt'){
                        $state.Attempts++
                        if($row.success -eq $true){$state.Success++}elseif($row.success -eq $false){$state.Failed++}
                        if($row.code){$state.LastCode=if($row.code -cmatch '^[A-Z][A-Z0-9_]{0,63}$'){$row.code}else{'UNKNOWN'}}
                    }
                    if($row.kind -in @('cycle','unavailable','skipped-slot') -and $row.slot -is [ValueType] -and $row.slot -ge 0 -and $row.slot -lt 30){$state.Slots[[int]$row.slot]=$true}
                    if($row.kind -eq 'unavailable'){$state.Unavailable++}
                    if($row.kind -eq 'measurement-start'){$state.StartAt=$row.at}
                    if($row.kind -eq 'end'){$state.EndReason=if($row.reason -cmatch '^[A-Z][A-Z0-9_]{0,63}$'){$row.reason}else{'UNKNOWN'}}
                } catch {$state.Gap=$true}
            }
        } else {$state.Pending=$text}
        if($state.Pending.Length -gt 65536){$state.Pending='';$state.Gap=$true}
        $backlog=$stream.Length -gt $state.Offset
    } finally {$stream.Dispose()}
    $age=if($null -ne $state.LastAt){($NowMs-$state.LastAt)/1000}else{$null}
    $status=if($state.EndReason){'ENDED:'+ $state.EndReason}
        elseif($backlog){'READING_BACKLOG'}
        elseif($null -eq $age){'WAITING_FOR_FIRST_RECORD'}
        elseif($age -lt 0){'CLOCK_OFFSET'}
        elseif($age -gt 30){'LOG_NOT_UPDATED'}
        elseif($null -eq $state.StartAt){'WAITING_FOR_START'}
        else{'RECORDING'}
    return [pscustomobject]@{Status=$status;Attempts=$state.Attempts;Success=$state.Success;Failed=$state.Failed;
        Unavailable=$state.Unavailable;Slots=$state.Slots.Count;AgeSeconds=$age;LastCode=$state.LastCode;StartAt=$state.StartAt;Gap=$state.Gap}
}
function Write-DiagnosticProgress {
    param([string]$RunDirectory,[hashtable]$Cache,[long]$NowMs,[long]$PlannedStart,[long]$PlannedEnd)
    $snapshots=@{}
    foreach($side in @('windows','docker')){
        try {$snapshots[$side]=Get-DiagnosticProgress -File (Join-Path $RunDirectory "$side/events.jsonl") -Cache $Cache -NowMs $NowMs}
        catch {$snapshots[$side]=[pscustomobject]@{Status='PROGRESS_UNAVAILABLE'}}
    }
    $elapsed=if($NowMs -lt $PlannedStart){'not started'}else{[TimeSpan]::FromMilliseconds($NowMs-$PlannedStart).ToString('mm\:ss')}
    $remaining=if($NowMs -ge $PlannedEnd){'planned end passed'}else{[TimeSpan]::FromMilliseconds($PlannedEnd-$NowMs).ToString('mm\:ss')}
    Write-Host ("[{0}] elapsed(planned)={1}/30:00 | remaining(approx)={2}" -f [DateTimeOffset]::FromUnixTimeMilliseconds($NowMs).ToLocalTime().ToString('HH:mm:ss'),$elapsed,$remaining)
    foreach($side in @('windows','docker')){
        $p=$snapshots[$side]
        if($p.Status -eq 'LOG_NOT_UPDATED' -and (Test-Path -LiteralPath (Join-Path $RunDirectory 'network-metrics.json'))){
            $p.Status='REPORT_AVAILABLE_NO_END_RECORD'
        }
        $age=if($null -ne $p.AgeSeconds){'{0:F1}s' -f $p.AgeSeconds}else{'unknown'}
        Write-Host ("  {0}: {1} | success={2} failed={3} attempts={4} | slots={5}/30 unavailable={6} | log age={7} last error={8} partial={9}" -f $side,$p.Status,$p.Success,$p.Failed,$p.Attempts,$p.Slots,$p.Unavailable,$age,$p.LastCode,$p.Gap)
    }
}
