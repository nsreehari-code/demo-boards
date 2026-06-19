// Shared, side-effect-free helpers for the Journey Strategist verification harness.
//
// These functions faithfully replicate (read-only, in-memory) the parts of
// setup-single-ai-workspace.js that materialize a copilot workspace stem, plus
// helpers for locating the journey-strategist card and validating a strategist
// "move" against the board contract. Used by all three harness layers:
//   A. strategist-doctor.mjs   (static lint)
//   B. validate-move.mjs       (move contract + replay)
//   C. the live scenario runner / playwright eval
//
// No network, no spawning, no writes — pure reads of repo source files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// lib -> strategist -> test -> demo-board. This matches {{BOARD_ROOT}} in the
// templates-config ai-workdirs-setup entries (the demo-board directory).
export const BOARD_ROOT = path.resolve(__dirname, '..', '..', '..');

export const RUNTIME_DIR = path.join(BOARD_ROOT, 'server', 'hosted-board-runtime');
export const TEMPLATES_CONFIG_PATH = path.join(RUNTIME_DIR, 'templates-config.json');
export const HOST_CONFIG_PATH = path.join(RUNTIME_DIR, 'hosted-board-runtime.localfs.config.json');

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadTemplatesConfig() {
  return loadJson(TEMPLATES_CONFIG_PATH);
}

export function loadHostConfig() {
  return loadJson(HOST_CONFIG_PATH);
}

// Boards that run the journeys UI (and therefore the journey-strategist card).
export function listJourneyBoards(hostConfig = loadHostConfig()) {
  const boards = hostConfig['bootstrap-sample-boards'] || {};
  return Object.entries(boards)
    .filter(([, cfg]) => cfg && cfg.uiTemplate === 'journeys')
    .map(([id, cfg]) => ({ id, cfg }));
}

export function substituteTokens(value, boardId) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\{\{\s*boardId\s*\}\}/g, boardId)
    .replace(/\{\{\s*BOARD_ROOT\s*\}\}/g, BOARD_ROOT)
    .replace(/\{\{\s*boardRoot\s*\}\}/g, BOARD_ROOT);
}

export function resolveDir(rel, boardId) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const resolved = substituteTokens(rel, boardId);
  return path.isAbsolute(resolved) ? path.normalize(resolved) : path.resolve(BOARD_ROOT, resolved);
}

export function listFilesShallow(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name))
    .sort();
}

export function listFilesRecursive(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Find the ai-workdirs-setup entry for a given copilot-root stem (e.g. "strategist").
export function getStemEntry(templatesConfig, aiWorkspaceTemplate, stem) {
  const tmpl = templatesConfig?.aiWorkspaceTemplates?.[aiWorkspaceTemplate];
  const entries = Array.isArray(tmpl?.['ai-workdirs-setup']) ? tmpl['ai-workdirs-setup'] : [];
  return entries.find((e) => e && e['copilot-root'] === stem) || null;
}

// Replicates setupCopilot's instruction concatenation (read-only, in-memory).
// Returns { text, sourceFiles: [{dir, file, abs}] } in the exact materialized order.
export function concatInstructions(entry, boardId) {
  const dirs = (entry.instructionsDirs || []).map((d) => resolveDir(d, boardId)).filter(Boolean);
  const parts = [];
  const sourceFiles = [];
  for (const dir of dirs) {
    for (const filePath of listFilesShallow(dir)) {
      parts.push(fs.readFileSync(filePath, 'utf8').trimEnd());
      sourceFiles.push({ dir, file: path.basename(filePath), abs: filePath });
    }
  }
  const text = parts.length > 0 ? `${parts.join('\n===============\n')}\n` : '';
  return { text, sourceFiles };
}

// The set of repo-relative-to-stem-root paths that materialization would place
// under .github/ for this stem. Used to validate that markdown file links inside
// the materialized copilot-instructions.md actually resolve on disk.
// Returns a Set of posix paths like ".github/skills/live-board-cards-soul.md".
export function materializedGithubPaths(entry, boardId) {
  const set = new Set(['.github/copilot-instructions.md']);
  const addShallow = (dirs, sub) => {
    for (const rel of dirs || []) {
      const dir = resolveDir(rel, boardId);
      for (const f of listFilesShallow(dir)) {
        set.add(`.github/${sub}/${path.basename(f)}`);
      }
    }
  };
  const addRecursive = (dirs, sub) => {
    for (const rel of dirs || []) {
      const dir = resolveDir(rel, boardId);
      for (const f of listFilesRecursive(dir)) {
        const relPath = path.relative(dir, f).split(path.sep).join('/');
        set.add(`.github/${sub}/${relPath}`);
      }
    }
  };
  addShallow(entry.agentsDirs, 'agents');
  addShallow(entry.agentsHooks, 'hooks');
  addShallow(entry.copyScripts, 'scripts');
  addRecursive(entry.agentsSkills, 'skills');
  return set;
}

// ---- journey-strategist card helpers -------------------------------------

export function getStrategistCard(templatesConfig, uiTemplate = 'journeys') {
  const adminCards = templatesConfig?.uiTemplates?.[uiTemplate]?.['admin-cards'];
  if (!Array.isArray(adminCards)) return null;
  return adminCards.find((c) => c && c.id === 'journey-strategist') || null;
}

// Extract a "a | b | c" enum that follows a JSON key inside the prompt template.
export function extractPromptEnum(promptTemplate, key) {
  const re = new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)\\\\?"`);
  const m = promptTemplate.match(re);
  if (!m) return null;
  return m[1].split('|').map((s) => s.trim()).filter(Boolean);
}

