import { useCallback, useSyncExternalStore } from 'react';
import { SERVER, initBoard } from '../lib/client.js';

const boardStores = new Map();

function emitBoardStore(store) {
  store.listeners.forEach((listener) => listener());
}

function stopBoardStore(boardId, store) {
  store.es?.close();
  store.es = null;
  store.started = false;
  boardStores.delete(boardId);
}

function startBoardStore(boardId, store) {
  if (store.started) return;
  store.started = true;

  initBoard(boardId)
    .then(() => {
      if (!store.started) return;

      const clientId = crypto.randomUUID();
      store.clientId = clientId;
      const url = `${SERVER}/api/boards/${boardId}/sse?clientId=${encodeURIComponent(clientId)}`;
      const es = new EventSource(url);
      store.es = es;

      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          store.snapshot = applyFrame(store.snapshot ?? {}, payload);
          emitBoardStore(store);
        } catch {
          // ignore malformed frames
        }
      };

      es.onerror = () => {
        // EventSource reconnects automatically.
        console.debug('[useBoardSSE] SSE error — will retry');
      };
    })
    .catch((err) => console.error('[useBoardSSE] init-board failed', err));
}

function getOrCreateBoardStore(boardId) {
  if (!boardStores.has(boardId)) {
    boardStores.set(boardId, {
      snapshot: null,
      clientId: null,
      listeners: new Set(),
      es: null,
      started: false,
    });
  }

  return boardStores.get(boardId);
}

function subscribeBoardStore(boardId, listener) {
  if (!boardId) return () => {};

  const store = getOrCreateBoardStore(boardId);
  store.listeners.add(listener);
  startBoardStore(boardId, store);

  return () => {
    store.listeners.delete(listener);
  };
}

function normalizeFilterFns(filterFns) {
  if (!filterFns) return [];
  return (Array.isArray(filterFns) ? filterFns : [filterFns]).filter((filterFn) => typeof filterFn === 'function');
}

function buildBoardCardState(cardId, cardContents, cardRuntimes, chatStates, dataObjects) {
  const cardContent = cardContents[cardId] ?? null;
  const requiresDataObjects = {};
  for (const token of (cardContent?.requires ?? [])) {
    if (token in dataObjects) {
      requiresDataObjects[token] = dataObjects[token];
    }
  }

  return {
    cardId,
    cardContent,
    cardData: cardContent?.card_data ?? {},
    cardRuntime: cardRuntimes[cardId] ?? null,
    chatState: chatStates[cardId] ?? null,
    requiresDataObjects,
  };
}

// ---------------------------------------------------------------------------
// State builder — converts the raw SSE initial payload into React state
// ---------------------------------------------------------------------------
function buildState(payload) {
  // statusSnapshot.cards is an ARRAY: [{name, status, runtime, ...}]
  const statusByName = {};
  for (const entry of (payload.statusSnapshot?.cards ?? [])) {
    statusByName[entry.name] = entry;
  }

  const cardsById = {};
  for (const def of (payload.cardDefinitions ?? [])) {
    const runtime    = payload.cardRuntimeById?.[def.id] ?? {};
    const statusInfo = statusByName[def.id] ?? {};
    cardsById[def.id] = {
      ...def,                               // id, meta, source_defs, view, compute, requires, ...
      card_data:       runtime.card_data ?? {},
      computed_values: runtime.computed_values ?? {},
      status:          statusInfo.status ?? 'fresh',
      runtime:         statusInfo.runtime ?? {},
    };
  }

  // cardChatsByCardId values are objects: { messages: [...], processing, receiving }
  const chatsById = {};
  for (const [cardId, chatSnapshot] of Object.entries(payload.cardChatsByCardId ?? {})) {
    chatsById[cardId] = {
      messages:   chatSnapshot?.messages   ?? [],
      processing: !!chatSnapshot?.processing,
      receiving:  !!chatSnapshot?.receiving,
    };
  }

  return {
    boardId:       payload.boardId,
    cardIds:       (payload.cardDefinitions ?? []).map(c => c.id),
    cardsById,
    chatsById,
    statusSummary: payload.statusSnapshot?.summary ?? null,
    dataObjects:   payload.dataObjectsByToken ?? {},
  };
}

