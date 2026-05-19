import { appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
const startupGraceMs = Number(process.env.AGENTLIMB_BRIDGE_STARTUP_GRACE_MS || 5000);
const { values } = parseArgs({
  strict: false,
  options: {
    'session-id': { type: 'string' },
  },
});
const sessionId = resolvePluginSessionId(values['session-id']);

async function getStatus() {
  try {
    const response = await fetchLocal(statusUrl);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function appendStartupError(message) {
  try {
    appendFileSync(
      stderrLog,
      `[${new Date().toISOString()}] [agentlimb start] ${message}\n`,
    );
  } catch {
    // Startup diagnostics are best effort only.
  }
}

function formatChildExit(exitInfo) {
  if (!exitInfo) return 'not reported';
  const code = exitInfo.code === null ? 'null' : String(exitInfo.code);
  const signal = exitInfo.signal === null ? 'null' : String(exitInfo.signal);
  return `code=${code}, signal=${signal}`;
}

function createBridgeEnv() {
  return {
    ...process.env,
    AGENTLIMB_BRIDGE_LOG: stdoutLog,
    AGENTLIMB_BRIDGE_ERR_LOG: stderrLog,
  };
}

function launchBridgeProcess() {
  const env = createBridgeEnv();
  if (process.platform === 'win32') return launchWindowsBridge(env);

  const launched = {
    method: 'node detached spawn',
    pid: null,
    exitInfo: null,
    spawnError: null,
  };

  const child = spawn(process.execPath, [serverPath], {
    cwd: bridgeRoot,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env,
  });

  launched.pid = child.pid;
  child.once('error', (error) => {
    launched.spawnError = error;
    appendStartupError(`Bridge process spawn failed: ${error.message}`);
  });
  child.once('exit', (code, signal) => {
    launched.exitInfo = { code, signal };
    appendStartupError(
      `Bridge process exited during startup: ${formatChildExit(launched.exitInfo)}`,
    );
  });
  child.unref();

  return launched;
}

function launchWindowsBridge(env) {
  const command = [
    `$p = Start-Process -FilePath ${quotePowerShell(process.execPath)} ` +
      `-ArgumentList ${quotePowerShell(quoteWindowsArgument(serverPath))} ` +
      `-WorkingDirectory ${quotePowerShell(bridgeRoot)} ` +
      '-WindowStyle Hidden -PassThru',
    'Write-Output $p.Id',
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    {
      cwd: bridgeRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(message || `powershell.exe exited with code ${result.status}`);
  }

  const pid = Number(String(result.stdout || '').trim().split(/\s+/).pop());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Could not determine Bridge pid from Start-Process output: ${result.stdout || ''}`);
  }

  return {
    method: 'PowerShell Start-Process',
    pid,
    exitInfo: null,
    spawnError: null,
  };
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteWindowsArgument(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
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

let launched;
try {
  launched = launchBridgeProcess();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  appendStartupError(`Bridge process launch failed: ${message}`);
  console.error(`AgentLimb bridge failed to launch: ${message}. Logs: ${stdoutLog}, ${stderrLog}`);
  process.exit(1);
}

for (let i = 0; i < 20; i += 1) {
  await sleep(500);
  if (launched.spawnError) break;
  const status = await getStatus();
  if (status) {
    await sleep(startupGraceMs);
    const survivedStatus = await getStatus();
    const childAlive = isProcessAlive(launched.pid);

    if (!survivedStatus || !childAlive) {
      appendStartupError(
        [
          'Bridge responded once but did not survive startup grace check.',
          `method=${launched.method}.`,
          `pid=${launched.pid || 'unknown'}.`,
          `alive=${childAlive}.`,
          `exit=${formatChildExit(launched.exitInfo)}.`,
        ].join(' '),
      );
      console.error(`AgentLimb bridge responded once but exited before startup completed at ${bridgeUrl}.`);
      console.error(`Process id: ${launched.pid || 'unknown'}; alive: ${childAlive ? 'yes' : 'no'}; exit: ${formatChildExit(launched.exitInfo)}.`);
      console.error('This may be caused by local sandbox/background process restrictions or a Node startup crash.');
      console.error(`Logs: ${stdoutLog}, ${stderrLog}`);
      process.exit(1);
    }

    await registerBridgeLease({
      sessionId,
      bridgeUrl,
      startedByPlugin: true,
      pid: launched.pid,
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

if (launched.spawnError) {
  console.error(`AgentLimb bridge failed to spawn: ${launched.spawnError.message}. Logs: ${stdoutLog}, ${stderrLog}`);
  process.exit(1);
}

console.error(`AgentLimb bridge did not become ready. Logs: ${stdoutLog}, ${stderrLog}`);
process.exit(1);
