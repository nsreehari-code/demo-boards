#!/usr/bin/env node

/**
 * Embedded single-process host.
 *
 * Runs the controlface HTTP server and the queue-runner lanes in ONE process,
 * replacing the two-process (controlface + queue-runner) PM2 split. The two
 * halves still coordinate over the existing 127.0.0.1 loopback channels
 * (notify-q / mcp-webhooks / sse-q) — this first increment is a faithful
 * collapse with no behavioural change. A later increment swaps the loopback
 * for direct in-process emitNotification on a shared runtime instance.
 *
 * Additive: controlface-server.js and queue-runner.js remain runnable
 * standalone (their auto-run is guarded by an entrypoint check), so the old
 * two-process path stays available as a fallback.
 *
 * The spawned executors (copilot / foundry / source-def task executors) keep
 * their own OS-process isolation regardless of this merge.
 */

import { startControlface } from '../http-mcp-controlface/controlface-server.js';
import { startQueueRunner } from '../queue-runner/queue-runner.js';
import { createLogger, HOSTED_SERVER_LOG_PATH } from '../host-shared/logging.js';
import { EMBEDDED_ENV_FLAG } from '../host-shared/in-process-source-fetch-callback.js';

// Mark this process as the embedded single-process host BEFORE either half is
// imported-and-run, so both controlface and the queue-runner switch the
// board-worker source-fetch callback to the in-process transport instead of
// the spawnSync HTTP delivery (which self-deadlocks when both share an event
// loop). See in-process-source-fetch-callback.js for the rationale.
process.env[EMBEDDED_ENV_FLAG] = '1';

async function main() {
  const logger = createLogger('embedded', { filePath: HOSTED_SERVER_LOG_PATH });
  logger.info('[embedded] starting controlface + queue-runner in a single process');

  // Start controlface first and wait until it is listening (and sample boards
  // are bootstrapped) so the queue-runner's loopback clients can connect.
  const controlface = await startControlface();
  logger.info('[embedded] controlface ready; starting queue-runner lanes');

  // The queue-runner registers its own SIGINT/SIGTERM shutdown (drains lanes,
  // then process.exit) which tears down the whole process, including the
  // controlface listener.
  const queue = await startQueueRunner();
  logger.info('[embedded] queue-runner lanes started; embedded host ready');

  return { controlface, queue };
}

main().catch((error) => {
  const logger = createLogger('embedded', { filePath: HOSTED_SERVER_LOG_PATH });
  logger.error(`[embedded] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
