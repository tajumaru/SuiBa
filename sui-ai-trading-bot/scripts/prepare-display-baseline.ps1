param([string]$BaseSha = '6ff13aea54d2ed4375505557d36e3e6162722ec5')
$ErrorActionPreference = 'Stop'
if ($BaseSha -notmatch '^[0-9a-f]{40}$') { throw 'Specify a full lowercase commit SHA.' }
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $appRoot '..')).Path
$destination = Join-Path $appRoot 'data/performance/baseline'
if (Test-Path -LiteralPath $destination) { throw 'Use a new destination; an existing baseline is never overwritten.' }
$resolvedSha = & git -C $repoRoot rev-parse "$BaseSha^{commit}"
if ($LASTEXITCODE -ne 0 -or $resolvedSha -ne $BaseSha) { throw 'Specify a full existing commit SHA.' }
New-Item -ItemType Directory -Path $destination | Out-Null
$archive = Join-Path $destination 'source.zip'
& git -C $repoRoot archive $BaseSha -o $archive
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $destination 'source')
$sourceRoot = Join-Path $destination 'source/sui-ai-trading-bot'
New-Item -ItemType Junction -Path (Join-Path $sourceRoot 'node_modules') -Target (Join-Path $appRoot 'node_modules') | Out-Null
# Only add the same timing probes as the new implementation. No aggregation edits.
$utf8 = [System.Text.UTF8Encoding]::new($false)
$currentDb = [System.IO.File]::ReadAllText((Join-Path $appRoot 'packages/database/src/index.ts'))
$helperStart = $currentDb.IndexOf('  private prepare(sql: string)')
$helperEnd = $currentDb.IndexOf('  private transactionVersion', $helperStart)
if ($helperStart -lt 0 -or $helperEnd -lt 0) { throw 'Timing helper changed; review baseline instrumentation.' }
$helper = $currentDb.Substring($helperStart, $helperEnd - $helperStart)
$dbPath = Join-Path $sourceRoot 'packages/database/src/index.ts'
$source = [System.IO.File]::ReadAllText($dbPath)
$source = 'import { timeSql } from "../../shared/src/api-timing.ts";' + "`n" + $source
$source = [regex]::Replace($source, 'this\.db\s*\.prepare\(', 'this.prepare(')
$source = $source.Replace('  private db: DatabaseSync;', '  private db: DatabaseSync;' + "`n" + $helper)
[System.IO.File]::WriteAllText($dbPath, $source, $utf8)
Copy-Item -LiteralPath (Join-Path $appRoot 'packages/shared/src/api-timing.ts') -Destination (Join-Path $sourceRoot 'packages/shared/src/api-timing.ts')
Write-Output "Fixed source: $BaseSha"
Write-Output "SOURCE_ROOT=$sourceRoot"
