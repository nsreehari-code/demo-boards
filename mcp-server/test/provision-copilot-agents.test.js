import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(testDirectory, '..');
const provisioner = path.join(serverDirectory, 'scripts', 'provision-copilot-agents.mjs');

test('Copilot provisioner creates an MCP-discoverable custom agent workspace', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-provision-'));
  const workspace = path.join(temporaryDirectory, 'workspace');
  try {
    execFileSync(process.execPath, [
      provisioner,
      '--target-dir', workspace,
      '--repo-name', 'provision-test',
    ], { stdio: 'pipe' });

    const agentPath = path.join(workspace, '.github', 'agents', 'simple-chat.agent.md');
    assert.equal(fs.existsSync(agentPath), true);
    const agent = fs.readFileSync(agentPath, 'utf8');
    assert.match(agent, /^---\r?\nname: provision-test-simple-chat/m);
    assert.match(agent, /host runtime validates and executes every tool call/);
    assert.equal(fs.existsSync(path.join(workspace, '.git')), true);
    assert.equal(fs.existsSync(path.join(workspace, '.github', 'copilot-instructions.md')), true);
    assert.equal(fs.existsSync(path.join(workspace, '.github', 'hooks', 'session-logging.json')), true);
    assert.equal(fs.existsSync(path.join(workspace, '.github', 'skills', 'live-board-cards-soul', 'SKILL.md')), true);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});