#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL as NodeURL } from 'node:url';
import { parseArgs } from 'node:util';
import { request as httpRequest } from 'node:http';

import { createMvpHttpClient } from './client.js';
import { bootstrapTerminalTaskSession } from './bootstrap-session.js';
import {
  OWNER,
  OWNER_MARKER_FILE,
  activeLeaseCount,
  defaultSessionFileFor,
  ensureParentDir,
  isBridgeIdleStatus,
  isMarkedProcessAlive,
  registerBridgeLease,
  resolvePluginSessionId,
  withBridgeMarkerLock,
} from './plugin-lease.mjs';

const DEFAULT_HOST = 'http://127.0.0.1:7791';

/**
 * Node-native fetch shim using http.request with explicit IPv4 host.
 * Avoids undici's IPv6/IPv4 dual-stack quirks against 127.0.0.1.
 * Retries once after 200ms on connection-level failures.
 */
function createNodeFetch() {
  return async function nodeFetch(urlStr, init = {}) {
    const url = new NodeURL(urlStr);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const host = isLocalhost ? '127.0.0.1' : url.hostname;
    const port = url.port ? Number(url.port) : 80;

    const doRequest = () => new Promise((resolveReq, rejectReq) => {
      const req = httpRequest(
        {
          host,
          port,
          path: url.pathname + url.search,
          method: init.method || 'GET',
          headers: init.headers || {},
          family: 4, // force IPv4
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolveReq({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              text: async () => text,
              json: async () => (text ? JSON.parse(text) : {}),
            });
          });
        },
      );
      req.on('error', rejectReq);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });

    try {
      return await doRequest();
    } catch (err) {
      // Retry once after 200ms — most undici/local-port flakes resolve on second try
      await new Promise((r) => setTimeout(r, 200));
      try {
        return await doRequest();
      } catch (err2) {
        const msg = err2?.message || String(err2);
        throw new Error(
          `fetch failed (likely an IPv6 resolution issue or the Bridge has exited); still failed after 1 retry: ${msg}. Verify directly with: curl ${urlStr}.`,
        );
      }
    }
  };
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string' },
    cwd: { type: 'string' },
    token: { type: 'string' },
    'task-id': { type: 'string' },
    tool: { type: 'string' },
    params: { type: 'string' },
    ok: { type: 'string' },
    output: { type: 'string' },
    error: { type: 'string' },
    'session-file': { type: 'string' },
    'session-id': { type: 'string' },
    target: { type: 'string' },
    timeout: { type: 'string' },
  },
});

const command = positionals[0] || 'help';
const sessionId = resolvePluginSessionId(values['session-id']);
const sessionFile = values['session-file']
  ? resolve(values['session-file'])
  : defaultSessionFileFor(sessionId);
const savedSession = loadSession(sessionFile);
const target = values.target || savedSession?.target || null;
const client = createMvpHttpClient({
  baseUrl: values.host || savedSession?.hostBaseUrl || DEFAULT_HOST,
  fetchImpl: createNodeFetch(),
});

