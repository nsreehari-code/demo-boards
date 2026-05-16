#!/usr/bin/env node

import fs from 'node:fs';

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

function pickFailureDetail(input) {
  const candidates = [
    input?.error,
    input?.reason,
    input?.message,
    input?.failure,
    input?.stepError,
    input?.data?.error,
    input?.data?.reason,
    input?.result?.error,
    input?.result?.reason,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim()) {
      return value.message.trim();
    }
  }
  return '';
}

const input = readJsonStdin();
const cardId = typeof input.cardId === 'string' ? input.cardId : '';
const serverUrl = typeof input.serverUrl === 'string' ? input.serverUrl.replace(/\/$/, '') : '';
const apiBasePath = typeof input.apiBasePath === 'string' ? input.apiBasePath : '/api/board';
const failureDetail = pickFailureDetail(input);

if (!cardId || !serverUrl) {
  process.stderr.write('chat-write-failure requires cardId and serverUrl\n');
  process.exit(1);
}

const failureText = failureDetail
  ? `Assistant request failed: ${failureDetail}`
  : 'Assistant request failed.';

try {
  const postUrl = `${serverUrl}${apiBasePath}/cards/${encodeURIComponent(cardId)}/chats`;
  const postRes = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'system', text: failureText, files: [], done: false }),
  });
  if (!postRes.ok) {
    const err = await postRes.text();
    process.stderr.write(`chat-write-failure POST failed: ${err}\n`);
    process.exit(1);
  }
  const postData = await postRes.json();
  process.stdout.write(JSON.stringify({ failureId: postData?.id, failureText }));
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}