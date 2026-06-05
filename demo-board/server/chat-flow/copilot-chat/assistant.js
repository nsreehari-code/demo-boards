import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AGENT_OUTPUT_FILE_STEM,
  getEnhancedChatMessages,
  getCardPrivate,
  requireRequiredStrings,
  resolveBoardLogPath,
} from '../shared.js';

const COPILOT_MODEL = 'gpt-5.4';

function normalizeWorkspaceStem(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveCopilotWorkspaceDirByStem(aiWorkspaceRootPath, workspaceStem, contextLabel = 'assistant') {
  requireRequiredStrings({ aiWorkspaceRoot: aiWorkspaceRootPath, workspaceStem }, contextLabel);
  if (!fs.existsSync(aiWorkspaceRootPath)) {
    throw new Error(`Missing required ${contextLabel} input: aiWorkspaceRoot directory`);
  }
  const workingDir = path.join(aiWorkspaceRootPath, workspaceStem);
  if (!fs.existsSync(workingDir)) {
    throw new Error(`Missing required ${contextLabel} input: copilot workspace ${workspaceStem}`);
  }
  return workingDir;
}

function parseSystemMessageFileRef(messageText) {
  if (typeof messageText !== 'string' || !messageText.trim()) {
    return null;
  }

  const match = /^(file uploaded|AI generated|AI geneterated):\s*(\S+?)(?:\s+as\s+\S+)?\s*#(\d+)\s*$/i.exec(messageText.trim());
  if (!match) {
    return null;
  }

  const kindRaw = match[1].toLowerCase();
  const kind = kindRaw.startsWith('file') ? 'user-uploaded' : 'ai-generated';
  const fileName = match[2];
  const fileIndex = Number.parseInt(match[3], 10);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    return null;
  }

  return { kind, fileName, fileIndex };
}

