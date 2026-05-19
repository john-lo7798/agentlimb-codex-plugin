import {
  OWNER_MARKER_FILE,
  activeLeaseCount,
  isMarkedProcessAlive,
  loadBridgeMarker,
} from '../runtime/agentlimb-bridge/kernel/bridge/mvp/plugin-lease.mjs';

const bridgeUrl = 'http://127.0.0.1:7791';

try {
  const response = await fetch(`${bridgeUrl}/api/mvp/status`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  console.log(await response.text());
  reportStaleOwnerMarker();
} catch (error) {
  console.log(`AgentLimb bridge is not online at ${bridgeUrl}. ${error.message}`);
  reportStaleOwnerMarker();
  process.exit(1);
}

function reportStaleOwnerMarker() {
  const marker = loadBridgeMarker();
  if (!marker || marker.startedByPlugin !== true || !marker.pid) return;
  if (isMarkedProcessAlive(marker)) return;

  console.log(`AgentLimb bridge owner marker is stale: recorded pid ${marker.pid} is not alive.`);
  console.log(`Owner marker: ${OWNER_MARKER_FILE}`);
  console.log(`Active leases in marker: ${activeLeaseCount(marker)}`);
}
