#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

function readJsonStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf-8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveChatDir(extra) {
  if (typeof extra.chatDir === 'string' && extra.chatDir.trim()) return extra.chatDir;
  if (typeof extra.chatsBlobBasePath === 'string' && typeof extra.chatsKeyPrefix === 'string') {
    const cardPart = String(extra.chatsKeyPrefix).split('/')[0];
    return path.join(extra.chatsBlobBasePath, cardPart);
  }
  return '';
}

const extra = readJsonStdin();
const boardId = typeof extra.boardId === 'string' ? extra.boardId : '';
const cardId = typeof extra.cardId === 'string' ? extra.cardId : '';
const boardSetupRoot = typeof extra.boardSetupRoot === 'string' ? extra.boardSetupRoot : '';
const boardRuntimeDir = typeof extra.boardRuntimeDir === 'string' ? extra.boardRuntimeDir : 'runtime';
const runtimeStatusDir = typeof extra.runtimeStatusDir === 'string' ? extra.runtimeStatusDir : 'runtime-out';
const cardsDir = typeof extra.cardsDir === 'string' ? extra.cardsDir : 'cards';
const projectRoot = typeof extra.projectRoot === 'string' ? extra.projectRoot : '';
const chatFlowRoot = typeof extra.chatFlowRoot === 'string' ? extra.chatFlowRoot : '';
const chatDir = typeof extra.chatDir === 'string' ? extra.chatDir : '';
const lastChatFile = typeof extra.lastChatFile === 'string' ? extra.lastChatFile : '';
const chatCopilotTimeoutMs = Number.isFinite(Number(extra.chatCopilotTimeoutMs)) && Number(extra.chatCopilotTimeoutMs) > 0
  ? Math.floor(Number(extra.chatCopilotTimeoutMs))
  : 300000;

if (!boardSetupRoot || !lastChatFile) {
  process.stderr.write('missing boardSetupRoot/lastChatFile\n');
  process.exit(1);
}

const boardRuntimeDirAbs = path.join(boardSetupRoot, boardRuntimeDir || 'runtime');
const runtimeStatusDirAbs = path.join(boardSetupRoot, runtimeStatusDir || 'runtime-out');
const cardsDirAbs = path.join(boardSetupRoot, cardsDir || 'cards');
const chatDirAbs = resolveChatDir(extra);
if (!chatDirAbs) {
  process.stderr.write('missing chatDir\n');
  process.exit(1);
}

function readHistory(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^\d+[-_](user|assistant)\.txt$/i.test(f))
      .sort()
      .map((f) => {
        const role = /user/i.test(f) ? 'User' : 'Assistant';
        let text = '';
        try { text = fs.readFileSync(path.join(dir, f), 'utf-8').trim(); } catch {}
        return role + ': ' + text;
      });
  } catch {
    return [];
  }
}

function buildPrompt(cId, history) {
  const cardSetupDirRel = path.join(cardsDir, cId).replace(/\\/g, '/');
  const runtimeDirRel = boardRuntimeDir || 'runtime';
  const statusDirRel = runtimeStatusDir || 'runtime-out';
  const chatDirRel = path.relative(boardSetupRoot, chatDir).replace(/\\/g, '/');
  const lastQueryFileRel = path.join(chatDirRel, lastChatFile).replace(/\\/g, '/');

  const contextBlock = [
    'We are currently doing a three way orchestration.',
    'You are the responder who has context of the cards in ' + cardSetupDirRel + ',',
    'card runtime statuses in ' + runtimeDirRel + ',',
    'and computed outputs in ' + statusDirRel + '.',
    'I am just a mediator passing on the query.',
    'The user sees the data available in cards which is rendered, and the status from ' + statusDirRel + '.',
    'Everything else is internal detail not to be exposed to the user.',
    'The conversation history can be found in ' + chatDirRel + ' and the last query is in ' + lastQueryFileRel + '.',
    'Return only the assistant response text for the user.',
    'Do not write files, and do not include any internal notes, logs, or orchestration details in the response.',
  ].join(' ');

  return [
    contextBlock,
    '',
    ...history,
    'Assistant:',
  ].join('\n');
}

function runWrapper(prompt, sessionDir, workingDir) {
  const fallbackProjectRoot = chatFlowRoot ? path.resolve(chatFlowRoot, '..', '..') : process.cwd();
  const effectiveProjectRoot = projectRoot || fallbackProjectRoot;
  const wrapperPath = path.resolve(
    effectiveProjectRoot,
    'server',
    'board-worker',
    'source-def-flows',
    'copilot-handler',
    'copilot-wrapper.py',
  );
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const tmpBase = os.tmpdir();
  const ts = Date.now();
  const outFile = path.join(tmpBase, 'dch-out-' + cardId + '-' + ts + '.txt');
  const promptFile = path.join(tmpBase, 'dch-prompt-' + cardId + '-' + ts + '.txt');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  const pyArgs = [
    wrapperPath,
    '--output-file', outFile,
    '--session-dir', sessionDir,
    '--cwd', workingDir,
    '--prompt-file', promptFile,
    '--result-type', 'raw',
    '--agent-name', 'demo-chat',
    '--add-dir', boardRuntimeDirAbs,
    '--add-dir', runtimeStatusDirAbs,
    '--add-dir', cardsDirAbs,
    '--add-dir', chatDirAbs,
  ];

  try {
    if (!fs.existsSync(wrapperPath)) {
      throw new Error(`copilot wrapper not found at ${wrapperPath}`);
    }
    spawnSync(python, pyArgs, { stdio: 'inherit', timeout: chatCopilotTimeoutMs });
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : '';
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

function upsertCardsIfChanged() {
  const cliJs = process.env.BOARD_LIVE_CARDS_CLI_JS;
  if (!cliJs || !fs.existsSync(cliJs)) return;
  const rg = boardRuntimeDirAbs;
  const glob = path.join(cardsDirAbs, '*.json');
  try {
    const result = spawnSync(process.execPath, [cliJs, 'upsert-card', '--rg', rg, '--card-glob', glob], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    if (result.status !== 0) {
      const err = (result.stderr || '').toString().trim();
      if (err) console.error('[copilot-chat-assistant] upsert-card: ' + err);
    }
  } catch (err) {
    console.error('[copilot-chat-assistant] upsert-card failed: ' + (err?.message ?? err));
  }
}

const history = readHistory(chatDirAbs);
const sessionDir = path.join(os.tmpdir(), 'demo-chat-handler-sessions', boardId + '_' + cardId);
const workingDir = chatDirAbs;
const prompt = buildPrompt(cardId, history);

try {
  const replyText = runWrapper(prompt, sessionDir, workingDir).trim();
  if (!replyText) {
    throw new Error('Copilot wrapper returned an empty response');
  }
  upsertCardsIfChanged();
  process.stdout.write(JSON.stringify({ replyText }));
} catch (err) {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
}
