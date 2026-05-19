import React from 'react';
import { useCardState } from '../hooks/useCardState.js';
import { ChatPane } from './ChatPane.jsx';

export function IngestCard({ boardId, cardId }) {
  const cardState = useCardState(boardId, cardId);

  if (!cardState?.cardContent) return null;

  const title = cardState.cardContent.meta?.title ?? cardId;

  return (
    <div className="board-ingest-card h-100 d-flex flex-column">
      <div className="board-ingest-card__header d-flex align-items-center justify-content-between gap-2">
        <div className="fw-semibold text-truncate flex-grow-1 min-w-0">{title}</div>
      </div>
      <div className="board-ingest-card__body min-h-0 d-flex flex-column overflow-hidden">
        <ChatPane boardId={boardId} cardId={cardId} compact />
      </div>
    </div>
  );
}
