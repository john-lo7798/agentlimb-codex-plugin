#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';

import { bootstrapTerminalTaskSession } from '../kernel/bridge/mvp/bootstrap-session.js';
import { createMvpHttpClient } from '../kernel/bridge/mvp/client.js';
import {
  OWNER,
  OWNER_MARKER_FILE,
  activeLeaseCount,
  isBridgeIdleStatus,
  isMarkedProcessAlive,
  loadBridgeMarker,
  registerBridgeLease,
  resolvePluginSessionId,
  withBridgeMarkerLock,
} from '../kernel/bridge/mvp/plugin-lease.mjs';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const BRIDGE_URL = 'http://127.0.0.1:7791';
const STATUS_URL = `${BRIDGE_URL}/api/mvp/status`;
const SHUTDOWN_URL = `${BRIDGE_URL}/api/mvp/shutdown`;
const STARTUP_GRACE_MS = Number(process.env.AGENTLIMB_BRIDGE_STARTUP_GRACE_MS || 5000);
const MCP_LOG = join(tmpdir(), 'agentlimb-mcp.log');
const BRIDGE_LOG = join(tmpdir(), 'agentlimb-bridge.log');
const BRIDGE_ERR_LOG = join(tmpdir(), 'agentlimb-bridge.err.log');

const mcpDir = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = dirname(mcpDir);
const serverPath = join(bridgeRoot, 'kernel', 'bridge', 'mvp', 'run-server.js');
const sessions = new Map();
const leasedSessionIds = new Set();
const bridge = {
  child: null,
  ownedByThisServer: false,
  pid: null,
  starting: null,
  stopping: null,
  exitInfo: null,
};
const client = createMvpHttpClient({
  baseUrl: BRIDGE_URL,
  fetchImpl: createNodeFetch(),
});

let inputBuffer = Buffer.alloc(0);
let shuttingDown = false;

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  readBufferedMessages();
});
process.stdin.on('end', () => {
  void exitAfterCleanup(0);
});
process.on('SIGINT', () => {
  void exitAfterCleanup(0);
});
process.on('SIGTERM', () => {
  void exitAfterCleanup(0);
});
process.on('exit', () => {
  if (bridge.ownedByThisServer && bridge.child && bridge.child.exitCode == null) {
    appendMcpLog(
      'MCP process exiting while owned Bridge child is still alive; leaving it running for lease/idle safety.',
    );
  }
});

function readBufferedMessages() {
  while (inputBuffer.length > 0) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    const maybeFramed = inputBuffer
      .slice(0, Math.min(inputBuffer.length, 32))
      .toString('utf8')
      .toLowerCase()
      .startsWith('content-length:');
    if (maybeFramed && headerEnd < 0) return;

    if (headerEnd >= 0) {
      const header = inputBuffer.slice(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        inputBuffer = inputBuffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (inputBuffer.length < bodyEnd) return;
      const body = inputBuffer.slice(bodyStart, bodyEnd).toString('utf8');
      inputBuffer = inputBuffer.slice(bodyEnd);
      handleRawMessage(body);
      continue;
    }

    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) return;
    const line = inputBuffer.slice(0, newline).toString('utf8').trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line) handleRawMessage(line);
  }
}

function handleRawMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    sendJsonRpcError(null, -32700, 'Parse error', formatError(error));
    return;
  }

  if (message.id == null) {
    if (message.method === 'notifications/cancelled') {
      return;
    }
    return;
  }

  void handleJsonRpcRequest(message)
    .then((result) => {
      sendJsonRpcResult(message.id, result);
    })
    .catch((error) => {
      if (error instanceof JsonRpcError) {
        sendJsonRpcError(message.id, error.code, error.message, error.data);
        return;
      }
      sendJsonRpcError(
        message.id,
        -32603,
        error instanceof Error ? error.message : String(error),
        error?.data || null,
      );
    });
}

async function handleJsonRpcRequest(message) {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'agentlimb',
          version: '0.1.4',
        },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOL_DEFINITIONS };
    case 'tools/call':
      return callMcpTool(message.params || {});
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new JsonRpcError(-32601, `Method not found: ${message.method}`);
  }
}

