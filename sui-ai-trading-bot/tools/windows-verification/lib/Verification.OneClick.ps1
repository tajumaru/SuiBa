# UI and post-run guidance only. No Docker calls or trading operations.
function Get-SuiBaFriendlyError {
    param([string]$Message)
    $hint = switch -Regex ($Message) {
        'Docker engine' { 'Docker Desktopを起動してから再実行してください。'; break }
        'Compose' { 'Docker Composeの利用可否または専用設定を確認してください。'; break }
        'Working tree|git status' { '未コミット変更があるか、Git状態を取得できません。変更を保存してから再実行してください。'; break }
        'Node' { 'Node.jsは24.22.1以上25未満が必要です。コンテナの実際のバージョン確認に失敗しました。'; break }
        'Port .*3105' { 'ポート3105は使用中です。他の環境を自動停止せず中止しました。'; break }
        'Disk' { 'ディスク空き容量またはDocker保存先の確認条件を満たしていません。'; break }
        default { '開始条件または安全条件を満たさないため検証を中止しました。' }
    }
    return "$hint 詳細: $Message"
}

function Read-SuiBaMenuChoice {
    param([scriptblock]$ReadInput = { param($Prompt) Read-Host $Prompt })
    while ($true) {
        Write-Host "`nSuiBa 通信観測（取引は開始しません）"
        Write-Host '1. 30分検証（推奨・初期選択）'
        Write-Host '2. 2時間検証'
        Write-Host '3. 6時間検証'
        Write-Host '4. 24時間検証'
        Write-Host '5. 前回の検証結果を開く'
        Write-Host '6. 実行中の検証を安全に停止する'
        Write-Host '7. 終了'
        $choice = & $ReadInput '番号を入力（Enterで30分）'
        if ([string]::IsNullOrWhiteSpace($choice)) { return '1' }
        if ("$choice" -match '^[1-7]$') { return "$choice" }
        Write-Host '1～7を入力してください。'
    }
}

function Confirm-SuiBaLongRun {
    param([double]$Minutes, [switch]$NonInteractive, [switch]$Confirmed,
        [scriptblock]$ReadInput = { param($Prompt) Read-Host $Prompt })
    if ($Minutes -lt 360) { return $true }
    Write-Host "実行時間: $Minutes 分。停止状態の通信観測のみ。PAPER/LIVE取引・注文は開始しません。"
    Write-Host '専用環境のみ使用し、連続3周期失敗・5分正常取得なし・DB/証拠保存異常・容量不足で停止します。'
    Write-Host 'Docker保存先80%以上、システム/出力/一時ドライブ空き10GiB未満で停止。独立期限監視を維持します。'
    if ($Confirmed) { return $true }
    if ($NonInteractive) { throw '6時間・24時間の非対話実行には明示承認の -ConfirmLongRun が必要です。' }
    return ((& $ReadInput '開始する場合だけ START と入力してください') -ceq 'START')
}

function Get-SuiBaLatestReport {
    param([string]$RunRoot, [string]$ExcludeRun = '')
    if (-not (Test-Path -LiteralPath $RunRoot)) { return $null }
    return Get-ChildItem -LiteralPath $RunRoot -Directory |
        Where-Object { $_.Name -like 'winverify-*' -and $_.FullName -ne $ExcludeRun -and (Test-Path -LiteralPath (Join-Path $_.FullName 'reports/report.json')) } |
        Sort-Object Name -Descending | Select-Object -First 1
}

function Open-SuiBaResultFolder {
    param([string]$Path, [scriptblock]$OpenFolder = { param($Folder) Start-Process -FilePath explorer.exe -ArgumentList ('"' + $Folder + '"') -ErrorAction Stop | Out-Null })
    Write-Host "結果フォルダ: $Path"
    if (-not (Test-Path -LiteralPath $Path)) { Write-Host '結果フォルダはまだありません。'; return }
    try { & $OpenFolder $Path } catch { Write-Host 'フォルダを自動表示できませんでした。上記パスから開けます。保存済みレポートは保持されています。' }
}

