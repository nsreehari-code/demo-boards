/**
 * foundry-chat/assistant.js — Foundry-backed chat assistant.
 *
 * Exports `invokeAssistant(extra)`. Loads the shared instructions/skills from
 * chat-flow/ and runs the Foundry agent MCP tool-loop in-process via the shared
 * Node Foundry client (../../lib/foundry-agents.js) — no Python subprocess.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_OUTPUT_FILE_STEM,
  getEnhancedChatMessages,
  requireRequiredStrings,
  resolveBoardLogPath,
  getCardPrivate,
  setCardPrivate,
} from '../shared.js';
import {
  createFoundryClient,
  functionTool,
  sanitizeFunctionName,
  resolveThreadId,
  runAgentToolLoop,
  getLastAssistantText,
} from '../../lib/foundry-agents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_FLOW_DIR = path.resolve(HERE, '..');
const INSTRUCTIONS_DIR = path.join(CHAT_FLOW_DIR, 'instructions');
const SKILLS_DIR = path.join(CHAT_FLOW_DIR, 'skills');

const EXPOSED_TOOL_PREFIXES_DEFAULT = ['liveboards.', 'lore.'];
const STAGE_TOOL_NAME = 'liveboards.stage-ai-response-and-any-attachments';

async function importMcpClient() {
  const clientModule = await import('@modelcontextprotocol/sdk/client/index.js');
  let streamableModule;
  try {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  } catch {
    streamableModule = await import('@modelcontextprotocol/sdk/client/streamable-http.js');
  }
  return {
    Client: clientModule.Client,
    StreamableHTTPClientTransport: streamableModule.StreamableHTTPClientTransport,
  };
}

function normalizeMcpToolResult(result) {
  const structured = result?.structuredContent;
  if (structured !== undefined && structured !== null) {
    return JSON.stringify(structured);
  }
  const content = Array.isArray(result?.content) ? result.content : [];
  const chunks = [];
  for (const entry of content) {
    if (typeof entry?.text === 'string') chunks.push(entry.text);
  }
  if (chunks.length) return chunks.join('');
  if (result?.isError) return JSON.stringify({ error: 'tool returned isError with no text' });
  return '';
}

function mergeLiveboardsRuntimeHandles(toolName, fnArgs, { boardId, cardId, logId, turnId }) {
  const args = fnArgs && typeof fnArgs === 'object' ? { ...fnArgs } : {};
  if (!toolName.startsWith('liveboards.')) return args;
  const legacyToSupported = {
    boardId: 'board_id',
    cardId: 'card_id',
    logId: 'log_id',
    turnId: 'turn_id',
    'turn-id': 'turn_id',
    'tail-turns': 'tail_turns',
    'all-turns': 'all_turns',
    'tail-turns-before-id': 'tail_turns_before_id',
  };
  for (const [legacy, supported] of Object.entries(legacyToSupported)) {
    if (legacy in args && !(supported in args)) args[supported] = args[legacy];
  }
  if (boardId) args.board_id = boardId;
  if (logId) args.log_id = logId;
  if (toolName === STAGE_TOOL_NAME) {
    if (cardId) args.card_id = cardId;
    if (turnId) args.turn_id = turnId;
  }
  return args;
}

function readDirFilesRecursive(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readDirFilesRecursive(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function loadInstructionsAndSkills() {
  const sections = [];

  const instructionFiles = readDirFilesRecursive(INSTRUCTIONS_DIR, (f) => f.toLowerCase().endsWith('.md'))
    .sort();
  for (const file of instructionFiles) {
    try {
      const text = fs.readFileSync(file, 'utf-8').trim();
      if (text) sections.push(`### Instruction: ${path.basename(file)}\n${text}`);
    } catch {}
  }

  if (fs.existsSync(SKILLS_DIR)) {
    const skillEntries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skillDirs = skillEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const name of skillDirs) {
      const skillFile = path.join(SKILLS_DIR, name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        try {
          const text = fs.readFileSync(skillFile, 'utf-8').trim();
          if (text) sections.push(`### Skill: ${name}\n${text}`);
        } catch {}
      }
    }
    for (const entry of skillEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const file = path.join(SKILLS_DIR, entry.name);
        try {
          const text = fs.readFileSync(file, 'utf-8').trim();
          if (text) sections.push(`### Reference: ${entry.name}\n${text}`);
        } catch {}
      }
    }
  }

  return sections.join('\n\n---\n\n');
}

function extractVisibleMessageText(role, text) {
  if (typeof text !== 'string') return '(no text)';
  const trimmed = text.trim();
  if (!trimmed) return '(no text)';
  if (role === 'user') {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
        return parsed.prompt.trim();
      }
    } catch {}
  }
  return trimmed;
}

function parseSystemMessageFileRef(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) return null;
  const match = /^(file uploaded|AI generated|AI geneterated):\s*(\S+?)(?:\s+as\s+\S+)?\s*#(\d+)\s*$/i
    .exec(messageText.trim());
  if (!match) return null;
  const kindRaw = match[1].toLowerCase();
  const kind = kindRaw.startsWith('file') ? 'user-uploaded' : 'ai-generated';
  const fileName = match[2];
  const fileIndex = Number.parseInt(match[3], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) return null;
  return { kind, fileName, fileIndex };
}

function formatAttachmentRefLine(ref) {
  const label = ref.kind === 'ai-generated' ? 'AI-generated attachment' : 'uploaded attachment';
  return `[${label} name: ${ref.fileName}. file-index: ${ref.fileIndex}]`;
}

function formatChatTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'No current turn chat messages.';
  const blocks = [];
  let pendingRefs = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'system' && role !== 'user') continue;
    const text = extractVisibleMessageText(role, message.text);
    if (role === 'system') {
      const ref = parseSystemMessageFileRef(text);
      if (ref) { pendingRefs.push(ref); continue; }
      blocks.push(`System:\n${text}`);
      continue;
    }
    const lines = ["User's Question/Request:"];
    for (const ref of pendingRefs) lines.push(formatAttachmentRefLine(ref));
    pendingRefs = [];
    lines.push(text);
    blocks.push(lines.join('\n'));
  }
  if (pendingRefs.length > 0) {
    const lines = ['Attachments on this card (no user message yet):'];
    for (const ref of pendingRefs) lines.push(formatAttachmentRefLine(ref));
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

export async function invokeAssistant(context, config = {}) {
  const {
    boardId,
    cardId,
    logId,
    turnId,
    serverUrl,
    mcpServerUrl,
    watchPartyDir,
  } = context;
  const {
    streamableMcpServerUrl = '',
    foundryEndpoint = '',
    foundryChatAgentId = '',
    foundryChatExposedMcpToolPrefixes = [],
    chatCopilotTimeoutMs: rawTimeoutMs = 300000,
    enableAssistantDebug = false,
  } = config;

  const chatTimeoutMs = Number.isFinite(Number(rawTimeoutMs)) && Number(rawTimeoutMs) > 0
    ? Math.floor(Number(rawTimeoutMs))
    : 300000;

  const DEBUG_LOG_FILE = resolveBoardLogPath(context, 'foundry-assistant-debug.jsonl');
  const INVOKE_STDERR_LOG_FILE = resolveBoardLogPath(context, 'foundry-invoke.stderr.log');
  if (enableAssistantDebug) {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
  }

  function appendDebug(stage, details = {}) {
    if (!enableAssistantDebug) return;
    try {
      fs.appendFileSync(
        DEBUG_LOG_FILE,
        JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, stage, ...details }) + '\n',
        'utf-8',
      );
    } catch {}
  }

  function persistInvokeFailureLog(kind, details = {}) {
    try {
      fs.mkdirSync(path.dirname(INVOKE_STDERR_LOG_FILE), { recursive: true });
      const lines = [
        `ts=${new Date().toISOString()}`,
        `pid=${process.pid}`,
        `kind=${kind}`,
        `boardId=${boardId}`,
        `cardId=${cardId}`,
        `turnId=${turnId}`,
      ];
      if (details.message) lines.push(`message=${String(details.message)}`);
      if (details.stderr) {
        lines.push('stderr<<EOF');
        lines.push(String(details.stderr));
        lines.push('EOF');
      }
      if (details.stdout) {
        lines.push('stdout<<EOF');
        lines.push(String(details.stdout));
        lines.push('EOF');
      }
      fs.appendFileSync(INVOKE_STDERR_LOG_FILE, `${lines.join('\n')}\n\n`, 'utf-8');
    } catch {}
  }

  function buildSystemInstructions(skillsBlock) {
    const head = [
      'You are responding for one live board chat turn.',
      'Use the available MCP tools (liveboards.* for board/card/chat state, lore.* for durable cross-board memory) to discover what you need; prefer the smallest tool call that resolves this turn.',
      'Treat the runtime handles below as authoritative. Every liveboards.* MCP tool call must use snake_case args and must include the provided opaque log_id exactly as given. Do not derive, alter, or omit it.',
      'Stay grounded in the current turn context — the user message, any current-turn system messages (including attachment references), and the contents of files those attachments point to. Reach into prior chat history only when the user intent clearly requires it.',
      'When the final user-visible reply is ready, call the liveboards.stage-ai-response-and-any-attachments tool exactly once with the final reply text. Do not include markdown fences. No fluff.',
      'Do not expose internal orchestration details, logs, refs, paths, directory names, or implementation notes.',
    ].join(' ');

    const handles = [
      'Runtime handles:',
      `- boardId: "${boardId || '(not provided)'}"`,
      `- cardId / card_id: "${cardId}"`,
      `- logId / log_id: "${logId || '(not provided)'}"`,
      `- turnId / turn_id: "${turnId}"`,
    ].join('\n');

    return [head, '', handles, '', '## Instructions and skills', '', skillsBlock].join('\n');
  }

  requireRequiredStrings({
    foundryEndpoint,
    foundryChatAgentId,
  }, 'foundry-chat assistant');

  appendDebug('foundry-assistant:start', {
    boardId, cardId, turnId, foundryEndpoint, foundryChatAgentId, chatTimeoutMs,
  });

  const outputFile = path.join(watchPartyDir, AGENT_OUTPUT_FILE_STEM);
  fs.writeFileSync(outputFile, 'Reasoning...\n', 'utf-8');

  const existingFoundryPrivate = await getCardPrivate(context, 'foundry');
  const existingThreadId = String(existingFoundryPrivate?.thread_id || '').trim();
  const normalizedMcpServerUrl = streamableMcpServerUrl.trim() || mcpServerUrl;

  const promptChatMessages = await getEnhancedChatMessages(context);
  const transcript = formatChatTranscript(promptChatMessages);
  const skillsBlock = loadInstructionsAndSkills();
  const systemInstructions = buildSystemInstructions(skillsBlock);

  const userPrompt = ['## Current turn transcript', '', transcript].join('\n');

  appendDebug('foundry-assistant:promptBuilt', {
    transcriptLength: transcript.length,
    skillsBlockLength: skillsBlock.length,
    systemInstructionsLength: systemInstructions.length,
  });

  const exposedPrefixes = (Array.isArray(foundryChatExposedMcpToolPrefixes) && foundryChatExposedMcpToolPrefixes.length
    ? foundryChatExposedMcpToolPrefixes
    : EXPOSED_TOOL_PREFIXES_DEFAULT)
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim());

  function appendOutput(line) {
    try { fs.appendFileSync(outputFile, `${line}\n`, 'utf-8'); } catch {}
  }

  const { Client, StreamableHTTPClientTransport } = await importMcpClient();
  const mcpClient = new Client({ name: 'foundry-chat', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(normalizedMcpServerUrl));

  let resolvedThreadId = existingThreadId;
  try {
    appendOutput(`Connecting to MCP server at ${normalizedMcpServerUrl}. Exposed prefixes: ${exposedPrefixes.join(', ')}.`);
    await mcpClient.connect(transport);

    const toolsResult = await mcpClient.listTools();
    const toolsMeta = (toolsResult?.tools || []).filter(
      (t) => exposedPrefixes.length === 0 || exposedPrefixes.some((p) => t.name.startsWith(p)),
    );
    appendOutput(`Discovered ${toolsMeta.length} tools from MCP.`);
    appendDebug('foundry-assistant:toolsDiscovered', { count: toolsMeta.length });

    const nameMap = new Map();
    const tools = toolsMeta.map((t) => {
      const safe = sanitizeFunctionName(t.name);
      nameMap.set(safe, t.name);
      return functionTool(
        safe,
        t.description || `MCP tool ${t.name}`,
        t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      );
    });

    const client = createFoundryClient(foundryEndpoint);
    resolvedThreadId = await resolveThreadId(client, existingThreadId);
    appendOutput(`Resolved thread for card ${cardId}. thread-resolved: thread_id=${resolvedThreadId}; card_id=${cardId}`);
    appendDebug('foundry-assistant:threadResolved', { thread_id: resolvedThreadId });

    let finalReplyStaged = false;

    const loop = await runAgentToolLoop({
      client,
      agentId: foundryChatAgentId,
      threadId: resolvedThreadId,
      userPrompt,
      systemInstructions,
      tools,
      timeoutMs: chatTimeoutMs,
      onProgress: (record) => {
        if (record.stage === 'run-started') appendOutput(`Started Foundry run ${record.run_id}.`);
        else if (record.stage === 'run-completed') appendOutput(`Completed Foundry run ${record.run_id}.`);
      },
      onToolCall: async (fnName, rawArgs) => {
        const realName = nameMap.get(fnName) || fnName;
        const mergedArgs = mergeLiveboardsRuntimeHandles(realName, rawArgs, { boardId, cardId, logId, turnId });
        appendOutput(`Invoking '${realName}' with ${JSON.stringify(mergedArgs).slice(0, 260)}.`);
        let resultText;
        try {
          const result = await mcpClient.callTool({ name: realName, arguments: mergedArgs });
          resultText = normalizeMcpToolResult(result);
        } catch (e) {
          resultText = JSON.stringify({ error: `${realName} failed: ${e?.message || e}` });
        }
        if (realName === STAGE_TOOL_NAME) {
          try {
            const parsed = JSON.parse(resultText);
            if (parsed && typeof parsed === 'object' && parsed.status === 'success') finalReplyStaged = true;
          } catch {}
        }
        return resultText;
      },
      shouldStop: (fnName) => {
        const realName = nameMap.get(fnName) || fnName;
        return realName === STAGE_TOOL_NAME && finalReplyStaged;
      },
    });

    if (finalReplyStaged) {
      appendOutput(`Staged final reply for card ${cardId}. Run ${loop.runId} on thread ${resolvedThreadId} will stop after this stage.`);
    } else {
      // Agent finished without staging — surface the last assistant message ourselves.
      const text = await getLastAssistantText(client, resolvedThreadId);
      if (text.trim()) {
        await mcpClient.callTool({
          name: STAGE_TOOL_NAME,
          arguments: { board_id: boardId, card_id: cardId, turn_id: turnId, text: text.trim(), files: [], log_id: logId },
        });
        finalReplyStaged = true;
      } else {
        throw new Error('run completed but no assistant text was produced');
      }
    }
  } catch (err) {
    persistInvokeFailureLog('invoke-error', { message: err?.stack || err?.message || String(err) });
    appendDebug('foundry-assistant:invokeFailed', { message: err?.message || String(err) });
    throw err;
  } finally {
    try { await mcpClient.close(); } catch {}
  }

  if (resolvedThreadId && resolvedThreadId !== existingThreadId) {
    try { await setCardPrivate(context, 'foundry', { thread_id: resolvedThreadId }); } catch {}
  }

  appendDebug('foundry-assistant:success', { turnId });
  return { assistantHandled: true };
}