async function callMcpTool(params) {
  const name = String(params.name || '').trim();
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

  try {
    switch (name) {
      case 'agentlimb_status':
        return toolResult(await agentlimbStatus(args));
      case 'agentlimb_start':
        return toolResult(await agentlimbStart(args));
      case 'agentlimb_call':
        return toolResult(await agentlimbCall(args));
      case 'agentlimb_finish':
        return toolResult(await agentlimbFinish(args));
      case 'agentlimb_abort':
        return toolResult(await agentlimbAbort(args));
      default:
        return toolResult({ ok: false, error: `Unknown tool: ${name}` }, true);
    }
  } catch (error) {
    return toolResult(
      {
        ok: false,
        tool: name,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || null,
        data: error?.data || null,
      },
      true,
    );
  }
}

async function agentlimbStatus(args = {}) {
  const sessionId = resolvePluginSessionId(args.sessionId);
  const status = await getStatusQuiet();
  const marker = loadBridgeMarker();
  const staleOwnerMarker =
    !status &&
    marker?.owner === OWNER &&
    marker.startedByPlugin === true &&
    !isMarkedProcessAlive(marker);

  return {
    ok: true,
    online: Boolean(status),
    bridgeUrl: BRIDGE_URL,
    sessionId,
    target: normalizeOptionalString(args.target),
    mcp: {
      ownsBridge: bridge.ownedByThisServer,
      pid: bridge.pid || null,
      childExit: bridge.exitInfo || null,
    },
    ownerMarker: marker,
    staleOwnerMarker,
    status,
  };
}

async function agentlimbStart(args = {}) {
  const sessionId = resolvePluginSessionId(args.sessionId);
  const target = normalizeOptionalString(args.target);

  await ensureBridgeOnline({ sessionId });

  const session = await bootstrapTerminalTaskSession({
    client,
    taskId: normalizeOptionalString(args.taskId) || undefined,
    terminalName: normalizeOptionalString(args.name) || 'Codex',
    terminalType: normalizeOptionalString(args.type) || 'codex',
    cwd: process.cwd(),
    sessionId,
    target,
    timeoutMs: Number(args.timeoutMs || 30000),
  });

  await registerTrackedBridgeLease({
    sessionId,
    bridgeUrl: BRIDGE_URL,
    startedByPlugin: bridge.ownedByThisServer,
    pid: bridge.ownedByThisServer ? bridge.pid : null,
    bridgeRoot,
    serverPath,
  });

  sessions.set(sessionId, {
    sessionId,
    target,
    token: session.token,
    terminal: session.terminal,
    taskId: session.task?.id || null,
    startedAt: new Date().toISOString(),
  });

  return {
    ok: session.ok !== false,
    extensionOffline: session.extensionOffline === true,
    error: session.error || null,
    sessionId,
    target,
    taskId: session.task?.id || null,
    bridge: {
      url: BRIDGE_URL,
      ownedByMcp: bridge.ownedByThisServer,
      pid: bridge.pid || null,
    },
    terminal: session.terminal,
    browserBootstrap: session.browserBootstrap,
  };
}

async function agentlimbCall(args = {}) {
  const sessionId = requireSessionId(args.sessionId);
  const tool = requireString(args.tool, 'tool');
  const target = normalizeOptionalString(args.target) || sessions.get(sessionId)?.target || null;

  await ensureBridgeOnline({ sessionId });
  await registerTrackedBridgeLease({
    sessionId,
    bridgeUrl: BRIDGE_URL,
    startedByPlugin: bridge.ownedByThisServer,
    pid: bridge.ownedByThisServer ? bridge.pid : null,
    bridgeRoot,
    serverPath,
  });

  const response = await client.callBrowserTool({
    tool,
    params: normalizeObject(args.params),
    source: 'mcp',
    sessionId,
    target,
    timeoutMs: Number(args.timeoutMs || 30000),
  });

  if (sessions.has(sessionId) && target) {
    sessions.get(sessionId).target = target;
  }

  return {
    ok: response.completed?.call?.status === 'completed',
    sessionId,
    target,
    tool,
    submitted: response.submitted,
    completed: response.completed,
  };
}

