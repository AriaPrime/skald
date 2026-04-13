# Skald Dashboard
# Opens the live dashboard. If the daemon isn't running, starts it.

$port = 18803
$skald = "C:\Users\ARIA_PRIME\vessel-src\apps\skald\dist\index.js"

# Check if daemon is running
$running = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$port/api/stats" -TimeoutSec 2 -ErrorAction Stop
    $running = $true
} catch {}

if (-not $running) {
    # Start daemon in background
    $env:OPENAI_API_KEY = (Get-Content "C:\Users\ARIA_PRIME\vessel\credentials\openai-vessel.json" | ConvertFrom-Json).key
    Start-Process -NoNewWindow -FilePath "node" -ArgumentList "$skald daemon --port $port"
    Start-Sleep -Seconds 2
}

# Open browser
Start-Process "http://localhost:$port"
