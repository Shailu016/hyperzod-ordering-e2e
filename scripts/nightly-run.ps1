#Requires -Version 5.1
param(
    [ValidateSet('smoke','web','android','ios','mobile','all')][string]$Suite = 'smoke',
    [string]$LogDir = (Join-Path $PSScriptRoot '..\scheduled-logs')
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$logFile = Join-Path $LogDir "$Suite-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
# The Node runner owns the distributed lease, serial projects, evidence, and aggregate status.
& node (Join-Path $PSScriptRoot 'run-suite.js') $Suite *> $logFile
$suiteExitCode = $LASTEXITCODE
Get-Content -LiteralPath $logFile -Tail 25
exit $suiteExitCode