function Get-SuiBaOverallVerdict {
    param($Report)
    $p = $Report.performance
    # Known failures take precedence even if the communication sample is small.
    if (@($Report.incidents | Where-Object { $null -ne $_ -and -not ($Report.reason -eq 'USER_STOPPED' -and $_.Reason -eq 'USER_STOPPED') }).Count -gt 0 -or $Report.containerOOMKilled -or
        ($null -ne $Report.containerExitCode -and $Report.containerExitCode -ne 0) -or
        $p.sqlite.failures -gt 0 -or
        @(@($p.writers.sqlite, $p.writers.spikes) | Where-Object { $_.flushFailures -gt 0 }).Count -gt 0) { return 'FAIL' }
    if ($Report.reason -ne 'COMPLETED') {
        if ($Report.reason -eq 'USER_STOPPED') { return 'INCONCLUSIVE' }
        return 'FAIL'
    }
    $context = $Report.qualityWindow.context
    if ($context -and ($context.runId -ne $Report.runId -or $context.sha -ne $Report.sha -or
        $context.imageId -ne $Report.imageId -or $context.durationMinutes -ne $Report.durationMinutesPlanned -or
        $context.perfDetailEnabled -ne $p.enabled)) { return 'FAIL' }
    if ($Report.preflightSummaryVerdict -eq 'NO-GO') { return 'FAIL' }
    if ($Report.preflightSummaryVerdict -ne 'GO') { return 'INCONCLUSIVE' }
    if (-not $Report.qualityChecks -or @($Report.qualityChecks.PSObject.Properties).Count -eq 0 -or
        @($Report.qualityChecks.PSObject.Properties | Where-Object { $_.Value -ne $true }).Count -gt 0) { return 'INCONCLUSIVE' }
    if ($p.sinkErrors -gt 0) { return 'INCONCLUSIVE' }
    if (-not $p -or -not $p.enabled -or -not $p.sqlite.available -or -not $p.spikes.available -or $p.reason) { return 'INCONCLUSIVE' }
    if (-not $p.writers -or $p.sqlite.badLines -gt 0 -or $p.spikes.badLines -gt 0) { return 'INCONCLUSIVE' }
    foreach ($w in @($p.writers.sqlite, $p.writers.spikes)) {
        if ($w.flushFailures -gt 0) { return 'FAIL' }
        if ($w.truncated -or $w.dropped -gt 0 -or $w.queued -gt 0) { return 'INCONCLUSIVE' }
    }
    return 'PASS'
}

