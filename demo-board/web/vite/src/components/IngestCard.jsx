import React from 'react';
import { ChatPane } from './ChatPane.jsx';

export function IngestCard({ card, chatData, boardId }) {
  if (!card) return null;

  return (
    <div className="flex-grow-1 d-flex flex-column min-h-0 overflow-hidden">
      <ChatPane
        card={card}
        chatData={chatData}
        boardId={boardId}
        onClose={null}
      />
    </div>
  );
}
