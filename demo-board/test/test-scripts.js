#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const boardRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(boardRoot, '..');
const cliSourceDir = path.join(boardRoot, 'scripts', 'cli');
const require = createRequire(import.meta.url);
const yamlFlowBundledDir = path.dirname(require.resolve('yaml-flow/cli-bundled/board-live-cards-cli.mjs'));

const entrypointFileNames = [
  'discover-source-kinds.js',
  'inspect-board-runtime-status.js',
  'inspect-card-definition-and-runtime.js',
  'inspect-chat-messages-on-cards.js',
  'inspect-file-contents.js',
  'manage-live-board-card.js',
  'preflight-materialize-candidate-card.js',
  'preflight-probe-single-source-in-candidate-card.js',
  'preflight-run-one-cycle-with-candidate-card.js',
  'preflight-run-single-source-in-candidate-card.js',
  'preflight-validate-candidate-card-definition.js',
  'provide-response-to-user.js',
];

function serializeFsPathRef(filePath) {
  return `b64:${Buffer.from(JSON.stringify({ kind: 'fs-path', value: filePath }), 'utf8').toString('base64url')}`;
}

function copyCliJsFiles(targetDir) {
  const childNames = fs.readdirSync(cliSourceDir);
  for (const childName of childNames) {
    if (!childName.endsWith('.js')) {
      continue;
    }
    fs.copyFileSync(path.join(cliSourceDir, childName), path.join(targetDir, childName));
  }
}

function writeKnownConstants(targetDir) {
  const baseRef = serializeFsPathRef(path.join(targetDir, 'board-runtime'));
  fs.writeFileSync(
    path.join(targetDir, 'known_constants.json'),
    `${JSON.stringify({
      base_ref: baseRef,
      yaml_flow_cli_bundled_dir: yamlFlowBundledDir,
    }, null, 2)}\n`,
    'utf8',
  );
}

function runHelpSmoke(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const combined = `${stdout}${stderr}`;
  assert.equal(result.status, 0, `${path.basename(scriptPath)} --help failed:\n${combined}`);
  assert.match(combined, /Usage:/, `${path.basename(scriptPath)} --help did not print usage:\n${combined}`);
}

function main() {
  assert.ok(fs.existsSync(cliSourceDir), `CLI source directory not found: ${cliSourceDir}`);
  assert.ok(fs.existsSync(yamlFlowBundledDir), `yaml-flow bundled CLI directory not found: ${yamlFlowBundledDir}`);
  for (const fileName of ['board-live-cards-cli.mjs', 'card-store-cli.mjs', 'chat-store-cli.mjs']) {
    assert.ok(fs.existsSync(path.join(yamlFlowBundledDir, fileName)), `Missing bundled CLI file: ${fileName}`);
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-board-cli-smoke-'));
  try {
    fs.writeFileSync(path.join(stageDir, 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');
    copyCliJsFiles(stageDir);
    writeKnownConstants(stageDir);

    for (const entrypointFileName of entrypointFileNames) {
      runHelpSmoke(path.join(stageDir, entrypointFileName));
    }

    const manageHelp = spawnSync(process.execPath, [path.join(stageDir, 'manage-live-board-card.js'), '--help'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const manageCombined = `${manageHelp.stdout || ''}${manageHelp.stderr || ''}`;
    assert.equal(manageHelp.status, 0, `manage-live-board-card.js --help failed:\n${manageCombined}`);

    console.log(`wrapper smoke test passed for ${entrypointFileNames.length} scripts`);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}