async function agentlimbFinish(args = {}) {
  const sessionId = requireSessionId(args.sessionId);
  const state = requireStartedSession(sessionId);
  const ok = args.ok !== false;
  const target = normalizeOptionalString(args.target) || state.target || null;
  const taskId = normalizeOptionalString(args.taskId) || state.taskId;
  if (!taskId) throw new Error('taskId is required; run agentlimb_start first or pass taskId.');

  const summary = normalizeOptionalString(args.summary) || (ok ? 'AgentLimb task completed.' : 'AgentLimb task failed.');
  const muscleStatus =
    normalizeOptionalString(args.muscleStatus) ||
    (ok ? 'success' : 'failed');
  const verification = normalizeOptionalString(args.verification) || summary;
  const steps = {};

  steps.muscleCommit = await commitMuscle({
    sessionId,
    target,
    status: muscleStatus,
    verification,
    note: normalizeOptionalString(args.note) || summary,
  });

  steps.taskState = await callBrowserToolAllowFailure({
    sessionId,
    target,
    tool: ok ? 'task_complete' : 'task_fail',
    params: ok
      ? { summary }
      : { reason: summary, stepIndex: Number(args.stepIndex || 0) },
    timeoutMs: Number(args.timeoutMs || 30000),
  });

  const completedTask = await client.completeTask({
    token: state.token,
    taskId,
    ok,
    output: ok ? summary : '',
    error: ok ? '' : summary,
    sessionId,
  });

  sessions.delete(sessionId);
  const stopResult = await stopOwnedBridgeIfIdle({ sessionId });
  const finishedOk =
    browserCallSucceeded(steps.muscleCommit) &&
    browserCallSucceeded(steps.taskState) &&
    completedTask?.ok !== false;

  return {
    ok: finishedOk,
    sessionId,
    target,
    taskId,
    completedTask,
    steps,
    stopResult,
  };
}

async function agentlimbAbort(args = {}) {
  const sessionId = requireSessionId(args.sessionId);
  const state = sessions.get(sessionId);
  const target = normalizeOptionalString(args.target) || state?.target || null;
  const reason = normalizeOptionalString(args.reason) || 'AgentLimb task aborted.';
  const taskId = normalizeOptionalString(args.taskId) || state?.taskId || null;
  const steps = {};

  if (state) {
    steps.muscleCommit = await callBrowserToolAllowFailure({
      sessionId,
      target,
      tool: 'muscle_commit',
      params: { status: 'failed', note: reason, verification: reason },
      timeoutMs: Number(args.timeoutMs || 30000),
    });
    steps.taskState = await callBrowserToolAllowFailure({
      sessionId,
      target,
      tool: 'task_fail',
      params: { reason, stepIndex: Number(args.stepIndex || 0) },
      timeoutMs: Number(args.timeoutMs || 30000),
    });
    if (taskId) {
      try {
        steps.completeTask = await client.completeTask({
          token: state.token,
          taskId,
          ok: false,
          output: '',
          error: reason,
          sessionId,
        });
      } catch (error) {
        steps.completeTask = { ok: false, error: formatError(error) };
      }
    }
  } else {
    try {
      steps.releaseSession = await client.releaseSession({ sessionId });
    } catch (error) {
      steps.releaseSession = { ok: false, error: formatError(error) };
    }
  }

  sessions.delete(sessionId);
  const stopResult = await stopOwnedBridgeIfIdle({ sessionId });
  return {
    ok: true,
    sessionId,
    target,
    taskId,
    reason,
    steps,
    stopResult,
  };
}

async function commitMuscle(input) {
  const params = {
    status: input.status,
    verification: input.verification,
    note: input.note,
  };
  let result = await callBrowserToolAllowFailure({
    sessionId: input.sessionId,
    target: input.target,
    tool: 'muscle_commit',
    params,
  });

  if (!browserCallSucceeded(result) && mentionsMuscleRemember(result)) {
    await callBrowserToolAllowFailure({
      sessionId: input.sessionId,
      target: input.target,
      tool: 'muscle_remember',
      params: {
        patch: {
          notes: [
            {
              at: new Date().toISOString(),
              text: 'AgentLimb MCP finish recorded no additional reusable selectors for this run.',
            },
          ],
        },
      },
    });
    result = await callBrowserToolAllowFailure({
      sessionId: input.sessionId,
      target: input.target,
      tool: 'muscle_commit',
      params,
    });
  }

  return result;
}

async function callBrowserToolAllowFailure(input) {
  try {
    return await client.callBrowserTool({
      tool: input.tool,
      params: input.params || {},
      source: 'mcp',
      sessionId: input.sessionId,
      target: input.target || null,
      timeoutMs: input.timeoutMs || 30000,
    });
  } catch (error) {
    return {
      ok: false,
      error: formatError(error),
      code: error?.code || null,
      data: error?.data || null,
    };
  }
}

