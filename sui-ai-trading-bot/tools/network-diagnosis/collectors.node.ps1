# Offline assertions only. Does not query Windows events, Docker, DNS or packets.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'collectors.ps1')
$safe=ConvertTo-DiagnosticDockerLine '2026-10-25T01:02:03Z TLS fullnode.mainnet.sui.io ETIMEDOUT Authorization: super-secret https://user:pass@proxy.invalid' 123
$json=$safe|ConvertTo-Json -Compress
if($json -match 'secret|user:pass|proxy.invalid|Authorization'){throw 'Raw Docker log leaked'}
if($safe.category -ne 'TLS' -or $safe.target -ne 'sui' -or $safe.code -ne 'ETIMEDOUT'){throw 'Metadata lost'}
$event=[pscustomobject]@{TimeCreated=[DateTime]::UtcNow;Id=1014}
$event|Add-Member ScriptMethod ToXml { '<Event><EventData><Data Name="QueryName">private-secret.invalid</Data><Data Name="ClientPID">9848</Data></EventData></Event>' }
$dns=ConvertTo-DiagnosticDnsEvent $event
if($dns.query -ne '[other-host]' -or $dns.clientPid -ne 9848){throw 'DNS redaction failed'}
$packet=ConvertTo-DiagnosticPacket "1792880000.125`tprivate-secret.invalid`t1`t1`t1,2`t1`t0`t3"
if(($packet|ConvertTo-Json) -match 'private-secret'){throw 'Packet name leaked'}
if(-not $packet.retransmission -or -not $packet.clientHello -or -not $packet.serverHello -or $packet.at -ne 1792880000125){throw 'Packet metadata lost'}
Write-Output 'Offline collectors passed'

# Load only the runner's pure end-record reader, never its executable top level.
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Invoke-NetworkDiagnosis.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Runner syntax error'}
$reader=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Test-DiagnosticNormalEnd'},$true)
. ([scriptblock]::Create($reader.Extent.Text))
$run=Join-Path ([IO.Path]::GetTempPath()) ('suiba-peer-test-'+[guid]::NewGuid().ToString('N'))
$runId='netdiag-offline-peer'
$sideDirectory=Join-Path $run 'windows';$eventFile=Join-Path $sideDirectory 'events.jsonl'
[void][IO.Directory]::CreateDirectory($sideDirectory)
try {
    @{runId=$runId;side='windows';kind='end';reason='RUN_DEADLINE'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $eventFile
    if(-not(Test-DiagnosticNormalEnd 'windows')){throw 'Normal peer completion lost'}
    if(Test-DiagnosticNormalEnd 'docker'){throw 'Missing peer incorrectly completed'}
    @{runId=$runId;side='windows';kind='end';reason='CYCLES_FAILED_3_CONSECUTIVE'} | ConvertTo-Json -Compress | Set-Content -LiteralPath $eventFile
    if(Test-DiagnosticNormalEnd 'windows'){throw 'Safety stop treated as normal completion'}
} finally {
    Remove-Item -LiteralPath $eventFile -Force
    Remove-Item -LiteralPath $sideDirectory
    Remove-Item -LiteralPath $run
}
Write-Output 'Offline peer completion checks passed'
