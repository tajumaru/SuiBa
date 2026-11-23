param(
[ValidatePattern('^SuiBa[0-9]+$')][string]$Dir = 'SuiBa17',
[hashtable]$SetEnv = @{},
[ValidatePattern('^[\p{L}\p{M}\p{N}_-]+$')][string]$Reason = '更新後の再開',
[switch]$DryRun,
[switch]$Yes
)

$ErrorActionPreference = 'Stop'
# ネイティブコマンドの終了コードは呼び出し側で明示的に判定する。
$PSNativeCommandUseErrorActionPreference = $false
$app = "D:\$Dir\sui-ai-trading-bot"
$baseUrl = 'http://127.0.0.1:3100'
$reasonArg = "--reason=$Reason"
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$lf = [string][char]10

# Windows PowerShell 5.1 では、$ErrorActionPreference='Stop' の下で
# ネイティブコマンドの標準エラー出力が終了エラーになり、終了コードを
# 見ずに止まってしまう（git clone は進捗を標準エラーへ書くため必ず
# 失敗した）。ネイティブ呼び出しは必ずこの関数経由にし、標準エラーは
# 捨てて終了コードだけを呼び出し側で判定する。
function Invoke-Native([scriptblock]$Command) {
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
& $Command 2>$null
return $LASTEXITCODE
} finally {
$ErrorActionPreference = $previous
}
}

function Get-PortOwners {
Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq 3100} |
Select-Object -ExpandProperty OwningProcess -Unique
}

function Invoke-PcStatus {
$lines = @(& pnpm pc:status 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'pc:status'}
$lines
}

function Set-AppEnv($Path, $Updates) {
if ($Updates.Count -eq 0) { return}
$content = [IO.File]::ReadAllText($Path, $utf8)
$newline = [Environment]::NewLine
if ($content.Contains($lf) -and!$content.Contains([string][char]13 + $lf)) { $newline = $lf}
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
if ($found.Contains($key)) { continue}
if ($content.Length -gt 0 -and!$content.EndsWith($lf)) { $content += $newline}
$content += "$key=$($Updates[$key])$newline"
}
[IO.File]::WriteAllText($Path, $content, $utf8)
}

