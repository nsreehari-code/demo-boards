import {
  registerInProcessBoardWorkerCallback,
  unregisterInProcessBoardWorkerCallback,
} from 'yaml-flow/board-worker-adapter';

/**
 * Shared wiring for the embedded (single-process) board-worker source-fetch
 * callback.
 *
 * In the two-process split, the in-process task executor reports source-fetch
 * completion by spawning a child `node` that POSTs `webhook.source-fetch-done`
 * to controlface's `/mcp-webhooks` HTTP endpoint (board-worker-callback-http).
 * That delivery is a *synchronous* `spawnSync`, which is fine while controlface
 * runs in its own process. Inside the embedded host, controlface shares the
 * executor's event loop, so the blocking `spawnSync` cannot be answered by the
 * very loop it froze — a self-deadlock.
 *
 * The in-process callback transport avoids the child process entirely: the
 * executor's `reportComplete` dispatches straight to a registered handler on
 * the event loop. controlface registers that handler (keyed by board) and
 * forwards the webhook to its own runtime exactly as the inbound HTTP POST
 * would have, so board state and notifications are updated identically.
 */

export const EMBEDDED_ENV_FLAG = 'DEMO_BOARDS_EMBEDDED';

export function isEmbeddedHost() {
  return process.env[EMBEDDED_ENV_FLAG] === '1';
}

export function boardSourceFetchCallbackKey(boardId) {
  return `board-source-fetch::${String(boardId || '').trim()}`;
}

/**
 * Register an in-process source-fetch callback handler for a board.
 *
 * @param {string} boardId
 * @param {(body: { tool: string, args: Record<string, unknown> }) => Promise<unknown>} dispatchWebhook
 *   Forwards `{ tool, args }` to the owning board runtime's `mcp-webhooks`
 *   route and resolves when it has been processed (throws on failure).
 * @returns {() => void} unregister
 */
export function registerBoardSourceFetchInProcessCallback(boardId, dispatchWebhook) {
  const key = boardSourceFetchCallbackKey(boardId);
  registerInProcessBoardWorkerCallback(key, async (payload) => {
    if (payload?.outcome === 'failure') {
      await dispatchWebhook({
        tool: 'webhook.source-fetch-failed',
        args: { token: payload.token, reason: payload.reason || 'source fetch failed' },
      });
    } else {
      await dispatchWebhook({
        tool: 'webhook.source-fetch-done',
        args: { token: payload.token, ref: payload.ref },
      });
    }
    return { status: 'success' };
  });
  return () => unregisterInProcessBoardWorkerCallback(key);
}
