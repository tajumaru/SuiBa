# Project-local portable Node only. Does not install MSI or change machine/user PATH.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $projectRoot '.runtime/node-v24.22.1-win-x64'
$nodeExe = Join-Path $runtimeDir 'node-v24.22.1-win-x64/node.exe'
if (Test-Path -LiteralPath $nodeExe) {
  & $nodeExe (Join-Path $PSScriptRoot 'verify-node-version.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'EXISTING_PORTABLE_NODE_REJECTED' }
  exit 0
}
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$archive = Join-Path $runtimeDir 'node.zip'
$checksums = Join-Path $runtimeDir 'SHASUMS256.txt'
Invoke-WebRequest 'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt' -OutFile $checksums
$expected = ((Select-String -LiteralPath $checksums -Pattern 'node-v24.22.1-win-x64.zip$').Line -split '\s+')[0]
if ($expected -ne 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5') { throw 'NODE_RELEASE_CHECKSUM_CHANGED' }
Invoke-WebRequest 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip' -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'NODE_ARCHIVE_HASH_MISMATCH' }
Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir
& $nodeExe (Join-Path $PSScriptRoot 'verify-node-version.mjs')
if ($LASTEXITCODE -ne 0) { throw 'PORTABLE_NODE_REJECTED' }
