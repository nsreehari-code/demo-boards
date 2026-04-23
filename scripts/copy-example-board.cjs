#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function findYamlFlowExampleDir() {
  const yamlFlowEntry = require.resolve('yaml-flow');

  // Resolve package root without touching package.json (which may be blocked by exports).
  let dir = path.dirname(yamlFlowEntry);
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, 'examples', 'example-board');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Could not locate yaml-flow examples/example-board from entry ${yamlFlowEntry}`);
}

function copyExampleBoardToRoot() {
  const srcDir = findYamlFlowExampleDir();
  const destDir = path.join(process.cwd(), 'default-board');

  if (fs.existsSync(destDir)) {
    const stat = fs.statSync(destDir);
    if (!stat.isDirectory()) {
      throw new Error(`[copy-example-board] ${destDir} exists but is not a directory`);
    }
    console.log(`[copy-example-board] skipped: ${destDir} already exists`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    fs.cpSync(from, to, { recursive: true, force: true });
  }

  console.log(`[copy-example-board] copied ${entries.length} entries from ${srcDir} to ${destDir}`);
}

try {
  copyExampleBoardToRoot();
} catch (err) {
  console.error(`[copy-example-board] ${String(err && err.message || err)}`);
  process.exit(1);
}
