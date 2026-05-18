import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

import { createMvpStore } from './store.js';
import { readProfile, writeProfile, mergeAndWriteProfile, listDomains, normalizeDomain, getMuscleDir } from './muscle-fs.js';
import { existsSync } from 'node:fs';
import { HOST_TOOLS } from '../../control/host/tools.js';
import {
  handleDocsTools,
  handleDocsToolByName,
  handleDocsRules,
  handleDocsProtocol,
  handleMeta,
} from './docs.js';
import { activeLeaseCount, loadBridgeMarker } from './plugin-lease.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7791;

export function createMvpServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const store = options.store || createMvpStore();

  let activePort = null;
  const _openSockets = new Set();

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      host,
      store,
      shutdownProcess,
      get baseUrl() {
        return `http://${host}:${activePort ?? port}`;
      },
    }).catch((error) => {
      respondJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.on('connection', (socket) => {
    _openSockets.add(socket);
    socket.once('close', () => _openSockets.delete(socket));
  });

  async function stopServer() {
    if (!server.listening) return;

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        activePort = null;
        resolve();
      });
    });
  }

  async function shutdownProcess() {
    await stopServer();
    process.exitCode = 0;
  }

  return {
    async start() {
      if (server.listening) return;

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          activePort =
            typeof address === 'object' && address ? address.port : port;
          resolve();
        });
      });
    },

    async stop() {
      await stopServer();
    },

    getBaseUrl() {
      return `http://${host}:${activePort ?? port}`;
    },

    getStore() {
      return store;
    },
  };
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url || '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method || 'GET';
  const origin = readHeader(request, 'origin');

  if (!isAllowedOrigin(origin)) {
    respondJson(response, 403, {
      ok: false,
      error: 'origin_not_allowed',
    });
    return;
  }

  setCorsHeaders(response, origin);

  if (method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === 'GET' && path === '/api/mvp/status') {
    const status = context.store.getStatus();
    status.plugin = summarizePluginMarker(loadBridgeMarker());
    respondJson(response, 200, {
      ok: true,
      host: {
        baseUrl: context.baseUrl,
      },
      status,
      terminals: context.store.listTerminals(),
    });
    return;
  }

  if (method === 'GET' && path === '/api/mvp/extensions') {
    respondJson(response, 200, {
      ok: true,
      extensions: context.store.listExtensions(),
    });
    return;
  }

  if (method === 'POST' && path.startsWith('/api/mvp/extensions/') && path.endsWith('/suspend')) {
    const extensionId = decodeURIComponent(
      path.slice('/api/mvp/extensions/'.length, -'/suspend'.length),
    );
    const body = await readJsonBody(request);
    try {
      const entry = context.store.setExtensionSuspended(extensionId, body.suspended);
      respondJson(response, 200, { ok: true, extension: entry });
    } catch (error) {
      const isGuard = error?.code === 'LAST_ACTIVE_WORKER';
      respondJson(response, isGuard ? 409 : 400, {
        ok: false,
        error: error?.message || String(error),
        code: error?.code || null,
      });
    }
    return;
  }

  if (method === 'POST' && path === '/api/mvp/extension/prompt') {
    const body = await readJsonBody(request);
    const task = context.store.submitPrompt({
      prompt: body.prompt,
      source: body.source || 'sidepanel',
      metadata: body.metadata,
    });

    respondJson(response, 200, { ok: true, task });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/terminal/connect') {
    const body = await readJsonBody(request);
    const terminal = context.store.registerTerminal(body);
    respondJson(response, 200, {
      ok: true,
      token: terminal.token,
      terminal,
    });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/terminal/next') {
    const body = await readJsonBody(request);
    const token = request.headers['x-agentlimb-terminal'] || body.token;
    const task = context.store.claimNextTask({
      token,
      taskId: body.taskId || null,
    });
    respondJson(response, 200, {
      ok: true,
      task,
    });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/terminal/result') {
    const body = await readJsonBody(request);
    const token = request.headers['x-agentlimb-terminal'] || body.token;
    const task = context.store.submitResult({
      token,
      taskId: body.taskId,
      ok: body.ok,
      output: body.output,
      error: body.error,
      sessionId: body.sessionId,
    });
    respondJson(response, 200, {
      ok: true,
      task,
    });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/sessions/release') {
    const body = await readJsonBody(request);
    const released = context.store.releaseSession({
      sessionId: body.sessionId,
    });
    respondJson(response, 200, {
      ok: true,
      ...released,
    });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/browser/call') {
    const body = await readJsonBody(request);
    const toolName = body.tool;
    const knownTool = HOST_TOOLS.find((t) => t.name === toolName);
    if (!knownTool) {
      respondJson(response, 400, {
        ok: false,
        error: 'unknown_tool',
        tool: toolName,
        hint: 'See the full tool list at GET /api/mvp/docs/tools',
        knownTools: HOST_TOOLS.map((t) => t.name),
      });
      return;
    }
    try {
      const call = context.store.submitBrowserToolCall({
        tool: toolName,
        params: body.params,
        source: body.source || 'terminal',
        target: body.target || null,
        sessionId: body.sessionId || null,
      });
      respondJson(response, 200, {
        ok: true,
        call,
      });
    } catch (error) {
      const code = error?.code;
      const conflictCodes = new Set([
        'TARGET_SUSPENDED',
        'TARGET_NOT_FOUND',
        'PROFILE_BUSY',
        'TARGET_REQUIRED',
      ]);
      const status = conflictCodes.has(code) ? 409 : 400;
      respondJson(response, status, {
        ok: false,
        error: error?.message || String(error),
        code: code || null,
        target: error?.target || null,
        label: error?.label || null,
        sessionId: error?.sessionId || null,
        targets: error?.targets || null,
      });
    }
    return;
  }

  if (method === 'POST' && path === '/api/mvp/extension/browser/next') {
    const extensionId = readHeader(request, 'x-extension-id');
    const label = readHeader(request, 'x-extension-label');
    const userAgent = readHeader(request, 'user-agent');
    const panelActiveHeader = readHeader(request, 'x-panel-active');
    // Tri-state: 'true'/'false' set the flag; missing means "signal not carried"
    // (older SW builds) — store.js preserves the last known value in that case.
    const panelActive =
      panelActiveHeader === 'true'
        ? true
        : panelActiveHeader === 'false'
          ? false
          : undefined;
    context.store.recordExtensionPoll({ extensionId, label, userAgent, panelActive });
    const call = context.store.claimNextBrowserToolCall({ extensionId });
    respondJson(response, 200, {
      ok: true,
      call,
    });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/extension/browser/result') {
    const body = await readJsonBody(request);
    const call = context.store.submitBrowserToolResult({
      callId: body.callId,
      ok: body.ok,
      result: body.result,
      error: body.error,
    });
    respondJson(response, 200, {
      ok: true,
      call,
    });
    return;
  }

  if (method === 'GET' && path.startsWith('/api/mvp/tasks/')) {
    const taskId = decodeURIComponent(path.replace('/api/mvp/tasks/', ''));
    const task = context.store.getTask(taskId);
    if (!task) {
      respondJson(response, 404, {
        ok: false,
        error: `Task not found: ${taskId}`,
      });
      return;
    }

    respondJson(response, 200, { ok: true, task });
    return;
  }

  if (method === 'GET' && path === '/api/mvp/muscle/exists') {
    const dir = getMuscleDir();
    respondJson(response, 200, { ok: true, exists: existsSync(dir), path: dir });
    return;
  }

  if (method === 'GET' && path === '/api/mvp/muscle/list') {
    const domains = await listDomains();
    respondJson(response, 200, { ok: true, domains });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/muscle/open-folder') {
    await listDomains();
    const dir = getMuscleDir();
    try {
      openFolder(dir);
      respondJson(response, 200, { ok: true, path: dir });
    } catch (error) {
      respondJson(response, 500, {
        ok: false,
        path: dir,
        error: error?.message || String(error),
      });
    }
    return;
  }

  if (method === 'GET' && path === '/api/mvp/muscle/read') {
    const domain = url.searchParams.get('domain');
    const d = normalizeDomain(domain || '');
    if (!d) {
      respondJson(response, 400, { ok: false, error: 'Missing or invalid domain parameter.' });
      return;
    }
    const profile = await readProfile(d);
    respondJson(response, 200, { ok: true, domain: d, profile });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/muscle/write') {
    const body = await readJsonBody(request);
    const d = normalizeDomain(body.domain || '');
    if (!d) {
      respondJson(response, 400, { ok: false, error: 'Missing or invalid domain field.' });
      return;
    }
    if (!body.profile || typeof body.profile !== 'object') {
      respondJson(response, 400, { ok: false, error: 'Missing profile field.' });
      return;
    }
    const { path: filePath, bytes } = await writeProfile(d, body.profile);
    respondJson(response, 200, { ok: true, domain: d, path: filePath, bytes, version: body.profile.version ?? null });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/muscle/merge') {
    const body = await readJsonBody(request);
    const d = normalizeDomain(body.domain || '');
    if (!d) {
      respondJson(response, 400, { ok: false, error: 'Missing or invalid domain field.' });
      return;
    }
    if (!body.patch || typeof body.patch !== 'object') {
      respondJson(response, 400, { ok: false, error: 'Missing patch field.' });
      return;
    }
    const { path: filePath, bytes, profile } = await mergeAndWriteProfile(d, body.patch);
    respondJson(response, 200, { ok: true, domain: d, path: filePath, bytes, version: profile.version });
    return;
  }

  if (method === 'GET' && path.startsWith('/api/mvp/browser/calls/')) {
    const callId = decodeURIComponent(path.replace('/api/mvp/browser/calls/', ''));
    const call = context.store.getBrowserToolCall(callId);
    if (!call) {
      respondJson(response, 404, {
        ok: false,
        error: `Browser call not found: ${callId}`,
      });
      return;
    }

    respondJson(response, 200, { ok: true, call });
    return;
  }

  // ── Docs + meta endpoints ──────────────────────────────────────────────────

  if (method === 'GET' && path === '/api/mvp/docs/tools') {
    await handleDocsTools(request, response);
    return;
  }

  if (method === 'GET' && path.startsWith('/api/mvp/docs/tools/')) {
    const toolName = decodeURIComponent(path.replace('/api/mvp/docs/tools/', ''));
    await handleDocsToolByName(request, response, toolName);
    return;
  }

  if (method === 'GET' && path === '/api/mvp/docs/rules') {
    await handleDocsRules(request, response);
    return;
  }

  if (method === 'GET' && path === '/api/mvp/docs/protocol') {
    await handleDocsProtocol(request, response);
    return;
  }

  if (method === 'GET' && path === '/api/mvp/meta') {
    await handleMeta(request, response, { baseUrl: context.baseUrl });
    return;
  }

  if (method === 'POST' && path === '/api/mvp/shutdown') {
    respondJson(response, 200, { ok: true });
    // Trigger run-server.js graceful handler so the HTTP server closes cleanly
    // before exiting; prevents the port staying bound.
    //
    // On macOS with LaunchAgent KeepAlive=true, launchd would auto-restart
    // within ~1s, defeating the user's intent to actually stop Bridge.
    // Disable the LaunchAgent first so SIGTERM actually keeps Bridge down.
    // Re-enable instructions are surfaced via the 🩺 sidepanel button.
    setTimeout(async () => {
      if (process.platform === 'darwin') {
        try {
          const { execSync } = await import('node:child_process');
          const uid = process.getuid();
          execSync(
            `launchctl disable gui/${uid}/com.agentlimb.bridge`,
            { stdio: 'ignore', timeout: 1500 },
          );
        } catch {
          // LaunchAgent not loaded (running via `node run-server.js` directly) — harmless
        }
      }
      await context.shutdownProcess();
    }, 150);
    return;
  }

  respondJson(response, 404, {
    ok: false,
    error: `Unknown route: ${method} ${path}`,
  });
}

