#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonStdin, requireRequiredStrings, setChatProcessingViaApi } from './copilot-chat/shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_CONFIG_FILE = path.resolve(HERE, '..', '..', 'server-config.json');

function loadBoardServerPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf-8'));
    const port = Number(cfg.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error('server-config.json port is not a positive number');
    }
    return port;
  } catch (err) {
    throw new Error(`Cannot read port from server-config.json: ${err?.message || err}`);
  }
}

const input = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  state = '',
} = input;

requireRequiredStrings({ boardId, cardId, state }, 'chat processing controlplane');

if (state !== 'started' && state !== 'done') {
  throw new Error(`Unsupported chat processing state: ${state}`);
}

const ok = await setChatProcessingViaApi({
  boardServerPort: loadBoardServerPort(),
  boardId,
  cardId,
  active: state === 'started',
});

if (!ok) {
  throw new Error(`Failed to set chat processing state to ${state}`);
}

process.stdout.write(JSON.stringify({ ok: true, state }));