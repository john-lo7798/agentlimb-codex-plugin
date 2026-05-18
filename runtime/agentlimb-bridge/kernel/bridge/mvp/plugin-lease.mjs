import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

export const OWNER = 'agentlimb-codex-plugin';
export const OWNER_MARKER_FILE = join(tmpdir(), 'agentlimb-bridge-owner.json');
export const OWNER_LOCK_FILE = join(tmpdir(), 'agentlimb-bridge-owner.lock');
export const SESSION_DIR = join(tmpdir(), 'agentlimb-sessions');

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 10_000;
const LEASE_TTL_MS = 12 * 60 * 60 * 1000;

export function resolvePluginSessionId(rawValue = '') {
  const raw = String(
    rawValue ||
      process.env.AGENTLIMB_SESSION_ID ||
      process.env.CODEX_THREAD_ID ||
      '',
  ).trim();

  if (raw) return sanitizeId(raw);

  const cwdHash = createHash('sha256')
    .update(resolve(process.cwd()))
    .digest('hex')
    .slice(0, 16);
  return `codex-${cwdHash}`;
}

export function createPluginSessionId() {
  return `codex-${randomUUID()}`;
}

export function defaultSessionFileFor(sessionId) {
  return join(SESSION_DIR, `${sanitizeId(sessionId)}.json`);
}

export function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function loadBridgeMarker() {
  try {
    if (!existsSync(OWNER_MARKER_FILE)) return null;
    return normalizeMarker(JSON.parse(readFileSync(OWNER_MARKER_FILE, 'utf8')));
  } catch {
    return null;
  }
}

export async function withBridgeMarkerLock(callback) {
  const fd = await acquireMarkerLock();
  try {
    const current = loadBridgeMarker();
    const next = await callback(current);
    if (next === undefined) return current;
    if (next === null) {
      removeBridgeMarker();
      return null;
    }
    const marker = pruneExpiredLeases(normalizeMarker(next));
    saveBridgeMarker(marker);
    return marker;
  } finally {
    closeSync(fd);
    try {
      unlinkSync(OWNER_LOCK_FILE);
    } catch {
      // Best effort cleanup only.
    }
  }
}

export async function registerBridgeLease(input = {}) {
  const sessionId = resolvePluginSessionId(input.sessionId);
  const timestamp = now();

  return withBridgeMarkerLock((current) => {
    let marker = current;
    const currentAlive = marker ? isMarkedProcessAlive(marker) : false;
    const canReuseCurrent =
      marker &&
      marker.owner === OWNER &&
      marker.bridgeUrl === input.bridgeUrl &&
      (marker.startedByPlugin !== true || currentAlive);

    if (!canReuseCurrent || input.startedByPlugin === true) {
      marker = {
        schemaVersion: 2,
        owner: OWNER,
        startedByPlugin: input.startedByPlugin === true,
        pid: Number.isInteger(Number(input.pid)) ? Number(input.pid) : null,
        startedAt: input.startedAt || timestamp,
        updatedAt: timestamp,
        bridgeUrl: input.bridgeUrl,
        bridgeRoot: input.bridgeRoot || null,
        serverPath: input.serverPath || null,
        shutdownPending: false,
        leases: {},
      };
    }

    marker.shutdownPending = false;
    marker.updatedAt = timestamp;
    marker.leases = marker.leases || {};
    marker.leases[sessionId] = {
      sessionId,
      acquiredAt: marker.leases[sessionId]?.acquiredAt || timestamp,
      lastSeenAt: timestamp,
      cwd: input.cwd || process.cwd(),
    };

    return marker;
  });
}

export async function releaseBridgeLease(sessionIdInput) {
  const sessionId = resolvePluginSessionId(sessionIdInput);
  return withBridgeMarkerLock((current) => {
    if (!current) return null;
    const marker = pruneExpiredLeases(current);
    delete marker.leases?.[sessionId];
    marker.updatedAt = now();
    if (marker.startedByPlugin !== true && activeLeaseCount(marker) === 0) {
      return null;
    }
    return marker;
  });
}

export function activeLeaseCount(marker) {
  return Object.keys(pruneExpiredLeases(marker)?.leases || {}).length;
}

export function isMarkedProcessAlive(marker) {
  const pid = Number(marker?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isBridgeIdleStatus(status) {
  const tasks = status?.tasks || {};
  const browserCalls = status?.browserCalls || {};
  return (
    Number(tasks.queued || 0) === 0 &&
    Number(tasks.claimed || 0) === 0 &&
    Number(browserCalls.queued || 0) === 0 &&
    Number(browserCalls.claimed || 0) === 0
  );
}

export function removeBridgeMarker() {
  try {
    if (existsSync(OWNER_MARKER_FILE)) unlinkSync(OWNER_MARKER_FILE);
  } catch {
    // Best effort cleanup only.
  }
}

function saveBridgeMarker(marker) {
  writeFileSync(OWNER_MARKER_FILE, JSON.stringify(marker, null, 2));
}

async function acquireMarkerLock() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      return openSync(OWNER_LOCK_FILE, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      removeStaleLock();
      await sleep(50);
    }
  }
  throw new Error(`Timed out waiting for AgentLimb owner marker lock: ${OWNER_LOCK_FILE}`);
}

function removeStaleLock() {
  try {
    const ageMs = Date.now() - statSync(OWNER_LOCK_FILE).mtimeMs;
    if (ageMs > LOCK_STALE_MS) unlinkSync(OWNER_LOCK_FILE);
  } catch {
    // Another process may have removed it.
  }
}

function normalizeMarker(marker) {
  if (!marker || typeof marker !== 'object') return null;
  const timestamp = now();
  const leases = normalizeLeases(marker.leases);

  return pruneExpiredLeases({
    schemaVersion: 2,
    owner: marker.owner || OWNER,
    startedByPlugin:
      marker.startedByPlugin === true ||
      (marker.owner === OWNER && marker.startedByPlugin !== false && marker.pid != null),
    pid: Number.isInteger(Number(marker.pid)) ? Number(marker.pid) : null,
    startedAt: marker.startedAt || timestamp,
    updatedAt: marker.updatedAt || timestamp,
    bridgeUrl: marker.bridgeUrl || 'http://127.0.0.1:7791',
    bridgeRoot: marker.bridgeRoot || null,
    serverPath: marker.serverPath || null,
    shutdownPending: marker.shutdownPending === true,
    leases,
  });
}

function normalizeLeases(leases) {
  if (!leases || typeof leases !== 'object' || Array.isArray(leases)) return {};
  const normalized = {};
  for (const [key, lease] of Object.entries(leases)) {
    if (!lease || typeof lease !== 'object') continue;
    const sessionId = resolvePluginSessionId(lease.sessionId || key);
    normalized[sessionId] = {
      sessionId,
      acquiredAt: lease.acquiredAt || now(),
      lastSeenAt: lease.lastSeenAt || lease.acquiredAt || now(),
      cwd: lease.cwd || '',
    };
  }
  return normalized;
}

function pruneExpiredLeases(marker) {
  if (!marker) return marker;
  const leases = marker.leases || {};
  const cutoff = Date.now() - LEASE_TTL_MS;
  for (const [sessionId, lease] of Object.entries(leases)) {
    const lastSeenAt = new Date(lease.lastSeenAt || lease.acquiredAt || 0).getTime();
    if (!Number.isFinite(lastSeenAt) || lastSeenAt < cutoff) {
      delete leases[sessionId];
    }
  }
  marker.leases = leases;
  return marker;
}

function sanitizeId(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return cleaned || `codex-${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
