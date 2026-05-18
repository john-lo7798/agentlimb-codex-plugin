import { closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

import {
  OWNER_MARKER_FILE,
  registerBridgeLease,
  resolvePluginSessionId,
} from '../runtime/agentlimb-bridge/kernel/bridge/mvp/plugin-lease.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(scriptDir);
const bridgeRoot = join(pluginRoot, 'runtime', 'agentlimb-bridge');
const serverPath = join(bridgeRoot, 'kernel', 'bridge', 'mvp', 'run-server.js');
const bridgeUrl = 'http://127.0.0.1:7791';
const statusUrl = `${bridgeUrl}/api/mvp/status`;
const stdoutLog = join(tmpdir(), 'agentlimb-bridge.log');
const stderrLog = join(tmpdir(), 'agentlimb-bridge.err.log');
const { values } = parseArgs({
  strict: false,
  options: {
    'session-id': { type: 'string' },
  },
});
const sessionId = resolvePluginSessionId(values['session-id']);

async function getStatus() {
  try {
    const response = await fetch(statusUrl);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const currentStatus = await getStatus();
if (currentStatus) {
  await registerBridgeLease({
    sessionId,
    bridgeUrl,
    startedByPlugin: false,
    bridgeRoot,
    serverPath,
  });
  const updatedStatus = await getStatus();
  console.log(`AgentLimb bridge already online at ${bridgeUrl}.`);
  console.log(`Session id: ${sessionId}`);
  console.log(`Owner marker: ${OWNER_MARKER_FILE}`);
  console.log(updatedStatus || currentStatus);
  process.exit(0);
}

const stdoutFd = openSync(stdoutLog, 'a');
const stderrFd = openSync(stderrLog, 'a');
const child = spawn(process.execPath, [serverPath], {
  cwd: bridgeRoot,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', stdoutFd, stderrFd],
});
child.unref();
closeSync(stdoutFd);
closeSync(stderrFd);

for (let i = 0; i < 20; i += 1) {
  await sleep(500);
  const status = await getStatus();
  if (status) {
    await registerBridgeLease({
      sessionId,
      bridgeUrl,
      startedByPlugin: true,
      pid: child.pid,
      bridgeRoot,
      serverPath,
      startedAt: new Date().toISOString(),
    });
    const updatedStatus = await getStatus();
    console.log(`AgentLimb bridge started at ${bridgeUrl}.`);
    console.log(`Session id: ${sessionId}`);
    console.log(`Logs: ${stdoutLog}, ${stderrLog}`);
    console.log(`Owner marker: ${OWNER_MARKER_FILE}`);
    console.log(updatedStatus || status);
    process.exit(0);
  }
}

console.error(`AgentLimb bridge did not become ready. Logs: ${stdoutLog}, ${stderrLog}`);
process.exit(1);
