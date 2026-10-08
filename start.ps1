# Starts the tunnel, finds its link, then starts the server with that link.
$log = Join-Path $PSScriptRoot "tunnel.log"
Remove-Item $log, "$log.out" -ErrorAction SilentlyContinue

$tunnel = Start-Process -FilePath (Join-Path $PSScriptRoot "cloudflared.exe") `
  -ArgumentList "tunnel", "--url", "http://localhost:3000" `
  -RedirectStandardError $log -RedirectStandardOutput "$log.out" `
  -WindowStyle Hidden -PassThru

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $match = Select-String -Path $log -Pattern 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com' |
      Select-Object -First 1
    if ($match) { $url = $match.Matches[0].Value }
  }
}

if (-not $url) {
  Write-Host "Could not find the tunnel link. Check your internet and try again."
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  exit 1
}

Write-Host "Tunnel link: $url"
$env:PUBLIC_URL = $url

try { npm start }
finally { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }