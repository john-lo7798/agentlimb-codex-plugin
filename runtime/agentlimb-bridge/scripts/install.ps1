[CmdletBinding()]
param(
  [string]$ExtensionId = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$ServerPath = Join-Path $ProjectRoot "kernel\bridge\mvp\run-server.js"
$CliPath = Join-Path $ProjectRoot "bin\agentlimb.mjs"
$NativeHostPath = Join-Path $ProjectRoot "bin\native-host.mjs"

$AgentHome = Join-Path $HOME ".agentlimb"
$BinDir = Join-Path $AgentHome "bin"
$NativeDir = Join-Path $env:LOCALAPPDATA "AgentLimb\NativeMessaging"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
New-Item -ItemType Directory -Force -Path $NativeDir | Out-Null

$AgentCmd = Join-Path $BinDir "agentlimb.cmd"
$NativeCmd = Join-Path $BinDir "agentlimb-native-host.cmd"
$NativeManifest = Join-Path $NativeDir "com.agentlimb.bridge.json"

@"
@echo off
"$Node" "$CliPath" %*
"@ | Set-Content -Path $AgentCmd -Encoding ASCII

@"
@echo off
"$Node" "$NativeHostPath"
"@ | Set-Content -Path $NativeCmd -Encoding ASCII

$origins = @("chrome-extension://hldldfepjhljhbcneojddjkkodkjglof/")
if ($ExtensionId.Trim()) {
  $origins += "chrome-extension://$($ExtensionId.Trim())/"
}
$origins = $origins | Select-Object -Unique

$manifest = [ordered]@{
  name = "com.agentlimb.bridge"
  description = "AgentLimb local bridge companion"
  path = $NativeCmd
  type = "stdio"
  allowed_origins = $origins
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $NativeManifest -Encoding UTF8

$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.agentlimb.bridge"
New-Item -Path $RegPath -Force | Out-Null
Set-Item -Path $RegPath -Value $NativeManifest

$TaskName = "AgentLimb Bridge"
$Action = New-ScheduledTaskAction -Execute $Node -Argument "`"$ServerPath`"" -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "AgentLimb local browser bridge on 127.0.0.1:7791" `
  -Force | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
}

Write-Host "AgentLimb Bridge installed."
Write-Host "Project: $ProjectRoot"
Write-Host "CLI: $AgentCmd"
Write-Host "Native host manifest: $NativeManifest"
Write-Host "Scheduled task: $TaskName"

try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:7791/api/mvp/status" -TimeoutSec 3
  Write-Host "Bridge status: online ($($status.host.baseUrl))"
} catch {
  Write-Host "Bridge status: not reachable yet. Start it with: Start-ScheduledTask -TaskName `"$TaskName`""
}

if (-not $ExtensionId.Trim()) {
  Write-Host ""
  Write-Host "If you loaded the extension unpacked, rerun with its chrome://extensions ID:"
  Write-Host ".\scripts\install.ps1 -ExtensionId <your-extension-id>"
}
