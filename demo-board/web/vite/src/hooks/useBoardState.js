import { useState, useEffect, useRef } from 'react';
import { SERVER, initBoard } from '../lib/client.js';

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
      id:              def.id,
      meta:            def.meta ?? {},
      card_data:       runtime.card_data ?? {},
      computed_values: runtime.computed_values ?? {},
      status:          statusInfo.status ?? 'fresh',
      runtime:         statusInfo.runtime ?? {},
    };
  }

  // cardChatsByCardId values are objects: { messages: [...], processing, receiving }
  const chatsById = {};
  for (const [cardId, chatData] of Object.entries(payload.cardChatsByCardId ?? {})) {
    chatsById[cardId] = {
      messages:   chatData?.messages   ?? [],
      processing: !!chatData?.processing,
      receiving:  !!chatData?.receiving,
    };
  }

  return {
    boardId:       payload.boardId,
    cardIds:       (payload.cardDefinitions ?? []).map(c => c.id),
    cardsById,
    chatsById,
    statusSummary: payload.statusSnapshot?.summary ?? null,
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
      cardsById: { ...prev.cardsById },
      chatsById: { ...prev.chatsById },
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
      }
    }
    return next;
  }

  return prev;
}

// ---------------------------------------------------------------------------
// useBoardSSE — the only hook the app needs
// ---------------------------------------------------------------------------
export function useBoardSSE(boardId) {
  const [boardState, setBoardState] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    if (!boardId) return;
    let active = true;

    initBoard(boardId)
      .then(() => {
        if (!active) return;
        const clientId = crypto.randomUUID();
        const url = `${SERVER}/api/boards/${boardId}/sse?clientId=${encodeURIComponent(clientId)}`;
        const es = new EventSource(url);
        esRef.current = es;

        es.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            setBoardState(prev => applyFrame(prev ?? {}, payload));
          } catch { /* ignore malformed frames */ }
        };

        es.onerror = () => {
          // EventSource reconnects automatically
          console.debug('[useBoardSSE] SSE error — will retry');
        };
      })
      .catch(err => console.error('[useBoardSSE] init-board failed', err));

    return () => {
      active = false;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [boardId]);

  return boardState;
}
