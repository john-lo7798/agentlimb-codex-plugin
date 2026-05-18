#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, '..');
const packageJson = readPackageJson();
const bridgeUrl = process.env.AGENTLIMB_MVP_URL || 'http://127.0.0.1:7791';

let buffer = Buffer.alloc(0);
let replied = false;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

process.stdin.on('end', () => {
  if (!replied) sendConfig();
});

setTimeout(() => {
  if (!replied) sendConfig();
}, 1500).unref();

function readMessages() {
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) return;

    const payload = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);

    try {
      JSON.parse(payload.toString('utf8'));
    } catch {
      // The current extension only asks for config; malformed input still gets it.
    }

    sendConfig();
    return;
  }
}

function sendConfig() {
  if (replied) return;
  replied = true;

  const response = {
    ok: true,
    projectDir,
    bridge: {
      baseUrl: bridgeUrl,
      command: `node "${resolve(projectDir, 'kernel/bridge/mvp/run-server.js')}"`,
    },
    client: {
      command: `node "${resolve(projectDir, 'kernel/bridge/mvp/terminal-client.mjs')}"`,
    },
    app: {
      name: packageJson.name || 'agentlimb-bridge',
      version: packageJson.version || '0.0.0',
    },
  };

  const body = Buffer.from(JSON.stringify(response), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));

  setTimeout(() => process.exit(0), 20).unref();
}

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}
