import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFilePath = path.join(__dirname, 'log.jsonl');
const knownConstantsPath = path.join(__dirname, 'known_constants.json');

const TOOL_SEMANTIC_NAME_MAP = new Map([
  ['discover-source-kinds.js', 'Discover Source Kinds'],
  ['inspect-board-runtime-status.js', 'Inspect Board Runtime Status'],
  ['inspect-card-definition-and-runtime.js', 'Inspect Card Definition And Runtime'],
  ['inspect-chat-messages-on-cards.js', 'Inspect Card Chat Messages'],
  ['inspect-file-contents.js', 'Inspect Attachment File Contents'],
  ['manage-live-board-card.js', 'Manage Live Board Card'],
  ['preflight-candidate-card-common.js', 'Preflight Candidate Card Common Utilities'],
  ['preflight-materialize-candidate-card.js', 'Preflight Materialize Candidate Card'],
  ['preflight-probe-single-source-in-candidate-card.js', 'Preflight Probe Single Source'],
  ['preflight-run-one-cycle-with-candidate-card.js', 'Preflight Run One Cycle'],
  ['preflight-run-single-source-in-candidate-card.js', 'Preflight Run Single Source'],
  ['preflight-validate-candidate-card-definition.js', 'Preflight Validate Candidate Card'],
  ['provide-response-to-user.js', 'Provide Response To User'],
  ['shared_helpers.js', 'Shared Helper Utilities'],
]);

function loadKnownConstants() {
  let rawText;
  try {
    rawText = fs.readFileSync(knownConstantsPath, 'utf8');
  } catch {
    throw new Error(`Workspace configuration is missing (expected ${knownConstantsPath}). Please recreate the workspace.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Workspace configuration is corrupted (invalid JSON at ${knownConstantsPath}).`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Workspace configuration is corrupted (expected a JSON object at ${knownConstantsPath}).`);
  }

  return parsed;
}

function resolveLogOutputPath() {
  const watchPartyFile = typeof process.env.CHAT_CARD_WATCH_PARTY_FILE === 'string'
    ? process.env.CHAT_CARD_WATCH_PARTY_FILE.trim()
    : '';

  return watchPartyFile || logFilePath;
}

function titleCase(text) {
  return text
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();
}

function resolveToolSemanticName(cmd) {
  const cmdText = typeof cmd === 'string'
    ? cmd.trim()
    : String(cmd ?? '').trim();

  if (!cmdText) {
    return 'Unknown Tool';
  }

  const firstToken = cmdText.split(/\s+/)[0] || '';
  const baseToken = path.basename(firstToken);
  const [baseScriptName] = baseToken.split(':');
  const normalizedBaseName = baseScriptName.trim().toLowerCase();

  if (TOOL_SEMANTIC_NAME_MAP.has(normalizedBaseName)) {
    return TOOL_SEMANTIC_NAME_MAP.get(normalizedBaseName);
  }

  const withJsSuffix = normalizedBaseName.endsWith('.js')
    ? normalizedBaseName
    : `${normalizedBaseName}.js`;

  if (TOOL_SEMANTIC_NAME_MAP.has(withJsSuffix)) {
    return TOOL_SEMANTIC_NAME_MAP.get(withJsSuffix);
  }

  return titleCase(normalizedBaseName.replace(/\.js$/i, '')) || 'Unknown Tool';
}

function appendLogLine(text) {
  const outputPath = resolveLogOutputPath();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${text}\n`, 'utf8');
}

export function log_it(cmd, message = '') {
  void message;
  try {
    const semanticName = resolveToolSemanticName(cmd);
    appendLogLine(`Invoking '${semanticName}'`);
  } catch {
    // Invocation logging must never block the wrapper.
  }
}

export function log_done(cmd, message = '') {
  void message;
  try {
    const semanticName = resolveToolSemanticName(cmd);
    appendLogLine(`['${semanticName}' completed]`);
  } catch {
    // Completion logging must never block the wrapper.
  }
}

export function log_failed(cmd, message = '') {
  void message;
  try {
    const semanticName = resolveToolSemanticName(cmd);
    appendLogLine(`['${semanticName}' failed]`);
  } catch {
    // Failure logging must never block the wrapper.
  }
}

export function readKnownBaseRef() {
  const baseRef = loadKnownConstants().base_ref;
  if (typeof baseRef !== 'string' || !baseRef.trim()) {
    throw new Error('Workspace configuration is incomplete (missing board reference).');
  }

  return baseRef.trim();
}

export function readKnownFinalResponseRootDir() {
  const finalResponseRootDir = loadKnownConstants().final_response_root_dir;
  if (typeof finalResponseRootDir !== 'string' || !finalResponseRootDir.trim()) {
    throw new Error('Workspace configuration is incomplete (missing response directory).');
  }

  return finalResponseRootDir.trim();
}

function readKnownYamlFlowCliBundledDir() {
  const bundledDir = loadKnownConstants().yaml_flow_cli_bundled_dir;
  if (typeof bundledDir !== 'string' || !bundledDir.trim()) {
    throw new Error('Workspace configuration is incomplete (missing CLI path).');
  }

  return bundledDir.trim();
}

export function resolveKnownYamlFlowCliPath(fileName) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('resolveKnownYamlFlowCliPath requires a non-empty file name');
  }

  return path.join(readKnownYamlFlowCliBundledDir(), fileName.trim());
}
