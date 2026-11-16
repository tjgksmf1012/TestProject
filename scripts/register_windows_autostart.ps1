# Registers TeamFlow under its ordinary runtime account. -Boot requires elevation.
[CmdletBinding()]
param(
    [switch]$Boot,
    [string]$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
)

$ErrorActionPreference = 'Stop'
$taskName = 'TeamFlow-Server'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $root '.venv\Scripts\pythonw.exe'
$runner = Join-Path $PSScriptRoot 'run_windows_watchdog.py'
$db = Join-Path $root 'demo.db'
foreach ($path in @($python, $runner, $db)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing required file: $path" }
}

if ($Boot) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Boot installation requires an elevated PowerShell session.'
    }
}

$argument = '-X utf8 "' + $runner + '"'
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Count -ne 1 -or
        $existing.Actions[0].Execute -ne $python -or $existing.Actions[0].Arguments -ne $argument)) {
    throw "Existing task $taskName is owned by a different installation."
}

$mode = if ($Boot) { 'S4U' } else { 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType $mode -RunLevel Limited
$action = New-ScheduledTaskAction -Execute $python -Argument $argument -WorkingDirectory $root
$triggers = @(
    New-ScheduledTaskTrigger -AtLogOn -User $UserId
    New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1)
)
if ($Boot) { $triggers += New-ScheduledTaskTrigger -AtStartup }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description 'Start and recover TeamFlow on this PC.' -Force
