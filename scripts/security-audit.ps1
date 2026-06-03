param(
  [string]$OutputPath = "$PSScriptRoot\..\output\security\security-audit-latest.json"
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path "$PSScriptRoot\.."
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$listeners = Get-NetTCPConnection -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess,
    @{Name = "ProcessName"; Expression = { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }}

$firewallProfiles = Get-NetFirewallProfile |
  Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction

$hardeningRules = Get-NetFirewallRule -Group "Facebook Agent Hardening" -ErrorAction SilentlyContinue |
  Select-Object DisplayName, Enabled, Direction, Action, Profile

$rdpConnections = Get-NetTCPConnection -LocalPort 3389 -State Established -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess

$agentProcesses = Get-Process node, wsl, wslrelay -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, Path, StartTime

$warnings = New-Object System.Collections.Generic.List[object]

function Test-HardeningRuleEnabled([string]$DisplayName) {
  return @(($hardeningRules | Where-Object { $_.DisplayName -eq $DisplayName -and $_.Enabled })).Count -gt 0
}

function Test-PortBlockedByHardening([int]$Port) {
  if ($Port -in @(135, 139, 445)) { return Test-HardeningRuleEnabled "FAH Block SMB RPC TCP" }
  if ($Port -in @(5357, 5358)) { return Test-HardeningRuleEnabled "FAH Block Device Discovery TCP" }
  if ($Port -ge 49152) { return Test-HardeningRuleEnabled "FAH Block Dynamic RPC TCP" }
  return $false
}

foreach ($listener in $listeners) {
  $address = [string]$listener.LocalAddress
  $port = [int]$listener.LocalPort
  $external = $address -notin @("127.0.0.1", "::1", "localhost")
  if (-not $external) { continue }

  if ($port -eq 9317) {
    $warnings.Add([pscustomobject]@{ severity = "critical"; port = $port; process = $listener.ProcessName; message = "Dashboard port exposed beyond localhost." })
  } elseif ($port -eq 3389) {
    $rdpAllowListed = Test-HardeningRuleEnabled "FAH Allow RDP From Approved IPs"
    $severity = if ($rdpAllowListed) { "low" } else { "high" }
    $message = if ($rdpAllowListed) {
      "RDP is restricted by the Facebook Agent Hardening allow-list rule."
    } else {
      "RDP listens externally with $(@($rdpConnections).Count) established connection(s). Restrict with firewall/VPN/MFA if remote admin is required."
    }
    $warnings.Add([pscustomobject]@{ severity = $severity; port = $port; process = $listener.ProcessName; message = $message })
  } elseif ($port -in @(135, 139, 445)) {
    if (Test-PortBlockedByHardening $port) {
      $warnings.Add([pscustomobject]@{ severity = "low"; port = $port; process = $listener.ProcessName; message = "Windows RPC/SMB-style service listens, but an inbound hardening block rule is active." })
    } else {
      $warnings.Add([pscustomobject]@{ severity = "high"; port = $port; process = $listener.ProcessName; message = "Windows RPC/SMB-style service listens externally. Restrict to trusted networks if not required." })
    }
  } elseif ($port -eq 5357 -or $port -ge 49152) {
    if (Test-PortBlockedByHardening $port) {
      $warnings.Add([pscustomobject]@{ severity = "low"; port = $port; process = $listener.ProcessName; message = "Windows service port listens, but an inbound hardening block rule is active." })
    } else {
      $warnings.Add([pscustomobject]@{ severity = "medium"; port = $port; process = $listener.ProcessName; message = "Windows service port listens externally. Review necessity and firewall scope." })
    }
  }
}

foreach ($profile in $firewallProfiles) {
  if (-not $profile.Enabled) {
    $warnings.Add([pscustomobject]@{ severity = "high"; profile = $profile.Name; message = "Windows Firewall profile is disabled." })
  }
}

$warningRows = @($warnings.ToArray()) | Sort-Object severity, port, profile, message -Unique

$report = [pscustomobject]@{
  at = (Get-Date).ToString("o")
  projectRoot = [string]$projectRoot
  dashboard = [pscustomobject]@{
    expectedUrl = "http://127.0.0.1:9317/"
    localOnly = @(($listeners | Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $_.LocalPort -eq 9317 })).Count -gt 0
  }
  warnings = @($warningRows)
  listeners = @($listeners)
  firewallProfiles = @($firewallProfiles)
  hardeningRules = @($hardeningRules)
  rdpConnections = @($rdpConnections | Select-Object LocalAddress, LocalPort, RemotePort, State, OwningProcess,
    @{Name = "RemoteAddress"; Expression = {
      $value = [string]$_.RemoteAddress
      if ($value -match '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') { "$($Matches[1]).$($Matches[2]).*.$($Matches[4])" } else { $value }
    }})
  agentProcesses = @($agentProcesses)
}

$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -Path $OutputPath
Write-Output $OutputPath