$stage = '事前確認'
$failure = '事前確認に失敗しました。'
$previousEncoding = [Console]::OutputEncoding
try {
Write-Host ""
if (!(Test-Path -LiteralPath "$app\.env" -PathType Leaf)) {
$failure = '対象フォルダの.env がありません。'
throw $failure
}
if (!(Test-Path -LiteralPath "$app\data" -PathType Container)) {
$failure = '対象フォルダの data フォルダがありません。'
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
if ($value -match '[\r\n\x00]') { throw $failure}
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
if (!$keys) { $keys = 'なし'}
Write-Host "対象：$app（今のフォルダのまま git pull で更新）"
Write-Host "変更する.env キー：$keys"
Write-Host 'Bot の停止・終了から、pull・install・build・起動・再開・状態確認まで行います。'
if ($DryRun) { Write-Host '完了（DryRun、計画のみ）'; exit 0}

$failure = '開始を中止しました。'
if (!$Yes -and (Read-Host '更新を開始しますか？ (y/n)') -ne 'y') { throw $failure}
[Console]::OutputEncoding = $utf8

$stage = 'Bot の停止'
Write-Host ""
$failure = '3100 番ポートの Bot プロセスを一意に確認できません。'
$owners = @(Get-PortOwners)
if ($owners.Count -ne 1 -or $owners[0] -le 4) { throw $failure}
$oldProcess = Get-Process -Id $owners[0]
# 終了確認で同じプロセスを追跡するため、先にハンドルを取得する。
$null = $oldProcess.Handle

$failure = '対象のアプリフォルダに移動できません。'
Push-Location -LiteralPath $app
try {
$failure = '対象の.env から管理用の鍵を読み取れません。'
$token = 'const token = require("dotenv").parse(require("node:fs").readFileSync(".env")).ADMIN_TOKEN; if (token) process.stdout.write(token); else process.exitCode = 1;' | & node - 2>$null
if ($LASTEXITCODE -ne 0 -or!$token -or $token -isnot [string]) { throw $failure}
$failure = '停止 API が失敗しました。'
$request = @{
Uri = "$baseUrl/api/control"
Method = 'Post'
Headers = @{ Authorization = "Bearer $token"}
ContentType = 'application/json'
Body = '{"command":"stop"}'
TimeoutSec = 10
MaximumRedirection = 0
UseBasicParsing = $true
}
$response = Invoke-WebRequest @request
if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { throw $failure}

$failure = 'pc:status で Bot の停止と注文許可なしを確認できません。'
$status = @(Invoke-PcStatus)
if ($status -cnotcontains '稼働：停止中' -or $status -cnotcontains '注文許可：なし') { throw $failure}
Write-Host '停止中・注文許可なしを確認しました。'

$stage = 'プロセスの終了'
Write-Host ""
$failure = 'Bot の停止確認後に 3100 番ポートの所有者が変わりました。'
$owners = @(Get-PortOwners)
if ($oldProcess.HasExited -or $owners.Count -ne 1 -or $owners[0] -ne $oldProcess.Id) { throw $failure}
$failure = 'Bot を終了して 3100 番ポートを解放できません。'
Stop-Process -InputObject $oldProcess -Force
if (!$oldProcess.WaitForExit(10000) -or @(Get-PortOwners).Count -ne 0) { throw $failure}

$stage = 'git pull'
Write-Host ""
$failure = 'git pull に失敗しました。'
# 終了コードだけで合否を決めない。実績（2026-11-23）では pull 自体は
# 成功して HEAD が最新に届いていたのに、終了コードが異常で失敗扱いに
# なった。届くべきコミットと現在の HEAD の一致で判定する。
[void](Invoke-Native { git fetch origin main })
$expected = @(& git rev-parse origin/main 2>$null)
$pullExit = Invoke-Native { git pull --ff-only }
$actual = @(& git rev-parse HEAD 2>$null)
$reached = $expected.Count -eq 1 -and $actual.Count -eq 1 -and $expected[0].Trim() -eq $actual[0].Trim()
if ($pullExit -ne 0 -and !$reached) { throw $failure}
if ($pullExit -ne 0) { Write-Host 'pull の終了コードは異常でしたが、最新のコミットに届いているため続行します。'}

$stage = '.env の変更'
Write-Host ""
$failure = '対象の.env を書き換えられません。'
Set-AppEnv "$app\.env" $updates
Write-Host "変更したキー：$keys"

foreach ($task in @('install', 'build')) {
$stage = "pnpm $task"
Write-Host ""
$failure = "pnpm $task に失敗しました。"
if ((Invoke-Native { pnpm $task}) -ne 0) {
# install の失敗には Bot 停止直後のファイルロック等の一時的なものが
# ある（実績 2026-11-23：手動の再実行で成功した）。install だけ、
# 少し待って1回だけやり直す。build の失敗は本物のエラーのため対象外。
if ($task -ne 'install') { throw $failure }
Write-Host 'pnpm install が失敗したため、5秒待って1回だけやり直します。'
Start-Sleep -Seconds 5
if ((Invoke-Native { pnpm install }) -ne 0) { throw $failure }
}
}

$stage = 'Bot の起動'
Write-Host ""
$failure = '新しいコンソールを起動できません。'
$console = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c pnpm dev' -WorkingDirectory $app -PassThru
$failure = 'Bot の画面から 120 秒以内に HTTP 200 を確認できません。'
$timer = [Diagnostics.Stopwatch]::StartNew()
$ready = $false
while ($timer.Elapsed.TotalSeconds -lt 120 -and!$console.HasExited) {
$response = $null
try {
$response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec 2 -MaximumRedirection 0
} catch {
# 起動中の接続失敗は制限時間内で再確認する。
}
if ($response.StatusCode -eq 200 -and!$console.HasExited -and $timer.Elapsed.TotalSeconds -lt 120) {
$ready = $true
break
}
Start-Sleep -Seconds 1
}
if (!$ready) { throw $failure}

$stage = 'Bot の再開'
Write-Host ""
$failure = 'pc:resume が失敗しました。'
$resume = @(& pnpm pc:resume -- $reasonArg 2>$null)
$resumeExit = $LASTEXITCODE
$resume | ForEach-Object { Write-Host $_}
if ($resumeExit -ne 0) {
$failedChecks = @($resume | Where-Object { $_ -cmatch '^・'})
if ($resumeExit -eq 1 -and $failedChecks.Count -eq 1 -and
$failedChecks[0] -cmatch '^・残高の説明：' -and
$resume -ccontains '判定：開けません' -and
$resume -ccontains '残高の差を確認してください。') {
$failure = '残高差分と単独の残高チェック失敗を pc:status で確認できません。'
$status = @(Invoke-PcStatus)
$status | ForEach-Object { Write-Host $_}
if ($status -cnotcontains '残高：差分あり' -or
$status -cnotcontains '判定：問題あり（残高の説明）' -or
$status -ccontains '・一部の項目を確認できません') { throw $failure}
Write-Host "次の手動手順（$app で実行）"
Write-Host '差分と約定内容を目視で照合し、説明できる場合にオーナーが承認してください。'
Write-Host " pnpm real:resume -- --approve $reasonArg"
Write-Host " pnpm pc:resume -- $reasonArg"
Write-Host '停止（Bot の再開）：残高の説明について手動承認待ち。'
exit 2
}
throw $failure
}

$stage = '最終確認'
Write-Host ""
$failure = 'pc:status で稼働中と注文許可ありを確認できません。'
$status = @(Invoke-PcStatus)
$status | ForEach-Object { Write-Host $_}
if ($status -cnotcontains '稼働：稼働中' -or $status -cnotcontains '注文許可：あり') { throw $failure}
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
