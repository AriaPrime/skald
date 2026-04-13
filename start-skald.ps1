# Start Skald Daemon
# Run as a Windows scheduled task for always-on operation.
#
# To register:
#   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Users\ARIA_PRIME\vessel-src\apps\skald\start-skald.ps1"
#   $trigger = New-ScheduledTaskTrigger -AtLogon
#   Register-ScheduledTask -TaskName "SKALD" -Action $action -Trigger $trigger -RunLevel Highest -Description "Skald Spec Index Daemon"

$env:OPENAI_API_KEY = (Get-Content "C:\Users\ARIA_PRIME\vessel\credentials\openai-vessel.json" | ConvertFrom-Json).key

$skald = "C:\Users\ARIA_PRIME\vessel-src\apps\skald\dist\index.js"
$logDir = "C:\Users\ARIA_PRIME\vessel\data\logs"
$date = Get-Date -Format "yyyy-MM-dd"
$logFile = "$logDir\skald-$date.log"

# Ensure log directory exists
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Start daemon with output redirected to log file
node $skald daemon 2>&1 | Tee-Object -FilePath $logFile -Append