async function registerTrackedBridgeLease(input = {}) {
  const sessionId = resolvePluginSessionId(input.sessionId);
  const marker = await registerBridgeLease({
    ...input,
    sessionId,
  });
  leasedSessionIds.add(sessionId);
  return marker;
}

function normalizeSessionIds(input = {}) {
  const sessionIds = new Set();
  const addSessionId = (value) => {
    if (value == null) return;
    const raw = String(value).trim();
    if (!raw) return;
    sessionIds.add(resolvePluginSessionId(raw));
  };

  const values = input.sessionIds;
  if (values != null) {
    if (typeof values !== 'string' && typeof values[Symbol.iterator] === 'function') {
      for (const value of values) addSessionId(value);
    } else {
      addSessionId(values);
    }
  }
  if (input.sessionId !== undefined) {
    addSessionId(input.sessionId);
  }
  return sessionIds;
}

function forgetLeaseTracking(sessionIds) {
  for (const sessionId of sessionIds) {
    leasedSessionIds.delete(sessionId);
  }
}

async function ensureBridgeOnline(input = {}) {
  const currentStatus = await getStatusQuiet();
  if (currentStatus) {
    await registerTrackedBridgeLease({
      sessionId: input.sessionId,
      bridgeUrl: BRIDGE_URL,
      startedByPlugin: bridge.ownedByThisServer,
      pid: bridge.ownedByThisServer ? bridge.pid : null,
      bridgeRoot,
      serverPath,
    });
    return currentStatus;
  }

  if (!bridge.starting) {
    bridge.starting = startOwnedBridge(input.sessionId).finally(() => {
      bridge.starting = null;
    });
  }

  return bridge.starting;
}

