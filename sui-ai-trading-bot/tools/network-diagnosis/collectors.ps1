# Windows PowerShell 5.1 / PowerShell 7. Read-only collectors. No commands run when this file is dot-sourced.
function ConvertTo-DiagnosticDockerLine {
    param([string]$Line, [long]$ObservedAt)
    $category = if ($Line -match '(?i)\bdns\b|resolv') { 'DNS' }
        elseif ($Line -match '(?i)\btls\b|handshake') { 'TLS' }
        elseif ($Line -match '(?i)\bproxy\b') { 'PROXY' }
        elseif ($Line -match '(?i)connect|timeout|retrans') { 'CONNECT' } else { return $null }
    $target = if ($Line.Contains('fullnode.mainnet.sui.io')) { 'sui' }
        elseif ($Line.Contains('deepbook-indexer.mainnet.mystenlabs.com')) { 'deepbook' } else { 'other' }
    $code = if ($Line -match '\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH)\b') { $Matches[1] } else { $null }
    $eventAt = $null
    if ($Line -match '^\[?(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)') {
        $parsed = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse($Matches[1], [ref]$parsed)) { $eventAt = $parsed.ToUnixTimeMilliseconds() }
    }
    # Never include the input text, URL, header, proxy address, token or unknown hostname.
    return @{ kind='docker-log'; at=$ObservedAt; eventAt=$eventAt; category=$category; target=$target; code=$code }
}
function ConvertTo-DiagnosticDnsEvent {
    param($Event)
    $xml=[xml]$Event.ToXml(); $fields=@{}
    foreach($item in $xml.Event.EventData.Data){ $fields[[string]$item.Name]=[string]$item.'#text' }
    $query = ([string]$fields['QueryName']).Trim().TrimEnd('.').ToLowerInvariant()
    return @{ kind='windows-dns'; at=([DateTimeOffset]$Event.TimeCreated).ToUnixTimeMilliseconds();
        eventId=$Event.Id; query=if($query -in @('fullnode.mainnet.sui.io','deepbook-indexer.mainnet.mystenlabs.com')){$query}else{'[other-host]'};
        clientPid=if($fields['ClientPID'] -match '^\d+$'){[int]$fields['ClientPID']}else{$null} }
}
function Write-DiagnosticRecord {
    param([string]$File,[string]$RunId,$Record)
    $Record.runId=$RunId; $Record.side='host'; $Record.observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    [IO.File]::AppendAllText($File, ($Record | ConvertTo-Json -Depth 8 -Compress)+"`n", [Text.UTF8Encoding]::new($false))
}
function Read-DiagnosticDockerLogs {
    param([string]$Directory,[hashtable]$Offsets,[scriptblock]$Emit)
    if(-not(Test-Path -LiteralPath $Directory)){ & $Emit @{kind='collector-status';collector='docker-logs';status='UNAVAILABLE';reason='DIRECTORY_MISSING'}; return }
    # Bound every read. Read only newly appended bytes; never copy a raw log.
    $files=@(Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue | Where-Object Name -Match 'backend|vpnkit|network|dns')
    if(-not $files.Count){& $Emit @{kind='collector-status';collector='docker-logs';status='UNAVAILABLE';reason='NO_SUPPORTED_LOG_FILES'}}
    foreach($file in $files){
        if(-not $Offsets.ContainsKey($file.FullName)){ $Offsets[$file.FullName]=$file.Length; continue }
        try {
            $stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
            try {
                $offset=[long]$Offsets[$file.FullName]
                if($stream.Length -lt $offset){$offset=0; & $Emit @{kind='collector-status';collector='docker-logs';status='ROTATED';reason='LOG_ROTATION'}}
                if($stream.Length-$offset -gt 1048576){$offset=$stream.Length-1048576; & $Emit @{kind='collector-status';collector='docker-logs';status='TRUNCATED';reason='READ_LIMIT'}}
                [void]$stream.Seek($offset,[IO.SeekOrigin]::Begin)
                $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8)
                $text=$reader.ReadToEnd();$Offsets[$file.FullName]=$stream.Position
                foreach($line in $text -split "`n"){
                    $safe=ConvertTo-DiagnosticDockerLine -Line $line -ObservedAt ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
                    if($safe){ & $Emit $safe }
                }
            } finally { $stream.Dispose() }
        } catch { & $Emit @{kind='collector-status';collector='docker-logs';status='UNAVAILABLE';reason='READ_FAILED'} }
    }
}
function ConvertTo-DiagnosticPacket {
    param([string]$Line)
    $f=$Line -split "`t", 8
    if($f.Count -lt 8 -or $f[0] -notmatch '^\d+(\.\d+)?$'){return $null}
    $query=if($f[1] -in @('fullnode.mainnet.sui.io','deepbook-indexer.mainnet.mystenlabs.com')){$f[1]}elseif($f[1]){'[other-host]'}else{$null}
    return @{kind='packet-summary';at=[long]([double]::Parse($f[0],[Globalization.CultureInfo]::InvariantCulture)*1000);
        query=$query;dnsResponse=($f[2] -eq '1');retransmission=($f[3] -eq '1');
        clientHello=($f[4] -match '(^|,)1(,|$)');serverHello=($f[4] -match '(^|,)2(,|$)');
        syn=($f[5] -eq '1');ack=($f[6] -eq '1');tcpStream=if($f[7] -match '^\d+$'){[int]$f[7]}else{$null}}
}
function Read-DiagnosticPackets {
    param([string]$Directory,[scriptblock]$Emit)
    $files=@(Get-ChildItem -LiteralPath $Directory -Filter '*.pcapng' -File)
    if(-not $files.Count){return}
    $tshark=Get-Command tshark -ErrorAction SilentlyContinue
    if(-not $tshark){& $Emit @{kind='collector-status';collector='packet-analysis';status='UNAVAILABLE';reason='TSHARK_MISSING'};return}
    foreach($file in $files){
        try {
            # Offline parsing only, bounded packet count; no raw frames, names or tool stderr persisted.
            $arguments=@('-n','-r',$file.FullName,'-c','10000','-Y','dns or tcp.analysis.retransmission or tls.handshake or tcp.flags.syn == 1','-T','fields',
                '-e','frame.time_epoch','-e','dns.qry.name','-e','dns.flags.response','-e','tcp.analysis.retransmission','-e','tls.handshake.type',
                '-e','tcp.flags.syn','-e','tcp.flags.ack','-e','tcp.stream')
            $result=Invoke-DiagnosticNative -File $tshark.Source -Arguments $arguments
            $lines=@($result.Stdout -split "`r?`n")
            if($result.ExitCode -ne 0){throw 'packet analysis failed'}
            foreach($line in $lines){$safe=ConvertTo-DiagnosticPacket $line;if($safe){& $Emit $safe}}
            & $Emit @{kind='collector-status';collector='packet-analysis';status='BOUNDED';reason='FIRST_10000_PACKETS_PER_FILE_SNAPLEN_128_TLS13_ENCRYPTED'}
        } catch {& $Emit @{kind='collector-status';collector='packet-analysis';status='UNAVAILABLE';reason='PARSE_FAILED'}}
    }
}
function Read-DiagnosticWindowsEvents {
    param([datetime]$Since,[datetime]$Until,[scriptblock]$Emit)
    foreach($source in @(@{Log='System';Provider='Microsoft-Windows-DNS-Client';Kind='windows-dns'},
        @{Log='Microsoft-Windows-WLAN-AutoConfig/Operational';Provider=$null;Kind='windows-wlan'})){
        try {
            $filter=@{LogName=$source.Log;StartTime=$Since;EndTime=$Until}
            if($source.Provider){$filter.ProviderName=$source.Provider}
            $events=@(Get-WinEvent -FilterHashtable $filter -MaxEvents 100 -ErrorAction Stop)
            foreach($event in $events){
                if($source.Kind -eq 'windows-dns'){& $Emit (ConvertTo-DiagnosticDnsEvent $event)}
                else {& $Emit @{kind='windows-wlan';at=([DateTimeOffset]$event.TimeCreated).ToUnixTimeMilliseconds();eventId=$event.Id}}
            }
            if($events.Count -eq 100){& $Emit @{kind='collector-status';collector=$source.Kind;status='TRUNCATED';reason='EVENT_LIMIT'}}
        } catch {
            & $Emit @{kind='collector-status';collector=$source.Kind;status='UNAVAILABLE_OR_NO_EVENTS';reason='NO_MATCH_OR_ACCESS_DENIED'}
        }
    }
}
function Read-DiagnosticResources {
    param([string]$ContainerId,[scriptblock]$Emit)
    try {
        $cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
        $memory=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        & $Emit @{kind='host-resource';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cpuPercent=$cpu.PercentProcessorTime;
            freeMemoryKiB=$memory.FreePhysicalMemory;totalMemoryKiB=$memory.TotalVisibleMemorySize}
    } catch {& $Emit @{kind='collector-status';collector='host-resource';status='UNAVAILABLE';reason='CIM_FAILED'}}
    if($ContainerId){
        try {
            $result=Invoke-DiagnosticNative -File (Get-Command docker -ErrorAction Stop).Source -Arguments @('stats','--no-stream','--format','{{json .}}',$ContainerId)
            if($result.ExitCode -ne 0){throw 'stats'}
            $s=$result.Stdout|ConvertFrom-Json
            & $Emit @{kind='docker-resource';at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cpuPercent=$s.CPUPerc;
                memory=$s.MemUsage;memoryPercent=$s.MemPerc}
        } catch {& $Emit @{kind='collector-status';collector='docker-resource';status='UNAVAILABLE';reason='STATS_FAILED'}}
    }
}
