#!/usr/bin/env node

// Sync bundled yaml-flow CLIs from node_modules into demo-board/scripts/yaml-flow
// so they live alongside the repo and can be copied into per-board copilot
// workspaces (.github/scripts) without dragging node_modules with them.
//
// Errors if the upstream cli/bundled/ directory is missing: this repo requires
// a yaml-flow build that ships bundled single-file CLIs.

const fs = require('node:fs');
const path = require('node:path');

const workspaceDir = path.resolve(__dirname, '..');
const sourceDir = path.join(workspaceDir, 'node_modules', 'yaml-flow', 'cli', 'bundled');
const targetDir = path.join(workspaceDir, 'demo-board', 'scripts', 'yaml-flow');
const boardLiveCardsShimPath = path.join(targetDir, 'board-live-cards-cli.js');
const boardLiveCardsShimSource = "import './board-live-cards-cli.mjs';\n";

if (!fs.existsSync(sourceDir)) {
  console.error(`[sync-yaml-flow-cli] source not found: ${sourceDir}`);
  console.error('[sync-yaml-flow-cli] this repo requires a yaml-flow release that ships cli/bundled/. install or upgrade yaml-flow.');
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

let count = 0;
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  count += 1;
}

fs.writeFileSync(boardLiveCardsShimPath, boardLiveCardsShimSource, 'utf8');

console.log(`[sync-yaml-flow-cli] copied ${count} file(s) from ${sourceDir} to ${targetDir}`);
