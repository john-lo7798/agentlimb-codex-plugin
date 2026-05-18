import { parseArgs } from 'node:util';
import { request as httpRequest } from 'node:http';
import { URL as NodeURL } from 'node:url';

import {
  OWNER,
  activeLeaseCount,
  isBridgeIdleStatus,
  isMarkedProcessAlive,
  removeBridgeMarker,
  resolvePluginSessionId,
  withBridgeMarkerLock,
} from '../runtime/agentlimb-bridge/kernel/bridge/mvp/plugin-lease.mjs';

const bridgeUrl = 'http://127.0.0.1:7791';
const statusUrl = `${bridgeUrl}/api/mvp/status`;
const shutdownUrl = `${bridgeUrl}/api/mvp/shutdown`;
const releaseUrl = `${bridgeUrl}/api/mvp/sessions/release`;
const { values } = parseArgs({
  strict: false,
  options: {
    'owned-only': { type: 'boolean' },
    'session-id': { type: 'string' },
  },
});
const ownedOnly = values['owned-only'] === true;
const sessionId = resolvePluginSessionId(values['session-id']);

async function getStatus() {
  try {
    const response = await fetchLocal(statusUrl);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseSessionLocks() {
  try {
    await fetchLocal(releaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    // Bridge may already be offline; lease cleanup below is still useful.
  }
}

const status = await getStatus();
if (!status) {
  await withBridgeMarkerLock(() => null);
  console.log(`AgentLimb bridge is not online at ${bridgeUrl}.`);
  process.exit(0);
}

if (ownedOnly) {
  await releaseSessionLocks();

  let shouldStop = false;
  let staleMarker = false;
  let leaveReason = 'AgentLimb bridge was not started by this plugin; leaving it running.';
  await withBridgeMarkerLock(async (marker) => {
    if (!marker || marker.owner !== OWNER) return marker;

    delete marker.leases?.[sessionId];
    marker.updatedAt = new Date().toISOString();

    if (marker.bridgeUrl !== bridgeUrl || !isMarkedProcessAlive(marker)) {
      staleMarker = true;
      return null;
    }

    if (marker.startedByPlugin !== true) {
      leaveReason = 'AgentLimb bridge was already running before this plugin used it; leaving it running.';
      return marker;
    }

    if (activeLeaseCount(marker) > 0) {
      leaveReason = 'AgentLimb bridge still has active Codex leases; leaving it running.';
      return marker;
    }

    if (!isBridgeIdleStatus(status.status)) {
      leaveReason = 'AgentLimb bridge still has queued or claimed work; leaving it running.';
      return marker;
    }

    shouldStop = true;

    return marker;
  });

  if (staleMarker) {
    console.log('AgentLimb bridge owner marker is stale; leaving any current bridge running.');
    process.exit(0);
  }

  if (!shouldStop) {
    console.log(leaveReason);
    process.exit(0);
  }
}

await fetchLocal(shutdownUrl, { method: 'POST' });

let stopped = false;
for (let i = 0; i < 20; i += 1) {
  await sleep(500);
  if (!(await getStatus())) {
    removeBridgeMarker();
    console.log('AgentLimb bridge stopped.');
    stopped = true;
    break;
  }
}

if (!stopped) {
  console.error(`AgentLimb bridge shutdown was requested but it is still responding at ${bridgeUrl}.`);
  process.exitCode = 1;
}

function fetchLocal(urlStr, init = {}) {
  const url = new NodeURL(urlStr);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(url.port || 80),
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers: init.headers || {},
        family: 4,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => text,
            json: async () => (text ? JSON.parse(text) : {}),
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
