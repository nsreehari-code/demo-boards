#!/usr/bin/env node

const DEFAULT_ORIGIN = 'http://127.0.0.1:7799';
const DEFAULT_NAMESPACE = 'smoke-layout-namespace';

function readCliOption(name, fallback = '') {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return String(args[index + 1] || '').trim() || fallback;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function postManageBoards(origin, subcommand, args = {}) {
  const response = await fetch(`${origin.replace(/\/+$/, '')}/manage-boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subcommand, args }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== 'success') {
    const message = typeof payload?.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : `${subcommand} failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload.data ?? null;
}

async function main() {
  const origin = readCliOption('--origin', DEFAULT_ORIGIN);
  const namespace = readCliOption('--ns', DEFAULT_NAMESPACE);
  const requestedBoardId = readCliOption('--board-id', '');

  const boardsData = await postManageBoards(origin, 'list-boards');
  const boards = Array.isArray(boardsData?.boards) ? boardsData.boards : [];
  assert(boards.length > 0, 'No boards available to test manage-boards layout namespaces');

  const boardId = requestedBoardId || String(boards[0]?.id || '').trim();
  assert(boardId, 'A valid board id is required');

  const alternateNamespace = `${namespace}-other`;
  const replacePayload = {
    kind: 'smoke-canvas',
    marker: {
      suite: 'layout-namespace-smoke',
      phase: 'replace',
    },
  };
  const mergePayload = {
    viewport: {
      x: 12,
      y: 34,
      zoom: 1.25,
    },
  };

  await postManageBoards(origin, 'save-layout', {
    boardId,
    ns: namespace,
    keyvals: replacePayload,
  });

  const savedLayout = (await postManageBoards(origin, 'get-layout', {
    boardId,
    ns: namespace,
  }))?.layout ?? null;
  assert(
    stableStringify(savedLayout) === stableStringify(replacePayload),
    `save-layout returned unexpected payload for namespace '${namespace}'`,
  );

  await postManageBoards(origin, 'shallow-merge', {
    boardId,
    ns: namespace,
    key: 'canvas',
    val: mergePayload,
  });

  const mergedLayout = (await postManageBoards(origin, 'get-layout', {
    boardId,
    ns: namespace,
  }))?.layout ?? null;
  const expectedMergedLayout = {
    ...replacePayload,
    canvas: mergePayload,
  };
  assert(
    stableStringify(mergedLayout) === stableStringify(expectedMergedLayout),
    `shallow-merge returned unexpected payload for namespace '${namespace}'`,
  );

  const alternateLayout = (await postManageBoards(origin, 'get-layout', {
    boardId,
    ns: alternateNamespace,
  }))?.layout ?? null;
  assert(alternateLayout === null, `Expected namespace '${alternateNamespace}' to remain isolated`);

  console.log(JSON.stringify({
    ok: true,
    boardId,
    namespace,
    alternateNamespace,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
