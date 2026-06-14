/**
 * foundry-agents.js — Shared Azure AI Foundry Agent client + tool-loop for both lanes.
 *
 * Replaces the per-lane Python invoke.py helpers. Uses the Azure Node SDK
 * (@azure/ai-agents + @azure/identity DefaultAzureCredential) entirely in-process,
 * so the task-executor (board-worker) and chat (chat-flow) lanes share one
 * invocation path — mirroring the copilot-cli.js unification.
 *
 * Auth: DefaultAzureCredential (Managed Identity in prod, `az login` locally).
 */

import { createRequire } from 'node:module';
import { DefaultAzureCredential } from '@azure/identity';
import { AgentsClient } from '@azure/ai-agents';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withWindowsHiddenChildProcesses(fn) {
  if (process.platform !== 'win32') {
    return fn();
  }

  const originalExec = childProcess.exec;
  const originalExecFile = childProcess.execFile;

  childProcess.exec = function patchedExec(command, options, callback) {
    let normalizedOptions = options;
    let normalizedCallback = callback;

    if (typeof normalizedOptions === 'function') {
      normalizedCallback = normalizedOptions;
      normalizedOptions = undefined;
    }

    return originalExec.call(this, command, { ...(normalizedOptions || {}), windowsHide: true }, normalizedCallback);
  };

  childProcess.execFile = function patchedExecFile(file, args, options, callback) {
    let normalizedArgs = args;
    let normalizedOptions = options;
    let normalizedCallback = callback;

    if (!Array.isArray(normalizedArgs)) {
      normalizedCallback = normalizedOptions;
      normalizedOptions = normalizedArgs;
      normalizedArgs = [];
    }
    if (typeof normalizedOptions === 'function') {
      normalizedCallback = normalizedOptions;
      normalizedOptions = undefined;
    }

    return originalExecFile.call(
      this,
      file,
      normalizedArgs,
      { ...(normalizedOptions || {}), windowsHide: true },
      normalizedCallback,
    );
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      childProcess.exec = originalExec;
      childProcess.execFile = originalExecFile;
    });
}

class WindowsHiddenCredential {
  constructor(inner) {
    this.inner = inner;
  }

  async getToken(scopes, options) {
    return await withWindowsHiddenChildProcesses(() => this.inner.getToken(scopes, options));
  }
}

/** Create a Foundry AgentsClient for the given project endpoint. */
export function createFoundryClient(endpoint) {
  const ep = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!ep) throw new Error('foundry endpoint is required');
  const credential = new WindowsHiddenCredential(new DefaultAzureCredential());
  return new AgentsClient(ep, credential);
}

/**
 * Foundry function names must match ^[a-zA-Z0-9_-]{1,64}$. MCP tools use dots
 * which are not allowed -> swap to underscores and truncate.
 */
export function sanitizeFunctionName(name) {
  const safe = String(name || '')
    .split('')
    .map((c) => (/[a-zA-Z0-9_-]/.test(c) ? c : '_'))
    .join('');
  return safe.slice(0, 64);
}

/** Build a FunctionToolDefinition plain object accepted by the SDK. */
export function functionTool(name, description, parameters) {
  const params = parameters && typeof parameters === 'object' && parameters.type
    ? parameters
    : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name,
      description: description ? String(description).slice(0, 1024) : `Function ${name}`,
      parameters: params,
    },
  };
}

async function cancelActiveRunsOnThread(client, threadId) {
  const activeIds = [];
  try {
    for await (const run of client.runs.list(threadId)) {
      if (run.status && !TERMINAL_RUN_STATUSES.has(run.status)) activeIds.push(run.id);
      if (activeIds.length >= 5) break;
    }
  } catch {
    return false;
  }
  if (activeIds.length === 0) return true;
  for (const runId of activeIds) {
    try {
      await client.runs.cancel(threadId, runId);
    } catch {
      continue;
    }
    let cleared = false;
    for (let i = 0; i < 20; i += 1) {
      try {
        const r = await client.runs.get(threadId, runId);
        if (TERMINAL_RUN_STATUSES.has(r.status)) {
          cleared = true;
          break;
        }
      } catch {
        cleared = true;
        break;
      }
      await sleep(500);
    }
    if (!cleared) return false;
  }
  return true;
}

async function cancelRunIfActive(client, threadId, runId) {
  if (!runId) return false;
  try {
    const run = await client.runs.get(threadId, runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return true;
  } catch {
    return false;
  }
  try {
    await client.runs.cancel(threadId, runId);
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      const run = await client.runs.get(threadId, runId);
      if (TERMINAL_RUN_STATUSES.has(run.status)) return true;
    } catch {
      return true;
    }
    await sleep(500);
  }
  return false;
}