async function startOwnedBridge(sessionId) {
  const env = {
    ...process.env,
    AGENTLIMB_BRIDGE_LOG: BRIDGE_LOG,
    AGENTLIMB_BRIDGE_ERR_LOG: BRIDGE_ERR_LOG,
  };

  bridge.exitInfo = null;
  const child = spawn(process.execPath, [serverPath], {
    cwd: bridgeRoot,
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
    env,
  });

  bridge.child = child;
  bridge.ownedByThisServer = true;
  bridge.pid = child.pid || null;

  child.once('error', (error) => {
    appendMcpLog(`Bridge spawn failed: ${formatError(error)}`);
  });
  child.once('exit', (code, signal) => {
    bridge.exitInfo = { code, signal };
    appendMcpLog(`Bridge child exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });

  try {
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      const readyStatus = await getStatusQuiet();
      if (!readyStatus) continue;

      await sleep(STARTUP_GRACE_MS);
      const survivedStatus = await getStatusQuiet();
      const childAlive = isProcessAlive(bridge.pid);
      if (!survivedStatus || !childAlive) {
        const message = [
          'Bridge responded once but did not survive MCP startup grace check.',
          `pid=${bridge.pid || 'unknown'}.`,
          `alive=${childAlive}.`,
          `exit=${JSON.stringify(bridge.exitInfo || null)}.`,
        ].join(' ');
        appendMcpLog(message);
        throw new Error(`${message} Logs: ${BRIDGE_LOG}, ${BRIDGE_ERR_LOG}`);
      }

      await registerTrackedBridgeLease({
        sessionId,
        bridgeUrl: BRIDGE_URL,
        startedByPlugin: true,
        pid: bridge.pid,
        bridgeRoot,
        serverPath,
        startedAt: new Date().toISOString(),
      });
      return survivedStatus;
    }

    throw new Error(`AgentLimb Bridge did not become ready. Logs: ${BRIDGE_LOG}, ${BRIDGE_ERR_LOG}`);
  } catch (error) {
    await forceKillOwnedBridgeAfterFailedStartup(error);
    throw error;
  }
}

async function stopOwnedBridgeIfIdle(input = {}) {
  const sessionIds = normalizeSessionIds(input);
  if (!bridge.ownedByThisServer) {
    await removeLeasesOnly({ sessionIds });
    return { ok: true, stopped: false, reason: 'bridge was not started by this MCP server' };
  }
  if (bridge.stopping) return bridge.stopping;

  bridge.stopping = stopOwnedBridgeIfIdleInner({ sessionIds }).finally(() => {
    bridge.stopping = null;
  });
  return bridge.stopping;
}

async function stopOwnedBridgeIfIdleInner(input = {}) {
  const sessionIds = normalizeSessionIds(input);
  let stopped = false;
  let reason = 'not idle';

  await withBridgeMarkerLock(async (marker) => {
    if (!marker || marker.owner !== OWNER) {
      reason = 'owner marker missing';
      return marker;
    }
    if (marker.bridgeUrl !== BRIDGE_URL) {
      reason = 'owner marker belongs to another bridge url';
      return marker;
    }

    for (const sessionId of sessionIds) {
      delete marker.leases?.[sessionId];
    }
    marker.updatedAt = new Date().toISOString();

    if (!isMarkedProcessAlive(marker)) {
      stopped = true;
      reason = 'owned bridge process is already gone';
      return null;
    }
    if (marker.startedByPlugin !== true || Number(marker.pid) !== Number(bridge.pid)) {
      reason = 'bridge was not started by this MCP server';
      return marker;
    }
    if (activeLeaseCount(marker) > 0) {
      reason = 'active leases remain';
      return marker;
    }

    const status = await getStatusQuiet();
    if (!status) {
      stopped = true;
      reason = 'bridge is already offline';
      return null;
    }
    if (!isBridgeIdleStatus(status.status)) {
      reason = 'bridge still has queued or claimed work';
      return marker;
    }

    marker.shutdownPending = true;
    await shutdownBridgeGracefully();
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      if (!(await getStatusQuiet())) {
        stopped = true;
        reason = 'idle plugin-owned bridge stopped';
        clearOwnedBridgeState();
        return null;
      }
    }

    reason = 'shutdown timed out';
    marker.shutdownPending = false;
    return marker;
  });

  forgetLeaseTracking(sessionIds);
  return { ok: true, stopped, reason };
}

async function removeLeasesOnly(input = {}) {
  const sessionIds = normalizeSessionIds(input);
  if (sessionIds.size === 0) return;

  await withBridgeMarkerLock((marker) => {
    if (!marker) return marker;
    for (const sessionId of sessionIds) {
      delete marker.leases?.[sessionId];
    }
    marker.updatedAt = new Date().toISOString();
    return marker;
  });
  forgetLeaseTracking(sessionIds);
}

async function forceKillOwnedBridgeAfterFailedStartup(error) {
  if (!bridge.ownedByThisServer) return;

  const childPid = bridge.pid;
  let skippedReason = null;

  try {
    await withBridgeMarkerLock(async (marker) => {
      const markerMatches = markerMatchesOwnedBridge(marker, childPid);
      const childAlive =
        bridge.child &&
        bridge.child.exitCode == null &&
        isProcessAlive(childPid);

      if (!childAlive) {
        clearOwnedBridgeState();
        return markerMatches ? null : marker;
      }

      if (marker && !markerMatches) {
        skippedReason = 'owner marker does not match this failed startup child';
        return marker;
      }
      if (marker && activeLeaseCount(marker) > 0) {
        skippedReason = 'active leases remain';
        return marker;
      }

      const status = await getStatusQuiet();
      if (status && !isBridgeIdleStatus(status.status)) {
        skippedReason = 'bridge still has queued or claimed work';
        return marker;
      }

      if (status && markerMatches) {
        try {
          await shutdownBridgeGracefully();
          for (let i = 0; i < 20; i += 1) {
            await sleep(250);
            if (!(await getStatusQuiet())) {
              clearOwnedBridgeState();
              return markerMatches ? null : marker;
            }
          }
        } catch (shutdownError) {
          appendMcpLog(`Failed-startup graceful bridge shutdown failed: ${formatError(shutdownError)}`);
        }
      }

      if (bridge.child && bridge.child.exitCode == null) {
        try {
          bridge.child.kill();
        } catch {
          // Best effort fallback for the just-spawned child only.
        }
      }
      clearOwnedBridgeState();
      return markerMatches ? null : marker;
    });
  } catch (cleanupError) {
    appendMcpLog(`Failed-startup bridge cleanup failed: ${formatError(cleanupError)}`);
    return;
  }

  if (skippedReason) {
    appendMcpLog(
      `Skipping failed-startup Bridge force kill: ${skippedReason}. Startup error: ${formatError(error)}`,
    );
  }
}

async function shutdownBridgeGracefully() {
  const response = await fetchLocal(SHUTDOWN_URL, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Bridge shutdown returned HTTP ${response.status}`);
  }
}

function clearOwnedBridgeState() {
  bridge.child = null;
  bridge.ownedByThisServer = false;
  bridge.pid = null;
  bridge.exitInfo = null;
}

function markerMatchesOwnedBridge(marker, pid = bridge.pid) {
  return (
    marker &&
    marker.owner === OWNER &&
    marker.bridgeUrl === BRIDGE_URL &&
    marker.startedByPlugin === true &&
    Number(marker.pid) === Number(pid)
  );
}

async function getStatusQuiet() {
  try {
    return await client.getStatus();
  } catch {
    return null;
  }
}

function createNodeFetch() {
  return async function nodeFetch(urlStr, init = {}) {
    const response = await fetchLocal(urlStr, init);
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.text,
      json: async () => (response.text ? JSON.parse(response.text) : {}),
    };
  };
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
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function browserCallSucceeded(response) {
  return response?.completed?.call?.status === 'completed';
}

function mentionsMuscleRemember(response) {
  return JSON.stringify(response || {}).includes('muscle_remember');
}

function requireStartedSession(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) {
    throw new Error(`No active AgentLimb MCP session found for ${sessionId}. Run agentlimb_start first.`);
  }
  return state;
}

