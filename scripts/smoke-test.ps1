# Starts a Tavrix.exe with --smoke-test and fails unless it reports a healthy Windows start-up.
#   pwsh scripts/smoke-test.ps1 -Exe path\to\Tavrix.exe [-ExpectPackaged]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [switch]$ExpectPackaged
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Exe)) { throw "Not found: $Exe" }
$out = Join-Path ([System.IO.Path]::GetTempPath()) ("tavrix-smoke-" + [guid]::NewGuid().ToString('N') + '.json')
$p = Start-Process -FilePath $Exe -ArgumentList '--smoke-test', "--smoke-out=$out" -PassThru
if (-not $p.WaitForExit(90000)) { $p.Kill(); throw 'The app did not finish its start-up check within 90 seconds' }
Write-Host "exit code: $($p.ExitCode)"
if (-not (Test-Path $out)) { throw 'The app wrote no start-up result' }
$r = Get-Content $out -Raw | ConvertFrom-Json
Write-Host ($r | ConvertTo-Json)
if (-not $r.ok) { throw 'The start-up check failed: the window, the bridge, the terminal or the saved sessions did not load' }
if ($r.platform -ne 'win32') { throw "Expected the win32 platform, got $($r.platform)" }
if ($ExpectPackaged -and -not $r.packaged) { throw 'This was not the packaged app' }
if (-not $r.notMac) { throw 'The window did not switch to the Windows layout' }
if ($r.sessionsTitle -notmatch 'Ctrl\+Shift\+B') { throw "Shortcut labels are not Windows ones: $($r.sessionsTitle)" }
Write-Host 'Start-up check passed'
