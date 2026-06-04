#!/usr/bin/env node

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, '..');
const serverRoot = path.resolve(runtimeRoot, '..');

const steps = [
  ['../sync-copilot-mcp-config.js', ['--refresh']],
  ['./scripts/setup-copilot-workspaces.js', []],
  ['./scripts/setup-foundry-workspaces.js', []],
];

for (const [scriptPath, extraArgs] of steps) {
  execFileSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: runtimeRoot,
    stdio: 'inherit',
  });
}