// ---------------------------------------------------------------------------
// Incremental updater — applies a notification-batch frame onto existing state
// ---------------------------------------------------------------------------
function applyFrame(prev, payload) {
  if (Array.isArray(payload.cardDefinitions)) {
    return buildState(payload);
  }

  if (payload.kind === 'notification-batch') {
    const next = {
      ...prev,
      cardsById:   { ...prev.cardsById },
      chatsById:   { ...prev.chatsById },
      dataObjects: { ...prev.dataObjects },
    };
    for (const n of (payload.notifications ?? [])) {
      if (n.kind === 'status') {
        if (n.status?.summary) next.statusSummary = n.status.summary;
        for (const entry of (n.status?.cards ?? [])) {
          if (next.cardsById[entry.name]) {
            next.cardsById[entry.name] = {
              ...next.cardsById[entry.name],
              status:  entry.status,
              runtime: entry.runtime ?? next.cardsById[entry.name].runtime,
            };
          }
        }
      } else if (n.kind === 'data_object' && n.key) {
        next.dataObjects[n.key] = n.payload;
      } else if (n.kind === 'computed_values' && n.cardId) {
        if (next.cardsById[n.cardId]) {
          next.cardsById[n.cardId] = {
            ...next.cardsById[n.cardId],
            computed_values: n.values ?? {},
          };
        }
      } else if (n.kind === 'card_chats' && n.cardId) {
        next.chatsById[n.cardId] = {
          messages:   n.messages   ?? [],
          processing: !!n.processing,
          receiving:  !!n.receiving,
        };
      } else if (n.kind === 'card_refreshed' && n.cardId && n.card) {
        if (next.cardsById[n.cardId]) {
          next.cardsById[n.cardId] = {
            ...next.cardsById[n.cardId],
            ...n.card,
          };
        }
      }
    }
    return next;
  }

  return prev;
}

// ---------------------------------------------------------------------------
// useBoardSSE — shared per-board subscription across all consumers
// ---------------------------------------------------------------------------
export function useBoardSSE(boardId) {
  const subscribe = useCallback((listener) => subscribeBoardStore(boardId, listener), [boardId]);
  const getSnapshot = useCallback(() => (boardId ? getOrCreateBoardStore(boardId).snapshot : null), [boardId]);

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => null,
  );
}

// ---------------------------------------------------------------------------
// useBoardState — structured view on top of the raw SSE state
// ---------------------------------------------------------------------------
export function useBoardState(boardId) {
  const raw = useBoardSSE(boardId);

  if (!raw) return null;

  // cardContents: full card object keyed by cardId
  const cardContents = {};
  for (const id of (raw.cardIds ?? [])) {
    const c = raw.cardsById[id];
    if (c) {
      const { computed_values, runtime, status, ...cardDefinition } = c;
      cardContents[id] = cardDefinition;
    }
  }

  // cardRuntimes: status + runtime + computed_values keyed by cardId
  const cardRuntimes = {};
  for (const id of (raw.cardIds ?? [])) {
    const c = raw.cardsById[id];
    if (c) cardRuntimes[id] = {
      status:          c.status,
      runtime:         c.runtime,
      computed_values: c.computed_values ?? {},
    };
  }

  // boardStatus: summary-level status (no per-card runtimes)
  const boardStatus = raw.statusSummary ?? null;

  // dataObjects: board-level map keyed by token, from dataObjectsByToken + data_object notifications
  const dataObjects = raw.dataObjects ?? {};

  // chatStates: chat state keyed by cardId
  const chatStates = raw.chatsById ?? {};

  const filterCards = (filterFns = []) => {
    const filters = normalizeFilterFns(filterFns);
    const matchedCardIds = new Set();

    for (const cardId of (raw.cardIds ?? [])) {
      const cardState = buildBoardCardState(cardId, cardContents, cardRuntimes, chatStates, dataObjects);
      if (filters.some((filterFn) => filterFn(cardState))) {
        matchedCardIds.add(cardId);
      }
    }

    return matchedCardIds;
  };

  const excludedCards = (filterFns = []) => {
    const matchedCardIds = filterCards(filterFns);
    const remainingCardIds = new Set();

    for (const cardId of (raw.cardIds ?? [])) {
      if (!matchedCardIds.has(cardId)) {
        remainingCardIds.add(cardId);
      }
    }

    return remainingCardIds;
  };

  const boardActions = {
    initBoard: () => initBoard(boardId),
  };

  return {
    boardId:     raw.boardId,
    sseClientId: getOrCreateBoardStore(boardId).clientId,
    boardInfo:   null,
    cardContents,
    cardRuntimes,
    boardStatus,
    dataObjects,
    chatStates,
    filterCards,
    excludedCards,
    boardActions,
  };
}
