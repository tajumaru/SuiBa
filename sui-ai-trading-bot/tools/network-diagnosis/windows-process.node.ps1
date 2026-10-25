# Offline only. Launch local Node fixtures, never Docker, DNS, HTTP or the live runner.
param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-process.ps1')
. (Join-Path $PSScriptRoot 'collectors.ps1')
$expected=@('', 'space path', 'quote"here', 'backslash\"q', 'C:\dir with space\', '\\server\share\',
    'two\\\"tricky', '{{index .Labels "io.suiba.netdiag.run"}}', 'one&two|three%PATH%$()',
    (([char]0x65e5).ToString()+[char]0x672c+[char]0x8a9e))
$program='process.stdout.write(JSON.stringify(process.argv.slice(1)))'
$result=Invoke-DiagnosticNative -File $NodePath -Arguments (@('-e',$program,'--')+$expected)
if($result.ExitCode -ne 0){throw 'Argument fixture did not run'}
$actual=$result.Stdout|ConvertFrom-Json
if($actual.Count -ne $expected.Count){throw 'Empty or spaced arguments were lost'}
for($i=0;$i -lt $expected.Count;$i++){if($actual[$i] -cne $expected[$i]){throw "Argument round trip failed at index $i"}}

$result=Invoke-DiagnosticNative -File $NodePath -Arguments @('-e','process.stdout.write("x".repeat(100000));process.stderr.write("y".repeat(100000));')
if($result.ExitCode -ne 0 -or $result.Stdout.Length -ne 100000 -or $result.Stderr.Length -ne 100000){throw 'Concurrent output drain failed'}
$result=Invoke-DiagnosticNative -File $NodePath -Arguments @('-e','process.stderr.write("fixture failure");process.exitCode=29')
if($result.ExitCode -ne 29 -or $result.Stderr -ne 'fixture failure'){throw 'Native failure status lost'}

$child=Start-DiagnosticProcess -File $NodePath -Arguments @('-e','setInterval(()=>{},1000)')
try {
    $outTask=$child.StandardOutput.ReadToEndAsync();$errTask=$child.StandardError.ReadToEndAsync()
    Stop-DiagnosticProcess $child
    if(-not $child.HasExited){throw 'Owned process not stopped'}
    $null=$outTask.GetAwaiter().GetResult();$null=$errTask.GetAwaiter().GetResult()
} finally {if(-not $child.HasExited){Stop-DiagnosticProcess $child};$child.Dispose()}

$file=Join-Path ([IO.Path]::GetTempPath()) ('suiba-utf8-'+[guid]::NewGuid().ToString('N')+'.jsonl')
try {
    Write-DiagnosticRecord -File $file -RunId 'netdiag-offline' -Record @{kind='fixture';value=$expected[-1]}
    $bytes=[IO.File]::ReadAllBytes($file)
    if($bytes.Length -gt 2 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191){throw 'Unexpected JSONL BOM'}
    $record=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8)|ConvertFrom-Json
    if($record.value -cne $expected[-1]){throw 'UTF8 JSONL corruption'}
} finally {if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}}
Write-Output ('Offline native process checks passed on PowerShell '+$PSVersionTable.PSVersion)
