#Requires -Version 5.1
<#
.SYNOPSIS
  Free local scheduler companion: run this suite at fixed intervals.
.DESCRIPTION
  Runs the E2E suite headless with log rotation, then prints the scoreboard.
  Register it with Windows Task Scheduler for fully-free interval runs
  (machine must be on + unlocked enough for browsers; use "Run whether user
  is logged on or not" with stored credentials for overnight runs).

  Register daily 02:00 (elevated PowerShell once):
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
      -Argument "-NoProfile -File `"C:\Hyperzod_repo\hyperzod-ordering-e2e\scripts\nightly-run.ps1`" -Suite all"
    $trigger = New-ScheduledTaskTrigger -Daily -At 02:00
    Register-ScheduledTask -TaskName "OrderingE2E-Nightly" `
      -Action $action -Trigger $trigger -Description "Nightly ordering E2E"

  Unregister:
    Unregister-ScheduledTask -TaskName "OrderingE2E-Nightly" -Confirm:$false

  Suites: smoke | web | android | ios | mobile | all (default: smoke).
  Serial by design: projects share one test user and must never overlap.
.PARAMETER Suite
  Which npm suite to run.
.PARAMETER LogDir
  Where timestamped logs go (default: ./scheduled-logs).
#>
param(
	[ValidateSet("smoke", "web", "android", "ios", "mobile", "all")]
	[string]$Suite = "smoke",
	[string]$LogDir = (Join-Path $PSScriptRoot ".." "scheduled-logs")
)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory $LogDir | Out-Null }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $LogDir "$Suite-$stamp.log"
"[$stamp] suite=$Suite target=$($env:BASE_URL)" | Tee-Object $log

$scripts = @{
	smoke   = "npm run test:smoke"
	web     = "npm run test:web"
	android = "npm run test:android"
	ios     = "npm run test:ios"
	mobile  = "npm run test:mobile"
	all     = "npm run test:web; npm run test:android; npm run test:ios"
}

# One chain, strictly serial (shared user must never overlap with itself).
cmd /c "$($scripts[$Suite])" >> $log 2>&1
$code = $LASTEXITCODE

"--- scoreboard ---" | Tee-Object $log -Append
Select-String -Path $log -Pattern "^\s+\d+ (passed|failed|skipped)" |
	Select-Object -Last 6 | Tee-Object $log -Append
"exit=$code" | Tee-Object $log -Append

# Keep the last 30 logs; evidence beyond that lives in CI artifacts.
Get-ChildItem $LogDir -Filter *.log | Sort-Object LastWriteTime -Descending |
	Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue

exit $code