function New-SuiBaNextActions {
    param([string]$ReportsDir, [string]$RunRoot, [string[]]$Forbidden = @(), $Rows = @())
    $reportPath = Join-Path $ReportsDir 'report.json'
    $r = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json -ErrorAction Stop
    $summaryPath = Join-Path $ReportsDir 'preflight-summary.json'
    $s = $null
    if (Test-Path -LiteralPath $summaryPath) { $s = [IO.File]::ReadAllText($summaryPath) | ConvertFrom-Json -ErrorAction Stop }
    $r | Add-Member -NotePropertyName qualityChecks -NotePropertyValue $s.checks -Force
    $r | Add-Member -NotePropertyName qualityCriteria -NotePropertyValue $s.criteria -Force
    $r | Add-Member -NotePropertyName qualityWindow -NotePropertyValue $s.window -Force
    $hashes = @($Rows | Where-Object { $_.kind -eq 'sample' -and $_.settingsSha256 } | ForEach-Object { $_.settingsSha256 } | Sort-Object -Unique)
    $r | Add-Member -NotePropertyName settingsHashes -NotePropertyValue $hashes -Force
    $verdict = Get-SuiBaOverallVerdict $r
    $r | Add-Member -NotePropertyName overallVerdict -NotePropertyValue $verdict -Force
    [IO.File]::WriteAllText($reportPath, (Protect-SuiBaText ($r | ConvertTo-Json -Depth 20) $Forbidden), [Text.UTF8Encoding]::new($false))
    $md = New-Object Text.StringBuilder
    [void]$md.AppendLine('# 次の調査・検証への案内')
    [void]$md.AppendLine("`n総合評価: **$verdict** / 終了理由: $($r.reason) / 通信集計: $($r.preflightSummaryVerdict)")
    [void]$md.AppendLine("対象SHA: $($r.sha)。COMPLETEDは予定終了であり、PASSとは別です。PAPER取引・LIVE取引は未検証です。")
    [void]$md.AppendLine("`n## 未達・未確認の品質基準")
    if (Test-Path -LiteralPath $summaryPath) {
        $failed = @($s.checks.PSObject.Properties | Where-Object { $_.Value -ne $true })
        foreach ($f in $failed) {
            $criterion = $s.criteria.($f.Name)
            if ($criterion) {
                [void]$md.AppendLine("- $($f.Name): $($criterion.status) / 実測=$($criterion.actual) / 基準=$($criterion.threshold) $($criterion.unit) / 入力=$($criterion.source)")
            } else { [void]$md.AppendLine("- $($f.Name): 未達または未確認") }
        }
        if ($s.checks.suiMinAttempts -eq $false) { [void]$md.AppendLine('- Suiは実HTTP試行100件以上が必要です。healthキャッシュの成功を試行数に加算しません。2時間完了だけでは母数を保証せず、基準を維持した追加の独立検証が必要です。') }
        if (-not $s.checks -or @($s.checks.PSObject.Properties).Count -eq 0) { [void]$md.AppendLine('- 品質基準の内訳なし。合格の証拠として扱えません。') }
        elseif ($failed.Count -eq 0) { [void]$md.AppendLine('- 保存された通信品質チェックはすべて達成。取引検証の合格ではありません。') }
    } else { [void]$md.AppendLine('- 通信品質サマリ欠落。判定できません。') }
    [void]$md.AppendLine("`n## 通信失敗の時刻と種類（UTC）")
    $events = Join-Path $ReportsDir 'events.csv'
    $failures = @()
    if (Test-Path -LiteralPath $events) { $failures = @(Import-Csv -LiteralPath $events -Encoding UTF8 | Where-Object { $_.kind -eq 'api_failure' -or $_.kind -eq 'cycle_failure' }) }
    foreach ($f in $failures) { [void]$md.AppendLine("- $($f.atUtc): $($f.apiOrScope) / $($f.codeOrError) / $($f.detail) / $($f.latencyMs) ms") }
    if ($failures.Count -eq 0) { [void]$md.AppendLine('- 記録された通信・市場周期失敗なし。未観測の成功を意味しません。') }
    if ($r.performance) { [void]$md.AppendLine((New-SuiBaPerfAnalysisMarkdown -Perf $r.performance)) }
    else { [void]$md.AppendLine("`nSQLite・イベントループTOP10、同時刻処理: 詳細計測が欠落しており未確認。") }
    [void]$md.AppendLine("`n## 前回との比較")
    # Comparisons require identical target/settings/duration/measurement mode.
    $currentRun = Split-Path -Parent $ReportsDir
    $previous = Get-SuiBaLatestReport -RunRoot $RunRoot -ExcludeRun $currentRun
    if ($previous) {
        $p = $null
        try { $p = [IO.File]::ReadAllText((Join-Path $previous.FullName 'reports/report.json')) | ConvertFrom-Json -ErrorAction Stop } catch { }
        $currentSettings = @($r.settingsHashes)
        $priorSettings = @($p.settingsHashes)
        if ($p -and $r.sha -and $r.imageId -and $r.nodeVersion -and $r.reason -eq 'COMPLETED' -and $p.reason -eq 'COMPLETED' -and
            $r.sha -eq $p.sha -and $r.imageId -eq $p.imageId -and $r.nodeVersion -eq $p.nodeVersion -and
            $r.durationMinutesPlanned -eq $p.durationMinutesPlanned -and $r.performance -and $p.performance -and
            $r.performance.enabled -eq $p.performance.enabled -and
            $currentSettings.Count -eq 1 -and $priorSettings.Count -eq 1 -and $currentSettings[0] -and $currentSettings[0] -eq $priorSettings[0]) {
            [void]$md.AppendLine("- 比較対象: $($p.runId)。同一SHA・Node・予定時間・設定ハッシュ・計測モード。実試行数と実測時間の差に注意してください。")
            foreach ($api in @('Sui gRPC', 'DeepBook Indexer')) {
                [void]$md.AppendLine("- ${api}: 成功/試行 $($p.summary.Apis.$api.Successes)/$($p.summary.Apis.$api.Attempts) → $($r.summary.Apis.$api.Successes)/$($r.summary.Apis.$api.Attempts)")
            }
        } else { [void]$md.AppendLine('- 前回はSHA・Node・期間・設定・計測モードの同一性を確認できないため数値比較しません。') }
    } else { [void]$md.AppendLine('- 比較可能な前回レポートなし。') }
    [void]$md.AppendLine("`n## 次に調査すべき項目・開始条件")
    [void]$md.AppendLine('- 原因未確定。同時刻の処理は相関の候補であり、因果関係の証明ではありません。')
    [void]$md.AppendLine('- 未達基準、通信失敗のphase、SQLite/同期I/Oと遅延の対応、計測の欠落・上限・オーバーヘッドを確認してください。')
    [void]$md.AppendLine('- 次回も対象SHA固定、独立環境、Node条件、ディスク条件、証拠保存、期限監視、注文・約定0件を維持してください。')
    [void]$md.AppendLine('- INCONCLUSIVE/FAILは成功扱いしません。期間延長で未達や保存障害を隠さず、必要な原因調査と修正を先に行ってください。')
    [void]$md.AppendLine('- 6時間・24時間は開始前の明示確認が必要です。通信観測のPASSでもPAPER取引・LIVE取引の開始は承認されません。')
    $text = Protect-SuiBaText $md.ToString() $Forbidden
    [IO.File]::WriteAllText((Join-Path $ReportsDir 'next-actions.md'), $text, [Text.UTF8Encoding]::new($false))
    $reportMd = Join-Path $ReportsDir 'report.md'
    [IO.File]::AppendAllText($reportMd, "`r`n総合評価: **$verdict**。詳細: next-actions.md`r`n", [Text.UTF8Encoding]::new($false))
    return $verdict
}
