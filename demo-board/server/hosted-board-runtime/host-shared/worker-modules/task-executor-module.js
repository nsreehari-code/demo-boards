import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeRef } from 'yaml-flow/board-live-cards-node';

import { executeTaskExecutorRequest } from '../../../board-worker/task-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TASK_EXECUTOR_PATH = path.resolve(__dirname, '../../../board-worker/task-executor.js');

if (typeof executeTaskExecutorRequest !== 'function') {
  throw new Error(`Task executor module at ${TASK_EXECUTOR_PATH} must export executeTaskExecutorRequest(request)`);
}

export function loadTaskExecutorModule() {
  return executeTaskExecutorRequest;
}

export function createHostedImmediateTaskExecutorRef(boardId, extra = undefined) {
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: TASK_EXECUTOR_PATH }),
    extra: {
      boardId,
      ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
    },
  };
}
