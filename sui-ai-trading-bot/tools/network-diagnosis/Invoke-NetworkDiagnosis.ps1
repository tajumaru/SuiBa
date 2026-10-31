#requires -Version 5.1
param([switch]$ExecuteLive,[string]$NodePath='node',[string]$OutputRoot='',
    [switch]$CapturePackets,[string]$PacketInterface='')
$ErrorActionPreference='Stop'
$tool=$PSScriptRoot
if(-not $ExecuteLive){
    Write-Output '{"dryRun":true,"networkRequests":0,"durationMinutes":30,"requires":"-ExecuteLive","operations":"read-only Sui metadata / DeepBook orderbook"}'
    return
}
if($env:CI -and $env:CI -ne 'false'){throw 'Live diagnosis is forbidden in CI.'}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Use the Windows host runner; the isolated worker also runs in Linux Docker.'}
. (Join-Path $tool 'windows-process.ps1')
. (Join-Path $tool 'collectors.ps1')
. (Join-Path $tool 'progress.ps1')
$node=(Get-Command $NodePath -ErrorAction Stop).Source
$nodeVersion=Invoke-DiagnosticNative -File $node -Arguments @('--version')
if($nodeVersion.ExitCode -ne 0){throw 'Node version check failed.'}
$version=$nodeVersion.Stdout.Trim()
# The explicit absolute script below, not the caller working directory, guards Node.
$guard=Invoke-DiagnosticNative -File $node -Arguments @('--input-type=module','-e',"const [a,b,c]=process.versions.node.split('.').map(Number);if(a!==24||b<22||(b===22&&c<1))process.exit(1)")
if($guard.ExitCode -ne 0){throw 'Node must be >=24.22.1 <25. Set -NodePath explicitly.'}
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
    $docker=(Get-Command docker -ErrorAction Stop).Source
    $result=Invoke-DiagnosticNative -File $docker -Arguments $Arguments
    if($result.ExitCode -ne 0){throw 'DIAGNOSTIC_DOCKER_COMMAND_FAILED'}
    if($Arguments[0] -eq 'build'){
        return @($result.Stdout,$result.Stderr) -join "`n"
    }
    return $result.Stdout.TrimEnd() -split "`r?`n"
}
function Test-DiagnosticNormalEnd([string]$Side){
    try {
        $last=Get-Content -LiteralPath (Join-Path $run "$Side/events.jsonl") -Tail 1 -ErrorAction Stop | ConvertFrom-Json
        return $last.runId -eq $runId -and $last.side -eq $Side -and $last.kind -eq 'end' -and $last.reason -eq 'RUN_DEADLINE'
    } catch {return $false}
}
try {
    & $emit @{kind='collector-status';collector='runner';status='STARTING';node=$version;reason='EXPLICIT_LIVE_INVOCATION'}
    try {
        $info=(Invoke-DiagnosticDocker @('info','--format','{{json .}}')) -join '' | ConvertFrom-Json
        & $emit @{kind='collector-status';collector='docker-environment';status='OBSERVED';serverVersion=$info.ServerVersion;
            osType=$info.OSType;httpProxyPresent=[bool]$info.HTTPProxy;httpsProxyPresent=[bool]$info.HTTPSProxy;noProxyPresent=[bool]$info.NoProxy}
    } catch {& $emit @{kind='collector-status';collector='docker-environment';status='UNAVAILABLE';reason='INFO_FAILED'}}
    Write-Host 'Preparing isolated diagnostic image (existing containers are unchanged)...'
    Invoke-DiagnosticDocker @('build','-t',$image,'--label',"io.suiba.netdiag.run=$runId",$tool) | Set-Content -LiteralPath (Join-Path $run 'build.log')
    $network=@(Invoke-DiagnosticDocker @('network','create','--label',"io.suiba.netdiag.run=$runId",'--driver','bridge',$runId))[0].Trim()
    if($network -notmatch '^[a-f0-9]{64}$'){throw 'Unexpected owned network ID.'}
    $startAt=[DateTimeOffset]::UtcNow.AddSeconds(60).ToUnixTimeMilliseconds()
    $endAt=$startAt+1800000
    $revision=$null
    try {
        $git=(Get-Command git -ErrorAction Stop).Source
        $revisionResult=Invoke-DiagnosticNative -File $git -Arguments @('-C',$tool,'rev-parse','HEAD')
        if($revisionResult.ExitCode -eq 0){$revision=$revisionResult.Stdout.Trim()}
    } catch {}
    if(-not $revision){& $emit @{kind='collector-status';collector='source-revision';status='UNAVAILABLE';reason='GIT_REVISION_UNAVAILABLE'}}
    [IO.File]::WriteAllText((Join-Path $run 'run-info.json'), (@{runId=$runId;startAt=$startAt;endAt=$endAt;image=$image;node=$version;sourceRevision=$revision;powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json))
    $container=@(Invoke-DiagnosticDocker @('create','--name',$runId,'--label',"io.suiba.netdiag.run=$runId",'--network',$network,
        '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128',
        '--mount',"type=bind,source=$run,target=/out",$image,'--execute-live','--side','docker','--out','/out/docker','--run-id',$runId,'--start-at',"$startAt"))[0].Trim()
    if($container -notmatch '^[a-f0-9]{64}$' -or $network -notmatch '^[a-f0-9]{64}$'){throw 'Unexpected owned resource ID.'}
    Invoke-DiagnosticDocker @('start',$container)|Out-Null
    $hostProcess=Start-DiagnosticProcess $node @((Join-Path $tool 'cli.mjs'),'--execute-live','--side','windows','--out',(Join-Path $run 'windows'),'--run-id',$runId,'--start-at',"$startAt")
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
                $packetProcess=Start-DiagnosticProcess $dumpcap.Source @('-i',$PacketInterface,'-f',$filter,'-s','128','-a','duration:1860','-b','filesize:16384','-b','files:2','-w',(Join-Path $run 'packets.pcapng'))
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
    $progressCache=@{}
    while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $endAt+60000){
        try {Write-DiagnosticProgress -RunDirectory $run -Cache $progressCache -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -PlannedStart $startAt -PlannedEnd $endAt}
        catch {Write-Host 'Progress display unavailable; diagnosis and evidence collection continue.'}
        Start-Sleep -Seconds 10
        $until=[DateTime]::Now
        Read-DiagnosticWindowsEvents -Since $since -Until $until -Emit $emit;$since=$until
        Read-DiagnosticDockerLogs -Directory $logs -Offsets $offsets -Emit $emit
        Read-DiagnosticResources -ContainerId $container -Emit $emit
        $running=@(Invoke-DiagnosticDocker @('inspect','--format','{{.State.Running}}',$container))[0].Trim()
        if(Test-Path -LiteralPath (Join-Path $run 'STOP')){Write-Host 'Stop requested; collecting final reports.';break}
        # A normally completed side must not truncate the other side's actual 30-minute window.
        if($hostProcess.HasExited -and -not (Test-DiagnosticNormalEnd 'windows')){
            Write-Host 'WINDOWS WORKER EXITED before normal completion. See host-stderr.log and final reports.'
            & $emit @{kind='collector-status';collector='host-worker';status='FAILED';reason='WORKER_EXITED_WITHOUT_NORMAL_END';exitCode=$hostProcess.ExitCode}
            break
        }
        if($running -ne 'true' -and -not (Test-DiagnosticNormalEnd 'docker')){
            Write-Host 'DOCKER WORKER EXITED before normal completion. See docker-worker.log and final reports.'
            & $emit @{kind='collector-status';collector='docker-worker';status='FAILED';reason='WORKER_EXITED_WITHOUT_NORMAL_END'}
            break
        }
        if($hostProcess.HasExited -and $running -ne 'true'){Write-Host 'Both workers reached their normal end records; collecting reports.';break}
    }
} catch { & $emit @{kind='collector-status';collector='runner';status='FAILED';reason='RUNNER_FAILURE'};throw }
finally {
    if(Test-Path -LiteralPath $run){[IO.File]::WriteAllText((Join-Path $run 'STOP'),'USER_STOP')}
    if($hostProcess -and -not $hostProcess.HasExited){if(-not $hostProcess.WaitForExit(15000)){Stop-DiagnosticProcess $hostProcess;& $emit @{kind='collector-status';collector='host-worker';status='FAILED';reason='WATCHDOG_KILLED'}}}
    if($hostStdout){[IO.File]::WriteAllText((Join-Path $run 'host-stdout.log'),$hostStdout.GetAwaiter().GetResult())}
    if($hostStderr){[IO.File]::WriteAllText((Join-Path $run 'host-stderr.log'),$hostStderr.GetAwaiter().GetResult())}
    if($container){
        # An owned immutable ID plus label check prevents stopping a pre-existing container.
        $docker=(Get-Command docker -ErrorAction Stop).Source
        $owner=Invoke-DiagnosticNative -File $docker -Arguments @('inspect','--format','{{index .Config.Labels "io.suiba.netdiag.run"}}',$container)
        if($owner.ExitCode -eq 0 -and $owner.Stdout.Trim() -eq $runId){
            $null=Invoke-DiagnosticNative -File $docker -Arguments @('stop','--time','15',$container)
            $worker=Invoke-DiagnosticNative -File $docker -Arguments @('logs','--tail','20',$container)
            [IO.File]::WriteAllText((Join-Path $run 'docker-worker.log'),$worker.Stdout+$worker.Stderr)
            $null=Invoke-DiagnosticNative -File $docker -Arguments @('rm',$container)
        }
    }
    if($packetProcess -and -not $packetProcess.HasExited){Stop-DiagnosticProcess $packetProcess}
    if($packetStderr){[IO.File]::WriteAllText((Join-Path $run 'capture-status.log'),'Capture attempted; raw stderr suppressed. Inspect packet files locally.')}
    Read-DiagnosticPackets -Directory $run -Emit $emit
    if($network -and $network -match '^[a-f0-9]{64}$'){
        $docker=(Get-Command docker -ErrorAction Stop).Source
        $networkOwner=Invoke-DiagnosticNative -File $docker -Arguments @('network','inspect','--format','{{index .Labels "io.suiba.netdiag.run"}}',$network)
        if($networkOwner.ExitCode -eq 0 -and $networkOwner.Stdout.Trim() -eq $runId){$null=Invoke-DiagnosticNative -File $docker -Arguments @('network','rm',$network)}
    }
    # Keep the uniquely tagged diagnostic image for reproducibility. Never prune anything.
    $report=Invoke-DiagnosticNative -File $node -Arguments @((Join-Path $tool 'report.mjs'),$run)
    if($report.ExitCode -ne 0){throw 'DIAGNOSTIC_REPORT_FAILED'}
    Write-Output $report.Stdout.Trim()
    if($progressCache){
        try {Write-DiagnosticProgress -RunDirectory $run -Cache $progressCache -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -PlannedStart $startAt -PlannedEnd $endAt}
        catch {Write-Host 'See run reports for the final result.'}
    }
}