/** Return a usable thread id, reusing an existing one when it is clear. */
export async function resolveThreadId(client, existingThreadId) {
  const candidate = String(existingThreadId || '').trim();
  if (candidate) {
    try {
      await client.threads.get(candidate);
      if (await cancelActiveRunsOnThread(client, candidate)) return candidate;
    } catch {
      // fall through to create a fresh thread
    }
  }
  const thread = await client.threads.create();
  return thread.id;
}

/** Extract the most recent assistant text from a thread. */
export async function getLastAssistantText(client, threadId) {
  try {
    for await (const msg of client.messages.list(threadId, { order: 'desc', limit: 10 })) {
      if (msg.role !== 'assistant') continue;
      const parts = [];
      for (const item of msg.content || []) {
        if (item?.type === 'text' && item.text?.value) parts.push(item.text.value);
      }
      const text = parts.join('').trim();
      if (text) return text;
    }
  } catch {
    // best effort
  }
  return '';
}

/**
 * Drive an agent run with a tool loop on the given thread.
 *
 * Posts `userPrompt` as a user message (when provided), creates a run with the
 * supplied `tools` + `systemInstructions` (additional_instructions), then polls:
 *  - queued / in_progress  -> sleep and re-fetch
 *  - requires_action       -> invoke onToolCall(name, args) per call, submit outputs
 *  - completed             -> resolve (optionally fetching the final assistant text)
 *  - failed/cancelled/...  -> throw
 *
 * onToolCall(name, args) -> Promise<string>. shouldStop(name, output) -> boolean:
 * when true, the run is cancelled after submitting outputs and the loop returns
 * with `stoppedEarly: true` (used by chat once the final reply is staged).
 *
 * Returns { status, stoppedEarly, runId, threadId, finalText }.
 */
export async function runAgentToolLoop({
  client,
  agentId,
  threadId,
  userPrompt = '',
  systemInstructions = '',
  tools = [],
  onToolCall,
  shouldStop,
  onProgress,
  timeoutMs = 2100000,
  maxIters = null,
  fetchFinalText = false,
}) {
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  const maxIterations = Number.isFinite(maxIters) && maxIters > 0
    ? Math.floor(maxIters)
    : null;

  if (userPrompt) {
    await client.messages.create(threadId, 'user', userPrompt);
  }

  let run = await client.runs.create(threadId, agentId, {
    additionalInstructions: systemInstructions || undefined,
    tools: tools && tools.length ? tools : undefined,
  });
  emit({ stage: 'run-started', run_id: run.id });

  const deadline = Date.now() + timeoutMs;
  let iters = 0;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`run ${run.id} exceeded timeoutMs=${timeoutMs}`);
    }
    iters += 1;
    if (maxIterations !== null && iters > maxIterations) {
      throw new Error(`run ${run.id} exceeded maxIters=${maxIterations}`);
    }

    if (run.status === 'queued' || run.status === 'in_progress') {
      await sleep(1000);
      run = await client.runs.get(threadId, run.id);
      continue;
    }

    if (run.status === 'requires_action') {
      const toolCalls = run.requiredAction?.submitToolOutputs?.toolCalls || [];
      const outputs = [];
      let stop = false;
      for (const tc of toolCalls) {
        const fnName = tc.function?.name || '';
        let args = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          args = {};
        }
        emit({ stage: 'tool-call', name: fnName, args_preview: JSON.stringify(args).slice(0, 300) });
        let output;
        try {
          output = await onToolCall(fnName, args);
        } catch (e) {
          output = JSON.stringify({ error: `${fnName} failed: ${e?.message || e}` });
        }
        if (typeof output !== 'string') {
          output = output == null ? '' : JSON.stringify(output);
        }
        if (typeof shouldStop === 'function' && shouldStop(fnName, output)) stop = true;
        outputs.push({ toolCallId: tc.id, output });
      }

      run = await client.runs.submitToolOutputs(threadId, run.id, outputs);

      if (stop) {
        await cancelRunIfActive(client, threadId, run.id);
        return { status: 'completed', stoppedEarly: true, runId: run.id, threadId, finalText: '' };
      }
      continue;
    }

    if (run.status === 'completed') {
      emit({ stage: 'run-completed', run_id: run.id });
      const finalText = fetchFinalText ? await getLastAssistantText(client, threadId) : '';
      return { status: 'completed', stoppedEarly: false, runId: run.id, threadId, finalText };
    }

    // failed / cancelled / expired / unknown
    const lastError = run.lastError ? JSON.stringify(run.lastError) : '';
    throw new Error(`run ${run.id} ended with status=${run.status} lastError=${lastError}`);
  }
}
