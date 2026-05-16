#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  createArtifactsStore,
  createFsBoardPlatformAdapter,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

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

function resolveMarker(extra) {
  const chatsRoot = typeof extra.chatsRoot === 'string' ? extra.chatsRoot : (typeof extra.chatsBlobBasePath === 'string' ? extra.chatsBlobBasePath : '');
  const markerKey = typeof extra.chatProcessingMarkerKey === 'string' ? extra.chatProcessingMarkerKey.trim() : '';
  const markerPath = typeof extra.processingMarkerPath === 'string' && extra.processingMarkerPath.trim()
    ? extra.processingMarkerPath.trim()
    : path.join(resolveChatDir(extra), '.processing');
  return { chatsRoot, markerKey, markerPath };
}

const input = readJsonStdin();
const { chatsRoot, markerKey, markerPath } = resolveMarker(input);

try {
  if (markerKey && chatsRoot) {
    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: chatsRoot }));
    const adapter = createFsBoardPlatformAdapter(baseRef, { suppressSpawn: true });
    const artifacts = createArtifactsStore(adapter.blobStorage(''));
    artifacts.remove(markerKey);
  } else if (markerPath) {
    fs.rmSync(markerPath, { force: true });
  }
  process.stdout.write(JSON.stringify({ cleared: true }));
} catch (err) {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}
