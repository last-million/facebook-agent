param(
  [Parameter(Mandatory = $true)]
  [string]$ProfileId,

  [string]$SourceUrl = "",

  [switch]$CaptureOnly,

  [string]$DashboardUrl = "http://127.0.0.1:9317"
)

$ErrorActionPreference = "Stop"

function Get-DashboardToken {
  param([string]$BaseUrl)
  $html = (Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/" -TimeoutSec 10).Content
  $match = [regex]::Match($html, '<meta name="dashboard-token" content="([a-f0-9]+)"')
  if (-not $match.Success) {
    throw "Could not read dashboard token from $BaseUrl. Is the dashboard running?"
  }
  return $match.Groups[1].Value
}

if (-not $CaptureOnly -and -not $SourceUrl.Trim()) {
  throw "SourceUrl is required unless -CaptureOnly is used."
}

$token = Get-DashboardToken -BaseUrl $DashboardUrl.TrimEnd("/")
$body = @{
  profileId = $ProfileId
  sourceUrl = $SourceUrl
  captureOnly = [bool]$CaptureOnly
} | ConvertTo-Json -Compress

try {
  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -Method POST `
    -Uri "$($DashboardUrl.TrimEnd('/'))/api/products/discover-browser" `
    -Headers @{ "x-dashboard-token" = $token } `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 90

  $response.Content
} catch {
  $resp = $_.Exception.Response
  if (-not $resp) { throw }
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  $content = $reader.ReadToEnd()
  Write-Output $content
  exit ([int]$resp.StatusCode)
}
