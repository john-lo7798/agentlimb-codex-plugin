$ErrorActionPreference = 'Stop'

$bridgeUrl = 'http://127.0.0.1:7791'
$statusUrl = "$bridgeUrl/api/mvp/status"

try {
  $response = Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 3
  Write-Output $response.Content
  exit 0
} catch {
  Write-Output "AgentLimb bridge is not online at $bridgeUrl. $($_.Exception.Message)"
  exit 1
}
