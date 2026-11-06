# Offline fixtures only; no live runner, network, Docker, DB or existing run mutation.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'progress.ps1')
$directory=Join-Path ([IO.Path]::GetTempPath()) ('suiba-progress-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($directory)
$file=Join-Path $directory 'events.jsonl';$encoding=[Text.UTF8Encoding]::new($false);$cache=@{}
try {
    $p=Get-DiagnosticProgress $file $cache 1000
    if($p.Status -ne 'WAITING_FOR_WORKER'){throw 'Missing file reported as recording'}
    [IO.File]::WriteAllText($file,'',$encoding)
    $lines=@(
        @{kind='measurement-start';at=1000;observedAt=1000},
        @{kind='attempt';success=$true;observedAt=1100},
        @{kind='attempt';success=$false;code='REQUEST_TIMEOUT';observedAt=1200},
        @{kind='cycle';slot=0;observedAt=1201},
        @{kind='unavailable';slot=1;observedAt=1202}
    )
    foreach($line in $lines){[IO.File]::AppendAllText($file,($line|ConvertTo-Json -Compress)+"`n",$encoding)}
    $hash=([IO.File]::ReadAllBytes($file) -join ',')
    $p=Get-DiagnosticProgress $file $cache 1500
    if($p.Status -ne 'RECORDING' -or $p.Attempts -ne 2 -or $p.Success -ne 1 -or $p.Failed -ne 1 -or $p.Unavailable -ne 1 -or $p.Slots -ne 2){throw 'Incorrect progress counts'}
    $p=Get-DiagnosticProgress $file $cache 1500
    if($p.Attempts -ne 2){throw 'Repeated display double-counted records'}
    if($hash -ne ([IO.File]::ReadAllBytes($file) -join ',')){throw 'Reader modified evidence'}
    if((Get-DiagnosticProgress $file $cache 40000).Status -ne 'LOG_NOT_UPDATED'){throw 'Stale log reported healthy'}
    if((Get-DiagnosticProgress $file $cache 100).Status -ne 'CLOCK_OFFSET'){throw 'Future log reported healthy'}
    [IO.File]::AppendAllText($file,'{"kind":"attempt","success":true,"observedAt":2000}',$encoding)
    if((Get-DiagnosticProgress $file $cache 2000).Attempts -ne 2){throw 'Partial line was counted'}
    [IO.File]::AppendAllText($file,"`n{broken}`n",$encoding)
    $p=Get-DiagnosticProgress $file $cache 2000
    if($p.Attempts -ne 3 -or -not $p.Gap){throw 'Partial or malformed line handling failed'}
    $end=@{kind='end';reason='CYCLES_FAILED_3_CONSECUTIVE';observedAt=2100}|ConvertTo-Json -Compress
    [IO.File]::AppendAllText($file,$end+"`n",$encoding)
    if((Get-DiagnosticProgress $file $cache 99999).Status -ne 'ENDED:CYCLES_FAILED_3_CONSECUTIVE'){throw 'Safety stop hidden'}
    $attempt=@{kind='attempt';success=$false;observedAt=3000}|ConvertTo-Json -Compress
    [IO.File]::WriteAllText($file,$attempt+"`n",$encoding)
    $p=Get-DiagnosticProgress $file $cache 3000
    if(-not $p.Gap -or $p.Attempts -ne 1){throw 'Truncation silently corrupted counts'}
    # Split a multibyte UTF-8 character at the 64 KiB read boundary.
    $prefix='{"kind":"resource","observedAt":4000,"value":"'
    $text=$prefix+('x'*(65535-$encoding.GetByteCount($prefix)))+[char]0x65e5+'"}'+"`n"
    [IO.File]::WriteAllText($file,$text,$encoding);$utfCache=@{}
    if((Get-DiagnosticProgress $file $utfCache 4000).Status -ne 'READING_BACKLOG'){throw 'Read bound not enforced'}
    $p=Get-DiagnosticProgress $file $utfCache 4000
    if($p.Gap -or $p.AgeSeconds -ne 0){throw 'Split UTF-8 decoder lost evidence'}
} finally {if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force};Remove-Item -LiteralPath $directory}
Write-Output ('Offline progress checks passed on PowerShell '+$PSVersionTable.PSVersion)
