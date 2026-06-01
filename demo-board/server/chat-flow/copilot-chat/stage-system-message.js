#!/usr/bin/env node

import { appendSystemMessage, readJsonStdin, requireRequiredStrings } from './shared.js';

const input = readJsonStdin();
const {
  boardId = '',
  cardId = '',
  turnId = '',
  logId = '',
  text = '',
} = input;

requireRequiredStrings({ boardId, cardId, turnId, text }, 'stage system message');

await appendSystemMessage(boardId, cardId, text, 30000, turnId, logId);

process.stdout.write(JSON.stringify({ ok: true }));