try {
  switch (command) {
    case 'connect':
      await runConnect();
      break;
    case 'status':
      await runStatus();
      break;
    case 'start':
      await runStart();
      break;
    case 'claim':
      await runClaim();
      break;
    case 'task':
      await runTask();
      break;
    case 'call':
      await runCall();
      break;
    case 'complete':
      await runComplete();
      break;
    default:
      printHelp();
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        command,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || null,
        status: error?.status || null,
        data: error?.data || null,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

async function runConnect() {
  const response = await client.connectTerminal({
    name: values.name || savedSession?.terminal?.name || 'Codex',
    type: values.type || savedSession?.terminal?.type || 'codex',
    cwd: values.cwd || process.cwd(),
    sessionId,
  });

  await registerBridgeLease({
    sessionId,
    bridgeUrl: client.getBaseUrl(),
    startedByPlugin: false,
  });

  saveSession(sessionFile, {
    hostBaseUrl: client.getBaseUrl(),
    sessionId,
    target,
    token: response.token,
    terminal: response.terminal,
  });

  console.log(JSON.stringify(response, null, 2));
}

async function runStatus() {
  const response = await client.getStatus();
  console.log(
    JSON.stringify(
      {
        ok: true,
        hostBaseUrl: client.getBaseUrl(),
        sessionId,
        sessionFile,
        target,
        savedSession,
        status: response.status,
        terminals: response.terminals,
      },
      null,
      2,
    ),
  );
}

async function runStart() {
  const session = await bootstrapTerminalTaskSession({
    client,
    taskId: values['task-id'] || undefined,
    terminalName: values.name || savedSession?.terminal?.name || 'Codex',
    terminalType: values.type || savedSession?.terminal?.type || 'codex',
    cwd: values.cwd || process.cwd(),
    sessionId,
    target,
    timeoutMs: values.timeout ? Number(values.timeout) : 30000,
  });

  await registerBridgeLease({
    sessionId,
    bridgeUrl: client.getBaseUrl(),
    startedByPlugin: false,
  });

  saveSession(sessionFile, {
    ...loadSession(sessionFile),
    hostBaseUrl: client.getBaseUrl(),
    sessionId,
    target,
    token: session.token,
    terminal: session.terminal,
    lastTaskId: session.task?.id || savedSession?.lastTaskId || null,
  });

  console.log(JSON.stringify(session, null, 2));
}

async function runClaim() {
  const token = resolveToken();
  const response = await client.claimTask({
    token,
    taskId: values['task-id'],
  });

  if (response.task) {
    saveSession(sessionFile, {
      ...loadSession(sessionFile),
      hostBaseUrl: client.getBaseUrl(),
      sessionId,
      target,
      token,
      lastTaskId: response.task.id,
    });
  }

  console.log(JSON.stringify(response, null, 2));
}

async function runTask() {
  const taskId = values['task-id'] || savedSession?.lastTaskId;
  if (!taskId) {
    throw new Error('task-id is required when no last task exists in the saved session.');
  }

  const response = await client.getTask(taskId);
  console.log(JSON.stringify(response, null, 2));
}

async function runCall() {
  const tool = values.tool;
  if (!tool) {
    throw new Error('--tool is required.');
  }

  await registerLeaseForOnlineBridge();

  const params = values.params ? JSON.parse(values.params) : {};
  const response = await client.callBrowserTool({
    tool,
    params,
    source: savedSession?.terminal?.type || 'terminal',
    sessionId,
    target,
    timeoutMs: values.timeout ? Number(values.timeout) : 30000,
  });

  console.log(JSON.stringify(response, null, 2));
}

async function runComplete() {
  const token = resolveToken();
  const taskId = values['task-id'] || savedSession?.lastTaskId;
  if (!taskId) {
    throw new Error('--task-id is required when no last task exists in the saved session.');
  }

  const ok = parseBoolean(values.ok);
  const response = await client.completeTask({
    token,
    taskId,
    ok,
    output: values.output || '',
    error: values.error || '',
    sessionId,
  });

  saveSession(sessionFile, {
    ...loadSession(sessionFile),
    hostBaseUrl: client.getBaseUrl(),
    sessionId,
    target,
    token,
    lastTaskId: taskId,
  });

  console.log(JSON.stringify(response, null, 2));
  await autoStopOwnedBridge();
}

function resolveToken() {
  const token = values.token || savedSession?.token;
  if (!token) {
    throw new Error('No terminal token found. Run `connect` first or pass --token.');
  }
  return token;
}

function parseBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('--ok must be either true or false.');
}

function loadSession(fileUrl) {
  try {
    if (!existsSync(fileUrl)) return null;
    return JSON.parse(readFileSync(fileUrl, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(fileUrl, session) {
  ensureParentDir(fileUrl);
  writeFileSync(fileUrl, JSON.stringify(session, null, 2));
}

async function autoStopOwnedBridge() {
  const fetchImpl = createNodeFetch();
  const shutdownUrl = new NodeURL('/api/mvp/shutdown', client.getBaseUrl()).toString();
  const statusUrl = new NodeURL('/api/mvp/status', client.getBaseUrl()).toString();

  try {
    await withBridgeMarkerLock(async (marker) => {
      if (!marker || marker.owner !== OWNER) return marker;
      if (marker.bridgeUrl !== client.getBaseUrl()) return marker;

      delete marker.leases?.[sessionId];
      marker.updatedAt = new Date().toISOString();

      if (!isMarkedProcessAlive(marker)) return null;
      if (marker.startedByPlugin !== true) return marker;
      if (activeLeaseCount(marker) > 0) return marker;

      const statusResponse = await fetchImpl(statusUrl);
      if (!statusResponse.ok) return marker;
      const statusData = await statusResponse.json();
      if (!isBridgeIdleStatus(statusData.status)) return marker;

      marker.shutdownPending = true;
      const shutdownResponse = await fetchImpl(shutdownUrl, { method: 'POST' });
      if (!shutdownResponse.ok) {
        console.error(
          `AgentLimb bridge auto-stop failed: shutdown returned HTTP ${shutdownResponse.status}`,
        );
        marker.shutdownPending = false;
        return marker;
      }

      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        const online = await isBridgeOnline(fetchImpl, statusUrl);
        if (!online) {
          console.error('AgentLimb bridge auto-stopped because this plugin started it.');
          return null;
        }
      }

      console.error('AgentLimb bridge auto-stop timed out; bridge is still responding.');
      marker.shutdownPending = false;
      return marker;
    });
  } catch (error) {
    console.error(
      `AgentLimb bridge auto-stop failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function isBridgeOnline(fetchImpl, statusUrl) {
  try {
    const response = await fetchImpl(statusUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function registerLeaseForOnlineBridge() {
  try {
    await client.getStatus();
    await registerBridgeLease({
      sessionId,
      bridgeUrl: client.getBaseUrl(),
      startedByPlugin: false,
    });
  } catch {
    // Let the actual command surface the bridge connection error.
  }
}

function printHelp() {
  console.log(
    [
      'AgentLimb MVP terminal client',
      '',
      'Commands:',
      '  start    --name Codex --type codex --task-id task_xxx',
      '  connect  --name Codex --type codex',
      '  status   --session-id codex_xxx',
      '  claim    [--task-id task_xxx]',
      '  task     --task-id task_xxx',
      '  call     --session-id codex_xxx --target Profile-xxx --tool tabs_context --params \'{}\'',
      '  complete --session-id codex_xxx --task-id task_xxx --ok true --output "done"',
      '',
      `Session id: ${sessionId}`,
      `Session file: ${sessionFile}`,
      `Owner marker: ${OWNER_MARKER_FILE}`,
      `Host: ${client.getBaseUrl()}`,
    ].join('\n'),
  );
}
