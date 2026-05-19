#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMvpServer } from './server.js';

const port = Number(process.env.AGENTLIMB_MVP_PORT || 7791);
const host = process.env.AGENTLIMB_MVP_HOST || '127.0.0.1';
const stdoutLog = process.env.AGENTLIMB_BRIDGE_LOG || join(tmpdir(), 'agentlimb-bridge.log');
const stderrLog = process.env.AGENTLIMB_BRIDGE_ERR_LOG || join(tmpdir(), 'agentlimb-bridge.err.log');

const server = createMvpServer({
  host,
  port,
  onShutdown: (reason) => {
    logInfo(`shutdown requested: ${reason}`);
  },
});

let shuttingDown = false;

process.on('exit', (code) => {
  writeLog(stdoutLog, `process exit: code=${code}`);
});
process.on('uncaughtException', (error) => {
  logError('uncaught exception', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandled rejection', reason);
  process.exit(1);
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await server.start();
  logInfo(`listening on ${server.getBaseUrl()} pid=${process.pid}`);
} catch (error) {
  logError('failed to start', error);
  process.exit(1);
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`shutdown requested: ${reason}`);

  try {
    await server.stop();
    logInfo(`stopped: ${reason}`);
    process.exit(0);
  } catch (error) {
    logError(`failed to stop after ${reason}`, error);
    process.exit(1);
  }
}

function logInfo(message) {
  const line = formatLogLine(message);
  console.log(line);
  writeLog(stdoutLog, message);
}

function logError(message, error) {
  const detail = formatError(error);
  const fullMessage = detail ? `${message}: ${detail}` : message;
  const line = formatLogLine(fullMessage);
  console.error(line);
  writeLog(stderrLog, fullMessage);
}

function writeLog(filePath, message) {
  try {
    appendFileSync(filePath, `${formatLogLine(message)}\n`);
  } catch {
    // File logging should not prevent Bridge startup or shutdown.
  }
}

function formatLogLine(message) {
  return `[${new Date().toISOString()}] [agentlimb mvp] ${message}`;
}

function formatError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
