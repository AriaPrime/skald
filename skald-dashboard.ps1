# Skald Dashboard Launcher
# Generates fresh dashboard from index and opens in browser

$env:OPENAI_API_KEY = (Get-Content "C:\Users\ARIA_PRIME\vessel\credentials\openai-vessel.json" | ConvertFrom-Json).key
$skald = "C:\Users\ARIA_PRIME\vessel-src\apps\skald\dist\index.js"

# Generate dashboard
node $skald dashboard --out "C:\Users\ARIA_PRIME\vessel\data\skald-dashboard.html"

# Open in default browser
Start-Process "C:\Users\ARIA_PRIME\vessel\data\skald-dashboard.html"
