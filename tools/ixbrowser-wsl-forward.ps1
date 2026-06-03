param([string]$method, [string]$url)
$ErrorActionPreference = 'Stop'
$body = [Console]::In.ReadToEnd()
try {
  if ($method -eq 'GET' -or $method -eq 'HEAD') {
    $r = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $url -TimeoutSec 60
  } else {
    $r = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $url -ContentType 'application/json' -Body $body -TimeoutSec 120
  }
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$r.Content))
  [Console]::Out.WriteLine(('__IX_STATUS__' + [int]$r.StatusCode))
  [Console]::Out.WriteLine('__IX_BODY_BASE64__' + $payload)
} catch {
  $status = 502
  try {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $status = [int]$_.Exception.Response.StatusCode }
  } catch {}
  $msg = @{ error = @{ code = $status; message = $_.Exception.Message; relay = 'ixbrowser-wsl-relay' } } | ConvertTo-Json -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($msg))
  [Console]::Out.WriteLine(('__IX_STATUS__' + $status))
  [Console]::Out.WriteLine('__IX_BODY_BASE64__' + $payload)
}
