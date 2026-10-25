#requires -Version 7.0
param([switch]$ExecuteLive,[string]$NodePath='node',[string]$OutputRoot='',
    [switch]$CapturePackets,[string]$PacketInterface='')
$ErrorActionPreference='Stop'
$tool=$PSScriptRoot
if(-not $ExecuteLive){
    Write-Output '{"dryRun":true,"networkRequests":0,"durationMinutes":30,"requires":"-ExecuteLive","operations":"read-only Sui metadata / DeepBook orderbook"}'
    return
}
if($env:CI -and $env:CI -ne 'false'){throw 'Live diagnosis is forbidden in CI.'}
if(-not $IsWindows){throw 'Use the Windows host runner; the isolated worker also runs in Linux Docker.'}
. (Join-Path $tool 'collectors.ps1')
$node=(Get-Command $NodePath -ErrorAction Stop).Source
$version=(& $node --version).Trim()
# The explicit absolute script below, not the caller working directory, guards Node.
$guard=& $node --input-type=module -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a!==24||b<22||(b===22&&c<1))process.exit(1)"
if($LASTEXITCODE -ne 0){throw 'Node must be >=24.22.1 <25. Set -NodePath explicitly.'}
if(-not(Test-Path -LiteralPath (Join-Path $tool 'node_modules/undici/package.json'))){throw 'Run npm ci --ignore-scripts in this tool directory before the live command.'}
$runId='netdiag-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmss').ToLowerInvariant()+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
if(-not $OutputRoot){$OutputRoot=Join-Path $tool 'results'}
$run=Join-Path ([IO.Path]::GetFullPath($OutputRoot)) $runId
if(Test-Path -LiteralPath $run){throw 'Refuse to overwrite a diagnosis run.'}
foreach($dir in @($run,(Join-Path $run 'windows'),(Join-Path $run 'docker'))){[void](New-Item -ItemType Directory -Path $dir)}
$system=Join-Path $run 'system.jsonl'
$emit={param($r) Write-DiagnosticRecord -File $system -RunId $runId -Record $r}.GetNewClosure()
$network=$null;$container=$null;$hostProcess=$null;$packetProcess=$null;$image="suiba-netdiag:$runId"
$hostStdout=$null;$hostStderr=$null;$packetStdout=$null;$packetStderr=$null
function Invoke-DiagnosticDocker([string[]]$Arguments){
    $output=@(& docker @Arguments 2>&1|ForEach-Object{"$_"})
    if($LASTEXITCODE -ne 0){throw 'DIAGNOSTIC_DOCKER_COMMAND_FAILED'}
    return $output
}
function Start-Hidden([string]$File,[string[]]$Arguments){
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$File;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    foreach($argument in $Arguments){[void]$info.ArgumentList.Add($argument)}
    return [Diagnostics.Process]::Start($info)
}
try {
    & $emit @{kind='collector-status';collector='runner';status='STARTING';node=$version;reason='EXPLICIT_LIVE_INVOCATION'}
    try {
        $info=(Invoke-DiagnosticDocker @('info','--format','{{json .}}')) -join '' | ConvertFrom-Json
        & $emit @{kind='collector-status';collector='docker-environment';status='OBSERVED';serverVersion=$info.ServerVersion;
            osType=$info.OSType;httpProxyPresent=[bool]$info.HTTPProxy;httpsProxyPresent=[bool]$info.HTTPSProxy;noProxyPresent=[bool]$info.NoProxy}
    } catch {& $emit @{kind='collector-status';collector='docker-environment';status='UNAVAILABLE';reason='INFO_FAILED'}}
    Invoke-DiagnosticDocker @('build','-t',$image,'--label',"io.suiba.netdiag.run=$runId",$tool) | Set-Content -LiteralPath (Join-Path $run 'build.log')
    $network=@(Invoke-DiagnosticDocker @('network','create','--label',"io.suiba.netdiag.run=$runId",'--driver','bridge',$runId))[0].Trim()
    if($network -notmatch '^[a-f0-9]{64}$'){throw 'Unexpected owned network ID.'}
    $startAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToUnixTimeMilliseconds()
    $endAt=$startAt+1800000
    [IO.File]::WriteAllText((Join-Path $run 'run-info.json'), (@{runId=$runId;startAt=$startAt;endAt=$endAt;image=$image;node=$version;sourceRevision=(@(& git -C $tool rev-parse HEAD 2>$null) -join '')} | ConvertTo-Json))
    $container=@(Invoke-DiagnosticDocker @('create','--name',$runId,'--label',"io.suiba.netdiag.run=$runId",'--network',$network,
        '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128',
        '--mount',"type=bind,source=$run,target=/out",$image,'--execute-live','--side','docker','--out','/out/docker','--run-id',$runId,'--start-at',"$startAt"))[0].Trim()
    if($container -notmatch '^[a-f0-9]{64}$' -or $network -notmatch '^[a-f0-9]{64}$'){throw 'Unexpected owned resource ID.'}
    Invoke-DiagnosticDocker @('start',$container)|Out-Null
    $hostProcess=Start-Hidden $node @((Join-Path $tool 'cli.mjs'),'--execute-live','--side','windows','--out',(Join-Path $run 'windows'),'--run-id',$runId,'--start-at',"$startAt")
    $hostStdout=$hostProcess.StandardOutput.ReadToEndAsync();$hostStderr=$hostProcess.StandardError.ReadToEndAsync()
    if($CapturePackets){
        $dumpcap=Get-Command dumpcap -ErrorAction SilentlyContinue
        if(-not $dumpcap -or -not $PacketInterface){& $emit @{kind='collector-status';collector='packets';status='UNAVAILABLE';reason='DUMPCAP_AND_EXPLICIT_INTERFACE_REQUIRED'}}
        else {
            # No pktmon global filters/sessions are changed. Capture belongs to this process only.
            $addresses=@('fullnode.mainnet.sui.io','deepbook-indexer.mainnet.mystenlabs.com'|ForEach-Object{
                try { Resolve-DnsName -Name $_ -Type A -ErrorAction Stop | Where-Object IPAddress | Select-Object -ExpandProperty IPAddress } catch {} })
            $addresses=@($addresses | Where-Object {$_ -match '^\d{1,3}(\.\d{1,3}){3}$'} | Select-Object -Unique)
            if(-not $addresses.Count){& $emit @{kind='collector-status';collector='packets';status='UNAVAILABLE';reason='NO_TARGET_CAPTURE_ADDRESSES'}}
            else {
                Write-Warning 'Packet capture may include unrelated DNS names. Keep packet files private.'
                $filter='(tcp port 443 and ('+(($addresses|ForEach-Object{"host $_"})-join ' or ')+')) or (udp port 53 or tcp port 53)'
                $packetProcess=Start-Hidden $dumpcap.Source @('-i',$PacketInterface,'-f',$filter,'-s','128','-a','duration:1860','-b','filesize:16384','-b','files:2','-w',(Join-Path $run 'packets.pcapng'))
                $packetStdout=$packetProcess.StandardOutput.ReadToEndAsync();$packetStderr=$packetProcess.StandardError.ReadToEndAsync()
                & $emit @{kind='collector-status';collector='packets';status='REQUESTED';reason='OPT_IN_CAPTURE_MAY_INCLUDE_UNRELATED_DNS_NAMES';targetAddresses=$addresses}
            }
        }
    } else {& $emit @{kind='collector-status';collector='packets';status='DISABLED';reason='EXPLICIT_CAPTURE_OPT_IN_REQUIRED'}}
    $logs=Join-Path $env:LOCALAPPDATA 'Docker/log/host';$offsets=@{}
    Read-DiagnosticDockerLogs -Directory $logs -Offsets $offsets -Emit $emit
    $since=[DateTime]::Now
    Write-Host "Independent diagnosis: $runId / 30 minutes / no trading. Results: $run"
    Write-Host "Stop: create $(Join-Path $run 'STOP') or press Ctrl+C."
    while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $endAt+60000){
        Start-Sleep -Seconds 10
        $until=[DateTime]::Now
        Read-DiagnosticWindowsEvents -Since $since -Until $until -Emit $emit;$since=$until
        Read-DiagnosticDockerLogs -Directory $logs -Offsets $offsets -Emit $emit
        Read-DiagnosticResources -ContainerId $container -Emit $emit
        $running=@(Invoke-DiagnosticDocker @('inspect','--format','{{.State.Running}}',$container))[0].Trim()
        if($hostProcess.HasExited -or $running -ne 'true' -or (Test-Path -LiteralPath (Join-Path $run 'STOP'))){break}
    }
} catch { & $emit @{kind='collector-status';collector='runner';status='FAILED';reason='RUNNER_FAILURE'};throw }
finally {
    if(Test-Path -LiteralPath $run){[IO.File]::WriteAllText((Join-Path $run 'STOP'),'USER_STOP')}
    if($hostProcess -and -not $hostProcess.HasExited){if(-not $hostProcess.WaitForExit(15000)){$hostProcess.Kill($true);& $emit @{kind='collector-status';collector='host-worker';status='FAILED';reason='WATCHDOG_KILLED'}}}
    if($hostStdout){[IO.File]::WriteAllText((Join-Path $run 'host-stdout.log'),$hostStdout.GetAwaiter().GetResult())}
    if($hostStderr){[IO.File]::WriteAllText((Join-Path $run 'host-stderr.log'),$hostStderr.GetAwaiter().GetResult())}
    if($container){
        # An owned immutable ID plus label check prevents stopping a pre-existing container.
        $owner=@(& docker inspect --format '{{index .Config.Labels "io.suiba.netdiag.run"}}' $container 2>$null)
        if($LASTEXITCODE -eq 0 -and $owner.Count -and $owner[0].Trim() -eq $runId){
            & docker stop --time 15 $container 2>$null|Out-Null
            # This is only our CLI's allowlisted code / summary output, not service logs.
            & docker logs --tail 20 $container 2>&1 | Set-Content -LiteralPath (Join-Path $run 'docker-worker.log')
            & docker rm $container 2>$null|Out-Null
        }
    }
    if($packetProcess -and -not $packetProcess.HasExited){$packetProcess.Kill($true);$packetProcess.WaitForExit()}
    if($packetStderr){[IO.File]::WriteAllText((Join-Path $run 'capture-status.log'),'Capture attempted; raw stderr suppressed. Inspect packet files locally.')}
    Read-DiagnosticPackets -Directory $run -Emit $emit
    if($network -and $network -match '^[a-f0-9]{64}$'){
        $networkOwner=@(& docker network inspect --format '{{index .Labels "io.suiba.netdiag.run"}}' $network 2>$null)
        if($LASTEXITCODE -eq 0 -and $networkOwner.Count -and $networkOwner[0].Trim() -eq $runId){& docker network rm $network 2>$null|Out-Null}
    }
    # Keep the uniquely tagged diagnostic image for reproducibility. Never prune anything.
    & $node (Join-Path $tool 'report.mjs') $run
}