function requireSessionId(raw) {
  const sessionId = resolvePluginSessionId(raw);
  if (!sessionId) throw new Error('sessionId is required.');
  return sessionId;
}

function requireString(value, name) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function appendMcpLog(message) {
  try {
    appendFileSync(
      MCP_LOG,
      `[${new Date().toISOString()}] [agentlimb mcp] ${message}\n`,
    );
  } catch {
    // Diagnostics should not break the MCP server.
  }
}

function toolResult(payload, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

function sendJsonRpcResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendJsonRpcError(id, code, message, data = null) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data != null ? { data } : {}),
    },
  });
}

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function exitAfterCleanup(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await releaseLocalLeasesAndStopIfIdle();
  } catch (error) {
    appendMcpLog(`MCP exit cleanup failed: ${formatError(error)}`);
  } finally {
    process.exit(code);
  }
}

async function releaseLocalLeasesAndStopIfIdle() {
  const sessionIds = [...leasedSessionIds];
  sessions.clear();

  if (sessionIds.length === 0 && !bridge.ownedByThisServer) {
    return { ok: true, stopped: false, reason: 'no local leases or owned bridge' };
  }

  return stopOwnedBridgeIfIdle({ sessionIds });
}

function formatError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

class JsonRpcError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const TOOL_DEFINITIONS = [
  {
    name: 'agentlimb_status',
    description: 'Check AgentLimb Bridge, extension, owner marker, and MCP-managed process state without starting the Bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        target: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlimb_start',
    description: 'Start or attach to the temporary AgentLimb Bridge, connect a Codex terminal session, and bootstrap browser context.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        target: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        taskId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agentlimb_call',
    description: 'Call an AgentLimb browser tool through the MCP-managed Bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        target: { type: 'string' },
        tool: { type: 'string' },
        params: { type: 'object' },
        timeoutMs: { type: 'number' },
      },
      required: ['sessionId', 'tool'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlimb_finish',
    description: 'Commit or discard muscle memory, mark the side-panel task state, complete the terminal task, release locks, and stop an idle MCP-owned Bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        target: { type: 'string' },
        taskId: { type: 'string' },
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        muscleStatus: {
          type: 'string',
          enum: ['success', 'partial', 'failed', 'manual'],
        },
        verification: { type: 'string' },
        note: { type: 'string' },
        timeoutMs: { type: 'number' },
        stepIndex: { type: 'number' },
      },
      required: ['sessionId', 'ok', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentlimb_abort',
    description: 'Fail the current AgentLimb task, release this session, and stop an idle MCP-owned Bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        target: { type: 'string' },
        taskId: { type: 'string' },
        reason: { type: 'string' },
        timeoutMs: { type: 'number' },
        stepIndex: { type: 'number' },
      },
      required: ['sessionId', 'reason'],
      additionalProperties: false,
    },
  },
];