function setCorsHeaders(response, origin = '') {
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-AgentLimb-Terminal, X-Extension-Id, X-Extension-Label, X-Panel-Active',
  );
  response.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS',
  );
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'chrome-extension:') return true;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    }
  } catch {
    return false;
  }

  return false;
}

function respondJson(response, statusCode, payload) {
  if (!response.hasHeader('Content-Type')) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  response.writeHead(statusCode);
  response.end(JSON.stringify(payload, null, 2));
}

function summarizePluginMarker(marker) {
  if (!marker) {
    return {
      owner: null,
      startedByPlugin: false,
      activeLeases: 0,
      leases: [],
    };
  }

  return {
    owner: marker.owner || null,
    startedByPlugin: marker.startedByPlugin === true,
    pid: marker.pid || null,
    bridgeUrl: marker.bridgeUrl || null,
    activeLeases: activeLeaseCount(marker),
    leases: Object.values(marker.leases || {}).map((lease) => ({
      sessionId: lease.sessionId,
      acquiredAt: lease.acquiredAt,
      lastSeenAt: lease.lastSeenAt,
      cwd: lease.cwd || '',
    })),
    shutdownPending: marker.shutdownPending === true,
  };
}

function openFolder(path) {
  const platform = process.platform;
  const command =
    platform === 'win32' ? 'explorer.exe' :
    platform === 'darwin' ? 'open' :
    'xdg-open';
  const child = spawn(command, [path], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function readHeader(request, name) {
  const raw = request.headers?.[name];
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return String(raw || '').trim();
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  return JSON.parse(raw);
}
