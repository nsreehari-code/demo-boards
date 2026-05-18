import React from 'react';
import { useCardState } from '../hooks/useCardState.js';
import { ChatPane } from './ChatPane.jsx';

export function IngestCard({ boardId, cardId }) {
  const cardState = useCardState(boardId, cardId);

  if (!cardState?.cardContent) return null;

  const title = cardState.cardContent.meta?.title ?? cardId;

  return (
    <div className="card h-100 shadow-sm border-0 rounded-3">
      <div className="card-header d-flex align-items-center justify-content-between gap-2 py-2 px-3 bg-transparent border-bottom">
        <div className="fw-semibold text-truncate flex-grow-1 min-w-0">{title}</div>
      </div>
      <div className="card-body p-0 min-h-0 d-flex flex-column overflow-hidden">
        <ChatPane boardId={boardId} cardId={cardId} />
      </div>
    </div>
  );
}
