# Test double for git, used only by Invoke-SelfTest.ps1.
$joined = $args -join ' '
if ($joined -match '^rev-parse') {
    Write-Output '4d24126285c35471397e968734a8a53fcd375808'
} elseif ($joined -match '^status') {
    # Clean tree: no output.
}
$global:LASTEXITCODE = 0
