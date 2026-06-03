param(
  [string]$SourceUrl = "",

  [switch]$AllowBrowser,

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

function Invoke-DashboardJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null
  )

  $params = @{
    UseBasicParsing = $true
    Method = $Method
    Uri = "$($script:BaseUrl)$Path"
    Headers = @{ "x-dashboard-token" = $script:Token }
    TimeoutSec = 180
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 60 -Compress)
  }
  $response = Invoke-WebRequest @params
  if (-not $response.Content) { return $null }
  return $response.Content | ConvertFrom-Json
}

function First-Line {
  param([string]$Value)
  return @($Value -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") } | Select-Object -First 1)[0]
}

$script:BaseUrl = $DashboardUrl.TrimEnd("/")
$script:Token = Get-DashboardToken -BaseUrl $script:BaseUrl

$direct = $null
if (-not $CaptureOnly) {
  $direct = Invoke-DashboardJson -Method "POST" -Path "/api/products/discover"
  if ([int]($direct.discovered | ForEach-Object { $_ }) -gt 0) {
    [pscustomobject]@{
      status = "direct_discovery_saved"
      discovered = [int]$direct.discovered
      parser = $direct.parser
      file = $direct.file
      direct = $direct
      browser = $null
    } | ConvertTo-Json -Depth 80
    exit 0
  }
}

if (-not $AllowBrowser) {
  [pscustomobject]@{
    status = "direct_discovery_blocked"
    discovered = 0
    message = "Direct Walmart filter extraction did not save product URLs. Re-run with -AllowBrowser to use the local browser flow."
    direct = $direct
    browser = $null
  } | ConvertTo-Json -Depth 80
  exit 0
}

$stateResponse = Invoke-DashboardJson -Method "GET" -Path "/api/state"
$state = $stateResponse.state
$state.operator.armedForExternalActions = $true
$state.operator.approvalRequired = $true
$state.operator.autopilotEnabled = $false
Invoke-DashboardJson -Method "PUT" -Path "/api/state" -Body @{ state = $state } | Out-Null

try {
  $browserSource = $SourceUrl.Trim()
  if (-not $browserSource) {
    $browserSource = First-Line -Value ([string]$state.productDiscovery.generatedSourceUrls)
  }
  if (-not $browserSource) {
    throw "No Walmart generated source URL is configured."
  }

  $browser = Invoke-DashboardJson -Method "POST" -Path "/api/products/discover-local-browser" -Body @{
    sourceUrl = $browserSource
    captureOnly = [bool]$CaptureOnly
    closeBrowserAfterUse = $true
  }

  [pscustomobject]@{
    status = if ($browser.status) { $browser.status } else { "browser_discovery_finished" }
    discovered = [int]($browser.discovered | ForEach-Object { $_ })
    reviewImageCandidates = [int]($browser.reviewImageCandidates | ForEach-Object { $_ })
    sourceUrl = $browserSource
    localBrowserClose = $browser.localBrowserClose
    direct = $direct
    browser = $browser
  } | ConvertTo-Json -Depth 100
} finally {
  $latest = Invoke-DashboardJson -Method "GET" -Path "/api/state"
  $restore = $latest.state
  $restore.operator.armedForExternalActions = $false
  $restore.operator.approvalRequired = $true
  $restore.operator.autopilotEnabled = $false
  Invoke-DashboardJson -Method "PUT" -Path "/api/state" -Body @{ state = $restore } | Out-Null
}
