#!/usr/bin/env node

import {
  createArtifactsStore,
  createChatArtifactsStore,
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

function readJsonStdin() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  return new Promise((resolve) => {
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

const input = await readJsonStdin();
const chatsRoot = typeof input.chatsRoot === 'string' ? input.chatsRoot : '';
const cardPrefix = typeof input.cardPrefix === 'string' ? input.cardPrefix : '';
const replyText = typeof input.replyText === 'string' ? input.replyText : '';

if (!chatsRoot || !cardPrefix) {
  process.stderr.write('chat-write-assistant requires chatsRoot and cardPrefix\n');
  process.exit(1);
}

try {
  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: chatsRoot }));
  const adapter = createFsBoardPlatformAdapter(baseRef, { suppressSpawn: true });
  const artifacts = createArtifactsStore(adapter.blobStorage(''));
  const chats = createChatArtifactsStore(artifacts, { indexFileName: '.index.json' });
  const serial = chats.nextSerial(cardPrefix);
  const storedName = `${String(serial).padStart(3, '0')}_assistant.txt`;

  artifacts.putText(`${cardPrefix}/${storedName}`, replyText + '\n', 'text/plain; charset=utf-8');
  chats.appendIndexRecord(cardPrefix, {
    serial,
    role: 'assistant',
    stored_name: storedName,
    path: `${cardPrefix}/chats/${storedName}`,
    updated_at: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify({ replyFile: storedName, replyText }));
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}