function extractVisibleMessageText(role, text) {
  if (typeof text !== 'string') {
    return '(no text)';
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return '(no text)';
  }

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

function formatAttachmentRefLine(ref) {
  const label = ref.kind === 'ai-generated' ? 'AI-generated attachment' : 'uploaded attachment';
  return `[${label} name: ${ref.fileName}. file-index: ${ref.fileIndex}]`;
}

function formatChatTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'No current turn chat messages.';
  }

  const blocks = [];
  let pendingAttachmentRefs = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'system' && role !== 'user') continue;
    const text = extractVisibleMessageText(role, message.text);

    if (role === 'system') {
      const ref = parseSystemMessageFileRef(text);
      if (ref) {
        pendingAttachmentRefs.push(ref);
        continue;
      }
      blocks.push(`System:\n${text}`);
      continue;
    }

    const lines = ["User's Question/Request:"];
    for (const ref of pendingAttachmentRefs) {
      lines.push(formatAttachmentRefLine(ref));
    }
    pendingAttachmentRefs = [];
    lines.push(text);
    blocks.push(lines.join('\n'));
  }

  if (pendingAttachmentRefs.length > 0) {
    const lines = ['Attachments on this card (no user message yet):'];
    for (const ref of pendingAttachmentRefs) {
      lines.push(formatAttachmentRefLine(ref));
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

function findAssistantMessage(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && typeof message.text === 'string' && message.text.trim().length > 0) {
      return message;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAssistantMessage(context, cardId, timeoutMs = 10000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const turnMessages = await getEnhancedChatMessages(context, { cardId });
    const assistantMessage = findAssistantMessage(turnMessages);
    if (assistantMessage) {
      return assistantMessage;
    }
    if (Date.now() < deadline) {
      await sleep(pollMs);
    }
  }
  return null;
}

function buildCombinedRepairPrompt(cardIdValue) {
  return [
    'The previous attempt did not produce an acceptable result. Fix the issues below before completing.',
    'No final assistant reply was observed through provide-final-reply-to-user.',
    `Write the final user-visible reply using cardId: ${cardIdValue} and the runtime turnId.`,
    'Use provide-final-reply-to-user exactly once.',
    'Do not return reply text through stdout or any other response channel.'
  ].join('\n');
}

export async function invokeAssistant(context, config = {}) {
  const {
    boardId,
    cardId,
    logId,
    turnId,
    watchPartyDir,
  } = context;
  const {
    aiWorkspaceRoot = '',
    chatCopilotTimeoutMs: rawChatCopilotTimeoutMs = 300000,
    enableAssistantDebug = false,
  } = config;

  const chatCopilotTimeoutMs = Number.isFinite(Number(rawChatCopilotTimeoutMs)) && Number(rawChatCopilotTimeoutMs) > 0
    ? Math.floor(Number(rawChatCopilotTimeoutMs))
    : 300000;

  const DEBUG_LOG_FILE = resolveBoardLogPath(context, 'copilot-assistant-debug.jsonl');
  const agentOutputFile = path.join(watchPartyDir, AGENT_OUTPUT_FILE_STEM);
  if (enableAssistantDebug) {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
  }

  function appendDebug(stage, details = {}) {
    if (!enableAssistantDebug) return;
    try {
      fs.appendFileSync(
        DEBUG_LOG_FILE,
        JSON.stringify({
          ts: new Date().toISOString(),
          pid: process.pid,
          stage,
          ...details,
        }) + '\n',
        'utf-8'
      );
    } catch {}
  }

  function buildPrompt(cId, currentLogId, turnTranscript) {
    const instructionsBlock = [
      'You are responding for one live board chat turn.',
      'Use the available agent instructions, skills, and MCP tools to discover what you need. Prefer the smallest additional read or tool call that resolves the current turn.',
      'Treat the runtime handles below as authoritative. Every liveboards.* MCP tool call must use snake_case args and must include the provided opaque log_id exactly as given. Do not derive, alter, or omit it.',
      'Stay grounded in the current turn context — the current-turn user message, any current-turn system messages (including attachments referenced by them), and the contents of files those attachments point to. Read referenced attachment contents before reasoning. Reach into nearby board state or prior chat history only when the user intent clearly requires it; never use prior chat history to guess the current turn\u2019s answer.',
      'When the final user-visible reply is ready, use the provide-final-reply-to-user skill exactly once.',
      'Do not expose internal orchestration details, logs, refs, paths, directory names, or implementation notes.',
      'Do not include markdown fences. No fluff.',
    ].join(' ');

    const runtimeHandlesBlock = [
      'Runtime handles:',
      `- boardId: \"${boardId || '(not provided)'}\"`,
      `- cardId / card_id: "${cId}"`,
      `- logId / log_id: "${currentLogId || '(not provided)'}"`,
      `- turnId / turn_id: "${turnId}"`,
    ].join('\n');

    return [
      instructionsBlock,
      '',
      runtimeHandlesBlock,
      '',
      turnTranscript,
    ].join('\n');
  }

  async function resolveWorkspaceStem() {
    const copilotPrivate = await getCardPrivate(context, 'copilot');
    return normalizeWorkspaceStem(copilotPrivate?.ws) || 'default';
  }

  function runCopilot(prompt, workingDir, options = {}) {
    const { continueSession = false } = options;

    return new Promise((resolve, reject) => {
      const copilotArgs = [
        '-C', workingDir,
        ...(continueSession ? ['--continue'] : []),
        '-s',
        '--no-ask-user',
        '--allow-all-tools',
        '--model', COPILOT_MODEL,
      ];
      const execCommand = process.platform === 'win32' ? 'cmd.exe' : 'copilot';
      const execArgs = process.platform === 'win32'
        ? ['/d', '/c', 'copilot', ...copilotArgs]
        : copilotArgs;
      const outStream = fs.createWriteStream(agentOutputFile, { flags: 'w' });
      outStream.write("Reasoning...\n");
      let settled = false;
      let timeoutId = null;
      let stderrBuf = '';

      const finish = (handler) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        outStream.end(() => handler());
      };

      const child = spawn(execCommand, execArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });

      child.stdout.on('data', (chunk) => { outStream.write(chunk); });
      child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      child.on('error', (err) => {
        finish(() => {
          const errorText = stderrBuf.trim();
          appendDebug('runCopilot:error', { message: err?.message ?? String(err), stderr: errorText || undefined });
          reject(errorText ? new Error(errorText) : err);
        });
      });
      child.on('close', (code) => {
        finish(() => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(stderrBuf.trim() || `copilot exited with code ${code ?? 'unknown'}`));
        });
      });

      timeoutId = setTimeout(() => { child.kill(); }, chatCopilotTimeoutMs);
      child.stdin.end(prompt);
    });
  }

  async function runCopilotWithValidationRetries(prompt, workingDir, cardIdValue) {
    const maxAttempts = 4;
    let attempt = 0;
    let assistantMessage = null;

    while (attempt < maxAttempts) {
      await runCopilot(
        attempt === 0 ? prompt : buildCombinedRepairPrompt(cardIdValue),
        workingDir,
        { continueSession: attempt > 0 },
      );
      assistantMessage = await waitForAssistantMessage(context, cardIdValue);
      if (assistantMessage) {
        break;
      }
      attempt += 1;
    }

    if (!assistantMessage) {
      throw new Error("copilot couldn't produce a valid response");
    }

    return assistantMessage;
  }

  requireRequiredStrings({
    aiWorkspaceRoot,
  }, 'assistant');

  appendDebug('assistant:start', {
    boardId, cardId, turnId, aiWorkspaceRoot, chatCopilotTimeoutMs,
  });

  const workspaceStem = await resolveWorkspaceStem();
  const workingDir = resolveCopilotWorkspaceDirByStem(aiWorkspaceRoot, workspaceStem, 'assistant');
  const promptChatMessages = await getEnhancedChatMessages(context, { cardId });
  const turnTranscript = formatChatTranscript(promptChatMessages);
  const prompt = buildPrompt(cardId, logId, turnTranscript);
  appendDebug('assistant:promptBuilt', {
    workingDir,
    workspaceStem,
    promptMessageCount: Array.isArray(promptChatMessages) ? promptChatMessages.length : 0,
    historyDumpLength: turnTranscript.length,
    promptLength: prompt.length,
  });

  try {
    const assistantMessage = await runCopilotWithValidationRetries(prompt, workingDir, cardId);
    const assistantResponseText = typeof assistantMessage?.text === 'string'
      ? assistantMessage.text
      : '';
    appendDebug('assistant:success', {
      publishedAttachmentCount: Array.isArray(assistantMessage?.files) ? assistantMessage.files.length : 0,
      assistantResponseText,
      turnId,
    });
    return { assistantHandled: true };
  } catch (err) {
    appendDebug('assistant:error', { message: err?.message ?? String(err) });
    throw err;
  }
}
