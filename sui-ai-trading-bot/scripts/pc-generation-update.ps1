param(
  [Parameter(Mandatory = $true)][ValidatePattern('^SuiBa[0-9]+$')][string]$From,
  [Parameter(Mandatory = $true)][ValidatePattern('^SuiBa[0-9]+$')][string]$To,
  [hashtable]$SetEnv = @{},
  [ValidatePattern('^[\p{L}\p{M}\p{N}_-]+$')][string]$Reason = '更新後の再開',
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
# pc:resume の終了コードを明示的に判定する。
$PSNativeCommandUseErrorActionPreference = $false
$repo = 'https://github.com/tajumaru/SuiBa.git'
$oldApp = "D:\$From\sui-ai-trading-bot"
$newRoot = "D:\$To"
$newApp = "$newRoot\sui-ai-trading-bot"
$baseUrl = 'http://127.0.0.1:3100'
$reasonArg = "--reason=$Reason"
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$lf = [string][char]10

function Get-PortOwners {
  Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq 3100 } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

function Invoke-PcStatus {
  $lines = @(& pnpm pc:status 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'pc:status' }
  $lines
}

function Set-GenerationEnv($Path, $Updates) {
  if ($Updates.Count -eq 0) { return }
  $content = [IO.File]::ReadAllText($Path, $utf8)
  $newline = [Environment]::NewLine
  if ($content.Contains($lf) -and !$content.Contains([string][char]13 + $lf)) { $newline = $lf }
  # dotenv の引用値には複数行があり得るので、定義単位で走査する。
  $pattern = '(?m)^(?<prefix>[ \t]*(?:export[ \t]+)?(?<key>[\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+))(?:"(?:\\.|[^"\\])*"|''(?:\\.|[^''\\])*''|\x60(?:\\.|[^\x60\\])*\x60|[^#\r\n]*)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)'
  $found = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $content = [regex]::Replace($content, $pattern, [Text.RegularExpressions.MatchEvaluator]{
    param($entry)
    $key = $entry.Groups['key'].Value
    if ($Updates.ContainsKey($key)) {
      [void]$found.Add($key)
      return $entry.Groups['prefix'].Value + $Updates[$key] + $entry.Groups['suffix'].Value
    }
    return $entry.Value
  })
  foreach ($key in $Updates.Keys) {
    if ($found.Contains($key)) { continue }
    if ($content.Length -gt 0 -and !$content.EndsWith($lf)) { $content += $newline }
    $content += "$key=$($Updates[$key])$newline"
  }
  [IO.File]::WriteAllText($Path, $content, $utf8)
}

$stage = '事前確認'
$failure = '事前確認に失敗しました。'
$previousEncoding = [Console]::OutputEncoding
try {
  Write-Host "【$stage】"
  if (!(Test-Path -LiteralPath "$oldApp\.env" -PathType Leaf)) {
    $failure = '旧世代の .env がありません。'
    throw $failure
  }
  if (!(Test-Path -LiteralPath "$oldApp\data" -PathType Container)) {
    $failure = '旧世代の data フォルダがありません。'
    throw $failure
  }
  if (Test-Path -LiteralPath $newRoot) {
    $failure = '新世代のフォルダが既にあります。'
    throw $failure
  }

  $updates = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  foreach ($key in $SetEnv.Keys) {
    if ($key -isnot [string] -or $key -cnotmatch '^[A-Za-z_][A-Za-z0-9_.-]*$') {
      $failure = 'SetEnv に無効なキーがあります。'
      throw $failure
    }
    $value = [string]$SetEnv[$key]
    $failure = "SetEnv の $key に dotenv で表現できる単一行の値を指定してください。"
    if ($value -match '[\r\n\x00]') { throw $failure }
    if ($value -cmatch '\A[A-Za-z0-9_./:@+-]*\z') {
      $updates[$key] = $value
    } elseif (!$value.Contains("'")) {
      $updates[$key] = "'$value'"
    } elseif (!$value.Contains([char]96)) {
      $updates[$key] = [string][char]96 + $value + [char]96
    } elseif (!$value.Contains('"') -and $value -cnotmatch '\\[nr]') {
      $updates[$key] = '"' + $value + '"'
    } else {
      throw $failure
    }
  }
  $keys = ($updates.Keys | Sort-Object) -join ', '
  if (!$keys) { $keys = 'なし' }
  Write-Host "clone：$repo → $newRoot"
  Write-Host "コピー：$oldApp\.env / data → $newApp"
  Write-Host "変更する .env キー：$keys"
  Write-Host '旧 Bot の停止・終了から、新 Bot の install・build・起動・再開・状態確認まで行います。'
  if ($DryRun) { Write-Host '完了（DryRun、計画のみ）'; exit 0 }

  $failure = '開始を中止しました。'
  if (!$Yes -and (Read-Host '世代更新を開始しますか？ (y/n)') -ne 'y') { throw $failure }
  [Console]::OutputEncoding = $utf8

  $stage = '旧 Bot の停止'
  Write-Host "【$stage】"
  $failure = '3100 番ポートの旧 Bot プロセスを一意に確認できません。'
  $owners = @(Get-PortOwners)
  if ($owners.Count -ne 1 -or $owners[0] -le 4) { throw $failure }
  $oldProcess = Get-Process -Id $owners[0]
  # 終了確認で同じプロセスを追跡するため、先にハンドルを取得する。
  $null = $oldProcess.Handle

  $failure = '旧世代のアプリフォルダに移動できません。'
  Push-Location -LiteralPath $oldApp
  try {
    $failure = '旧世代の .env から管理用の鍵を読み取れません。'
    $token = 'const token = require("dotenv").parse(require("node:fs").readFileSync(".env")).ADMIN_TOKEN; if (token) process.stdout.write(token); else process.exitCode = 1;' | & node - 2>$null
    if ($LASTEXITCODE -ne 0 -or !$token -or $token -isnot [string]) { throw $failure }
    $failure = '停止 API が失敗しました。'
    $request = @{
      Uri = "$baseUrl/api/control"
      Method = 'Post'
      Headers = @{ Authorization = "Bearer $token" }
      ContentType = 'application/json'
      Body = '{"command":"stop"}'
      TimeoutSec = 10
      MaximumRedirection = 0
      UseBasicParsing = $true
    }
    $response = Invoke-WebRequest @request
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw $failure }

    $failure = 'pc:status で旧 Bot の停止と注文許可なしを確認できません。'
    $status = @(Invoke-PcStatus)
    if ($status -cnotcontains '稼働：停止中' -or $status -cnotcontains '注文許可：なし') { throw $failure }
    Write-Host '停止中・注文許可なしを確認しました。'
  } finally {
    Pop-Location
  }

  $stage = '旧プロセスの終了'
  Write-Host "【$stage】"
  $failure = '旧 Bot の停止確認後に 3100 番ポートの所有者が変わりました。'
  $owners = @(Get-PortOwners)
  if ($oldProcess.HasExited -or $owners.Count -ne 1 -or $owners[0] -ne $oldProcess.Id) { throw $failure }
  $failure = '旧 Bot を終了して 3100 番ポートを解放できません。'
  Stop-Process -InputObject $oldProcess -Force
  if (!$oldProcess.WaitForExit(10000) -or @(Get-PortOwners).Count -ne 0) { throw $failure }

  $stage = 'clone とコピー'
  Write-Host "【$stage】"
  $failure = '新世代の clone に失敗しました。'
  & git clone $repo $newRoot *> $null
  if ($LASTEXITCODE -ne 0) { throw $failure }
  $failure = '.env または data のコピーに失敗しました。'
  Copy-Item -LiteralPath "$oldApp\.env" -Destination "$newApp\.env"
  Copy-Item -LiteralPath "$oldApp\data" -Destination "$newApp\data" -Recurse

  $stage = '.env の変更'
  Write-Host "【$stage】"
  $failure = '新世代の .env を書き換えられません。'
  Set-GenerationEnv "$newApp\.env" $updates
  Write-Host "変更したキー：$keys"

  $failure = '新世代のアプリフォルダに移動できません。'
  Push-Location -LiteralPath $newApp
  try {
    foreach ($task in @('install', 'build')) {
      $stage = "pnpm $task"
      Write-Host "【$stage】"
      $failure = "pnpm $task に失敗しました。"
      & pnpm $task *> $null
      if ($LASTEXITCODE -ne 0) { throw $failure }
    }

    $stage = '新 Bot の起動'
    Write-Host "【$stage】"
    $failure = '新しいコンソールを起動できません。'
    $console = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c pnpm dev' -WorkingDirectory $newApp -PassThru
    $failure = '新 Bot の画面から 120 秒以内に HTTP 200 を確認できません。'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $ready = $false
    while ($timer.Elapsed.TotalSeconds -lt 120 -and !$console.HasExited) {
      $response = $null
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec 2 -MaximumRedirection 0
      } catch {
        # 起動中の接続失敗は制限時間内で再確認する。
      }
      if ($response.StatusCode -eq 200 -and !$console.HasExited -and $timer.Elapsed.TotalSeconds -lt 120) {
        $ready = $true
        break
      }
      Start-Sleep -Seconds 1
    }
    if (!$ready) { throw $failure }

    $stage = '新 Bot の再開'
    Write-Host "【$stage】"
    $failure = 'pc:resume が失敗しました。'
    $resume = @(& pnpm pc:resume -- $reasonArg 2>$null)
    $resumeExit = $LASTEXITCODE
    $resume | ForEach-Object { Write-Host $_ }
    if ($resumeExit -ne 0) {
      $failedChecks = @($resume | Where-Object { $_ -cmatch '^・' })
      if ($resumeExit -eq 1 -and $failedChecks.Count -eq 1 -and
          $failedChecks[0] -cmatch '^・残高の説明：' -and
          $resume -ccontains '判定：開けません' -and
          $resume -ccontains '残高の差を確認してください。') {
        $failure = '残高差分と単独の残高チェック失敗を pc:status で確認できません。'
        $status = @(Invoke-PcStatus)
        $status | ForEach-Object { Write-Host $_ }
        if ($status -cnotcontains '残高：差分あり' -or
            $status -cnotcontains '判定：問題あり（残高の説明）' -or
            $status -ccontains '・一部の項目を確認できません') { throw $failure }
        Write-Host "次の手動手順（$newApp で実行）"
        Write-Host '差分と約定内容を目視で照合し、説明できる場合にオーナーが承認してください。'
        Write-Host "  pnpm real:resume -- --approve $reasonArg"
        Write-Host "  pnpm pc:resume -- $reasonArg"
        Write-Host '停止（新 Bot の再開）：残高の説明について手動承認待ち。'
        exit 2
      }
      throw $failure
    }

    $stage = '最終確認'
    Write-Host "【$stage】"
    $failure = 'pc:status で稼働中と注文許可ありを確認できません。'
    $status = @(Invoke-PcStatus)
    $status | ForEach-Object { Write-Host $_ }
    if ($status -cnotcontains '稼働：稼働中' -or $status -cnotcontains '注文許可：あり') { throw $failure }
  } finally {
    Pop-Location
  }

  Write-Host '完了'
  exit 0
} catch {
  # HTTP、ファイル、外部コマンドの例外本文には秘密が含まれ得る。
  Write-Host "停止（$stage）：$failure"
  exit 1
} finally {
  [Console]::OutputEncoding = $previousEncoding
}
