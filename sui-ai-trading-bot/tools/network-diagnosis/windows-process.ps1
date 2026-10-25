# Windows PowerShell 5.1 / PowerShell 7. Definitions only; no process starts on import.
function ConvertTo-DiagnosticArgument {
    param([AllowEmptyString()][string]$Argument)
    # Windows CRT argument quoting. No shell, interpolation, or command-string execution.
    $escaped=[regex]::Replace($Argument, '(\\*)"', '$1$1\"')
    $escaped=[regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"'+$escaped+'"'
}
function Start-DiagnosticProcess {
    param([string]$File,[string[]]$Arguments)
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$File
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    # ArgumentList is unavailable on .NET Framework (Windows PowerShell 5.1).
    $info.Arguments=(@($Arguments | ForEach-Object {ConvertTo-DiagnosticArgument $_}) -join ' ')
    return [Diagnostics.Process]::Start($info)
}
function Invoke-DiagnosticNative {
    param([string]$File,[string[]]$Arguments)
    $child=Start-DiagnosticProcess -File $File -Arguments $Arguments
    try {
        # Drain both pipes concurrently; Docker build progress is normally on stderr.
        $stdout=$child.StandardOutput.ReadToEndAsync()
        $stderr=$child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        return [pscustomobject]@{ExitCode=$child.ExitCode;Stdout=$stdout.GetAwaiter().GetResult();Stderr=$stderr.GetAwaiter().GetResult()}
    } finally {$child.Dispose()}
}
function Stop-DiagnosticProcess {
    param([Diagnostics.Process]$Process)
    # Only the Process instance returned by our launcher, never PID/name enumeration.
    if(-not $Process.HasExited){
        try {$Process.Kill()} catch {if(-not $Process.HasExited){throw}}
        if(-not $Process.WaitForExit(5000)){throw 'OWNED_PROCESS_DID_NOT_EXIT'}
    }
}
