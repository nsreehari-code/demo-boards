#!/usr/bin/env node

// Sync bundled yaml-flow CLIs from node_modules into demo-board/scripts/cli
// so they live alongside the staged wrapper commands and can be copied into
// per-board copilot workspaces (.github/scripts) without dragging node_modules
// with them.
//
// Errors if the upstream cli/bundled/ directory is missing: this repo requires
// a yaml-flow build that ships bundled single-file CLIs.

const fs = require('node:fs');
const path = require('node:path');

const workspaceDir = path.resolve(__dirname, '..');
const sourceDir = path.join(workspaceDir, 'node_modules', 'yaml-flow', 'cli', 'bundled');
const targetDir = path.join(workspaceDir, 'demo-board', 'scripts', 'cli');
const legacyTargetDir = path.join(workspaceDir, 'demo-board', 'scripts', 'yaml-flow');
const boardLiveCardsShimPath = path.join(targetDir, 'board-live-cards-cli.js');
const boardLiveCardsShimSource = "import './board-live-cards-cli.mjs';\n";

if (!fs.existsSync(sourceDir)) {
  console.error(`[sync-yaml-flow-cli] source not found: ${sourceDir}`);
  console.error('[sync-yaml-flow-cli] this repo requires a yaml-flow release that ships cli/bundled/. install or upgrade yaml-flow.');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.rmSync(legacyTargetDir, { recursive: true, force: true });

const bundledFileNames = fs.readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

for (const fileName of [...bundledFileNames, path.basename(boardLiveCardsShimPath)]) {
  fs.rmSync(path.join(targetDir, fileName), { force: true });
}

let count = 0;
for (const fileName of bundledFileNames) {
  fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
  count += 1;
}

fs.writeFileSync(boardLiveCardsShimPath, boardLiveCardsShimSource, 'utf8');

console.log(`[sync-yaml-flow-cli] copied ${count} file(s) from ${sourceDir} to ${targetDir}`);
