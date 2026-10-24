param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TaskArgs)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$portableNode = Join-Path $projectRoot '.runtime/node-v24.22.1-win-x64/node-v24.22.1-win-x64/node.exe'
$nodeExe = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node -ErrorAction Stop).Source }
if (!$TaskArgs) { $TaskArgs = @('test:offline') }
$previousPath = $env:PATH
Push-Location $projectRoot
try {
  $env:PATH = (Split-Path $nodeExe -Parent) + [IO.Path]::PathSeparator + $previousPath
  if ($TaskArgs[0] -eq 'pnpm') {
    & $nodeExe (Join-Path $PSScriptRoot 'verify-node-version.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $pnpmShim = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $pnpmEntry = Join-Path (Split-Path $pnpmShim -Parent) 'node_modules/pnpm/bin/pnpm.cjs'
    if (!(Test-Path -LiteralPath $pnpmEntry)) { throw 'PNPM_ENTRY_NOT_FOUND: use a standard pnpm installation or run the named project tasks' }
    $pnpmArgs = @($TaskArgs | Select-Object -Skip 1)
    & $nodeExe $pnpmEntry @pnpmArgs
  } else {
    & $nodeExe (Join-Path $PSScriptRoot 'run-project.mjs') @TaskArgs
  }
  $taskExit = $LASTEXITCODE
} finally {
  $env:PATH = $previousPath
  Pop-Location
}
exit $taskExit
