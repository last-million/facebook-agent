param(
  [switch]$ApplyNonRdp,
  [string[]]$AllowRdpFrom = @(),
  [switch]$Rollback
)

$ErrorActionPreference = "Stop"

$group = "Facebook Agent Hardening"
$nonRdpRules = @(
  @{
    Name = "FAH Block SMB RPC TCP"
    Protocol = "TCP"
    LocalPort = @("135", "139", "445")
    Description = "Block inbound Windows RPC/NetBIOS/SMB from external networks."
  },
  @{
    Name = "FAH Block Device Discovery TCP"
    Protocol = "TCP"
    LocalPort = @("5357", "5358")
    Description = "Block inbound Windows Web Services device discovery."
  },
  @{
    Name = "FAH Block Dynamic RPC TCP"
    Protocol = "TCP"
    LocalPort = @("49152-65535")
    Description = "Block inbound Windows dynamic RPC service ports from external networks."
  },
  @{
    Name = "FAH Block NetBIOS UDP"
    Protocol = "UDP"
    LocalPort = @("137", "138")
    Description = "Block inbound NetBIOS discovery/datagram traffic."
  },
  @{
    Name = "FAH Block Discovery UDP"
    Protocol = "UDP"
    LocalPort = @("3702", "5355", "5357", "5358")
    Description = "Block inbound WS-Discovery, LLMNR, and device discovery traffic."
  }
)

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session."
  }
}

function Remove-HardeningRules {
  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

function New-BlockRule($rule) {
  $existing = Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq $rule.Name }
  if ($existing) { $existing | Remove-NetFirewallRule }
  New-NetFirewallRule `
    -DisplayName $rule.Name `
    -Group $group `
    -Direction Inbound `
    -Action Block `
    -Enabled True `
    -Profile Any `
    -Protocol $rule.Protocol `
    -LocalPort $rule.LocalPort `
    -Description $rule.Description | Out-Null
}

function Set-RdpAllowList($remoteAddresses) {
  $clean = @($remoteAddresses | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^[0-9a-fA-F:\.]+(/\d{1,3})?$' } | Sort-Object -Unique)
  if (-not $clean.Count) {
    throw "AllowRdpFrom is empty or invalid. Refusing to change RDP rules."
  }

  $existing = Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "FAH Allow RDP From Approved IPs" }
  if ($existing) { $existing | Remove-NetFirewallRule }

  Get-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" } |
    Disable-NetFirewallRule

  New-NetFirewallRule `
    -DisplayName "FAH Allow RDP From Approved IPs" `
    -Group $group `
    -Direction Inbound `
    -Action Allow `
    -Enabled True `
    -Profile Any `
    -Protocol TCP `
    -LocalPort 3389 `
    -RemoteAddress $clean `
    -Description "Allow RDP only from operator-approved public IPs." | Out-Null
}

Assert-Administrator

if ($Rollback) {
  Remove-HardeningRules
  Write-Output "Removed firewall rules in group '$group'. Existing Windows rules were not otherwise changed."
  exit 0
}

if ($ApplyNonRdp) {
  foreach ($rule in $nonRdpRules) {
    New-BlockRule $rule
  }
}

if ($AllowRdpFrom.Count) {
  Set-RdpAllowList $AllowRdpFrom
}

$summary = [pscustomobject]@{
  at = (Get-Date).ToString("o")
  group = $group
  appliedNonRdp = [bool]$ApplyNonRdp
  rdpAllowList = @($AllowRdpFrom)
  activeRules = @(Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue |
    Select-Object DisplayName, Enabled, Direction, Action, Profile)
}

$summary | ConvertTo-Json -Depth 6
