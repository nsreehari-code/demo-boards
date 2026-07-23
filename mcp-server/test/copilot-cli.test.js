import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCopilotCommand } from '../../demo-board/server/lib/copilot-cli.js';
import { prepareRunArguments } from '../src/handlers/copilot.js';

test('buildCopilotCommand includes agent, files, and named session options', () => {
  const { args } = buildCopilotCommand({
    workingDir: 'C:/workspace',
    addDirs: ['C:/shared'],
    attachments: ['C:/input/report.pdf'],
    agent: 'reviewer',
    sessionName: 'review report',
    reasoningEffort: 'high',
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
  assert.ok(args.includes('gpt-test'));
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

test('prepareRunArguments uses a project agent owning root when cwd is omitted', () => {
  const config = prepareRunArguments({
    message: 'Check community PRs',
    agent: 'reactor-community-pr-followup',
  });

  assert.match(config.cwd.replaceAll('\\', '/'), /\/ai-tool-evolver$/);
});