// All {{placeholder}} names referenced in a string.
export function extractPlaceholders(str) {
  const out = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(str)) !== null) out.add(m[1]);
  return [...out];
}

// Markdown file links of the form ](path) that look like local file paths.
// Skips http(s) links and pure anchors.
export function extractFileLinks(markdown) {
  const out = [];
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const target = m[1].trim().split('#')[0].trim();
    if (!target) continue;
    if (/^[a-z]+:\/\//i.test(target)) continue; // http://, https://, etc.
    if (!/\.[a-z0-9]+$/i.test(target)) continue; // must look like a file
    out.push(target.split('\\').join('/'));
  }
  return out;
}

// ---- Layer B: move contract validation -----------------------------------

export const STATUS_VALUES = ['advancing', 'waiting', 'aligned'];
export const MOVE_VALUES = ['deepen', 'broaden', 'clarify', 'decide', 'reconcile', 'hold'];

// Validate a strategist move object against the board contract and a board
// snapshot (the cards/tokens present when the strategist ran). Pure function.
// boardState: { cardIds: string[], policy: { maxNewCardsPerCycle, maxBreadth } }
// Returns { ok, errors: string[], warnings: string[] }.
export function validateMove(move, boardState = {}) {
  const errors = [];
  const warnings = [];
  const cardIds = new Set(boardState.cardIds || []);
  const policy = boardState.policy || {};

  if (!move || typeof move !== 'object' || Array.isArray(move)) {
    return { ok: false, errors: ['move is not a JSON object'], warnings };
  }

  if (!STATUS_VALUES.includes(move.status)) {
    errors.push(`status "${move.status}" not in {${STATUS_VALUES.join(', ')}}`);
  }
  if (!MOVE_VALUES.includes(move.move)) {
    errors.push(`move "${move.move}" not in {${MOVE_VALUES.join(', ')}}`);
  }
  if (typeof move.rationale !== 'string' || !move.rationale.trim()) {
    warnings.push('rationale is empty');
  }

  const created = Array.isArray(move.created_cards) ? move.created_cards : [];
  const updated = Array.isArray(move.updated_cards) ? move.updated_cards : [];

  const seenIds = new Set();
  for (const c of created) {
    if (!c || typeof c !== 'object') { errors.push('created_cards entry is not an object'); continue; }
    if (!c.card_id || typeof c.card_id !== 'string') {
      errors.push('created card missing card_id');
    } else {
      if (cardIds.has(c.card_id)) errors.push(`created card "${c.card_id}" collides with an existing board card`);
      if (seenIds.has(c.card_id)) errors.push(`created card "${c.card_id}" is duplicated in this move`);
      seenIds.add(c.card_id);
    }
    if (c.parent && !cardIds.has(c.parent) && !seenIds.has(c.parent)) {
      errors.push(`created card "${c.card_id}" references unknown parent "${c.parent}"`);
    }
  }

  for (const u of updated) {
    if (!u || typeof u !== 'object') { errors.push('updated_cards entry is not an object'); continue; }
    if (!u.card_id || !cardIds.has(u.card_id)) {
      errors.push(`updated card "${u?.card_id}" is not an existing board card`);
    }
  }

  // Pacing: created cards must respect the per-cycle budget.
  const maxNew = Number(policy.maxNewCardsPerCycle ?? Infinity);
  if (Number.isFinite(maxNew) && created.length > maxNew) {
    errors.push(`created ${created.length} cards > max_new_cards_per_cycle ${maxNew}`);
  }

  // Move/payload coherence.
  if (move.move === 'hold' && (created.length > 0 || updated.length > 0)) {
    warnings.push('move=hold but cards were created/updated');
  }
  if (move.status === 'aligned' && move.move !== 'hold') {
    warnings.push(`status=aligned but move=${move.move} (expected hold while aligned)`);
  }
  if ((move.move === 'deepen' || move.move === 'broaden') && created.length === 0) {
    warnings.push(`move=${move.move} but no cards were created`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Admin cards that drive the journey but are not themselves journey nodes.
export const ADMIN_CARD_IDS = new Set(['gandalf-intake', 'journey-strategist']);

// Normalize the strategist's emitted move out of its computed values. The move
// is published as the `move` computed object (current contract) or the `plan`
// object (pre-rename boards); the flat computed fields are the last fallback.
export function moveFromComputed(cv = {}) {
  const obj = (cv && typeof cv.move === 'object' && cv.move) ? cv.move
    : (cv && typeof cv.plan === 'object' && cv.plan) ? cv.plan
      : {};
  return {
    status: obj.status ?? cv.status_value,
    move: obj.move ?? (typeof cv.move === 'string' ? cv.move : undefined),
    created_cards: obj.created_cards ?? cv.created_table ?? [],
    updated_cards: obj.updated_cards ?? cv.updated_table ?? [],
    rationale: obj.rationale ?? cv.rationale,
    next_candidates: obj.next_candidates ?? cv.next_candidates_list ?? [],
  };
}

export function createdCardIds(move) {
  return (Array.isArray(move?.created_cards) ? move.created_cards : [])
    .map((c) => c?.card_id)
    .filter(Boolean);
}

// Behavioral heuristics. IMPORTANT: a single strategist wake runs an internal
// multi-step loop and only surfaces its FINAL move in computed values. So we do
// NOT correlate that final move with the whole-run board diff (the board may have
// legitimately changed via earlier internal moves before the final hold). We
// instead assert the final move's OWN claimed mutations are real and rooted, the
// move is self-consistent, and the board is left healthy.
export function behavioralChecks(move, cardsAfter, summary) {
  const out = [];
  const after = new Set(cardsAfter);
  const created = Array.isArray(move.created_cards) ? move.created_cards : [];
  const updated = Array.isArray(move.updated_cards) ? move.updated_cards : [];

  if (created.length > 0) {
    out.push(['every created card in the move exists on the board', created.every((c) => c.card_id && after.has(c.card_id))]);
    out.push(['every created card is rooted in a board card', created.every((c) => !c.parent || after.has(c.parent))]);
  }
  if (updated.length > 0) {
    out.push(['every updated card in the move exists on the board', updated.every((u) => u.card_id && after.has(u.card_id))]);
  }
  if (move.move === 'hold') {
    out.push(['hold move makes no creations/updates of its own', created.length === 0 && updated.length === 0]);
  }
  if (summary) {
    out.push(['board left healthy (no failed cards)', Number(summary.failed ?? 0) === 0]);
  }
  return { checks: out };
}
