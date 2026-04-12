# Skald Live Dashboard
# Starts the live dashboard server and opens it in the browser

$env:OPENAI_API_KEY = (Get-Content "C:\Users\ARIA_PRIME\vessel\credentials\openai-vessel.json" | ConvertFrom-Json).key
$skald = "C:\Users\ARIA_PRIME\vessel-src\apps\skald\dist\index.js"
$port = 18803

# Check if already running
$existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($existing) {
    # Already running, just open browser
    Start-Process "http://localhost:$port"
    exit
}

# Start server in background
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "$skald live --port $port"

# Wait briefly for server to start, then open browser
Start-Sleep -Seconds 1
Start-Process "http://localhost:$port"
