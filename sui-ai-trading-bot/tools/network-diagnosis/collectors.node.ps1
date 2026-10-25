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
