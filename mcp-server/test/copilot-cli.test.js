import assert from 'node:assert/strict';
import test from 'node:test';

import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import {
  buildCopilotCommand,
  runCopilot,
} from '../../demo-board/server/lib/copilot-cli.js';

test('buildCopilotCommand includes agent, files, and named session options', () => {
  const { args } = buildCopilotCommand({
    workingDir: 'C:/workspace',
    addDirs: ['C:/shared'],
    attachments: ['C:/input/report.pdf'],
    agent: 'reviewer',
    sessionName: 'review report',
    reasoningEffort: 'high',
    availableTools: ['read', 'search'],
    additionalMcpConfigs: ['{"mcpServers":{"gik":{"url":"http://localhost:7801/mcp"}}}'],
    model: 'gpt-test',
  });

  assert.deepEqual(args.slice(0, 10), [
    '-C', 'C:/workspace',
    '--agent', 'reviewer',
    '--name', 'review report',
    '--effort', 'high',
    '-s', '--no-ask-user',
  ]);
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('--attachment'));
  assert.ok(args.includes('--available-tools=read,search'));
  assert.ok(args.includes('--additional-mcp-config'));
  assert.ok(args.includes('{"mcpServers":{"gik":{"url":"http://localhost:7801/mcp"}}}'));
  assert.ok(args.includes('gpt-test'));
});

test('runCopilot terminates and settles when the CLI exceeds its timeout', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let terminated = false;

  const result = await runCopilot({
    prompt: 'test',
    timeoutMs: 5,
    spawnProcess: () => child,
    terminateProcess: () => {
      terminated = true;
      return true;
    },
  });

  assert.equal(terminated, true);
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 5ms/);
});

test('buildCopilotCommand supports native session resume selectors', () => {
  assert.ok(buildCopilotCommand({ continueSession: true }).args.includes('--continue'));
  assert.ok(buildCopilotCommand({ sessionId: 'session-id' }).args.includes('session-id'));
  assert.ok(buildCopilotCommand({ resumeSession: 'named session' }).args.includes('--resume=named session'));
});

test('buildCopilotCommand rejects conflicting session modes', () => {
  assert.throws(
    () => buildCopilotCommand({ continueSession: true, sessionId: 'session-id' }),
    /mutually exclusive/,
  );
  assert.throws(
    () => buildCopilotCommand({ resumeSession: 'old session', sessionName: 'new session' }),
    /starting a new session/,
  );
});
