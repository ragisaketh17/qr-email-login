# Stop only this project's previous server and tunnel processes.
$processes = @(Get-CimInstance Win32_Process)
$projectCloudflared = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "cloudflared.exe"))
$tunnels = @($processes | Where-Object {
  $_.Name -eq "cloudflared.exe" -and
  $_.ExecutablePath -eq $projectCloudflared -and
  $_.CommandLine -like "*tunnel*--url*http://localhost:3000*"
})
$tunnelParentIds = @($tunnels | Select-Object -ExpandProperty ParentProcessId -Unique)

foreach ($listenerId in @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)) {
  $listener = $processes | Where-Object { $_.ProcessId -eq $listenerId }
  if (-not $listener -or $listener.Name -ne "node.exe" -or $listener.CommandLine -notmatch "server\.js") {
    continue
  }

  $parentProcessId = $listener.ParentProcessId
  while ($parentProcessId) {
    if ($tunnelParentIds -contains $parentProcessId) {
      Stop-Process -Id $listener.ProcessId -Force -ErrorAction SilentlyContinue
      break
    }
    $parent = $processes | Where-Object { $_.ProcessId -eq $parentProcessId }
    if (-not $parent) { break }
    $parentProcessId = $parent.ParentProcessId
  }
}

foreach ($tunnel in $tunnels) {
  Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue
}

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

# Prefer this project's configured password over a Windows user-level override.
$projectEnv = Join-Path $PSScriptRoot ".env"
if (Test-Path -LiteralPath $projectEnv) {
  $hasProjectPassword = Select-String -LiteralPath $projectEnv -Pattern '^\s*DASHBOARD_PASSWORD\s*=' -Quiet
  if ($hasProjectPassword) {
    Remove-Item Env:DASHBOARD_PASSWORD -ErrorAction SilentlyContinue
  }
}

try { npm start }
finally { Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue }