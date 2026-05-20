#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetScript = path.join(__dirname, 'server-http-test.js');
const assistantDebugLogFile = path.join(os.tmpdir(), 'demo-board-t3c-assistant-debug.log');

console.log(`[server-t3c-http-test] assistant debug log: ${assistantDebugLogFile}`);

const args = [
  targetScript,
  '--use-config-setup-root',
  '--skip-t1',
  '--skip-t2',
  '--skip-t3',
  '--skip-t3a',
  '--skip-t3b',
  ...process.argv.slice(2),
];

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    ENABLE_DEBUG_LOGGING: assistantDebugLogFile,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);