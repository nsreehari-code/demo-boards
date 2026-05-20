#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetScript = path.join(__dirname, 'server-http-test.js');
const cliArgs = process.argv.slice(2);
const bypassIndex = cliArgs.indexOf('--bypass');
const useBypass = bypassIndex !== -1;
const assistantDebugLogFile = path.join(os.tmpdir(), 'demo-board-t3a-assistant-debug.log');
if (useBypass) {
  cliArgs.splice(bypassIndex, 1);
}

console.log(`[server-t3a-http-test] assistant debug log: ${assistantDebugLogFile}`);

const args = [
  targetScript,
  '--use-config-setup-root',
  '--skip-t1',
  '--skip-t2',
  '--skip-t3',
  '--skip-t3b',
  '--skip-t3c',
  ...cliArgs,
];

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    ENABLE_DEBUG_LOGGING: assistantDebugLogFile,
    ...(useBypass ? { DEMO_T3A_BYPASS: '1' } : {}),
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);