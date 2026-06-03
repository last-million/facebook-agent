param([int]$port)
$ErrorActionPreference='Continue'
foreach ($path in @('/json/version','/json/list')) {
  $url = "http://127.0.0.1:$port$path"
  Write-Host "TEST $url"
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
    Write-Host ('STATUS ' + $r.StatusCode)
    $r.Content.Substring(0, [Math]::Min(2000, $r.Content.Length))
  } catch {
    Write-Host ('FAILED ' + $_.Exception.Message)
  }
}
