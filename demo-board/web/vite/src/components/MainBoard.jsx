import React, { useState } from 'react';
import { CardShell } from './CardShell.jsx';
import { ChatPane }  from './ChatPane.jsx';
import { CARD_RENDERERS } from '../cards/index.js';

export function MainBoard({ boardState, boardId }) {
  const [chatCardId, setChatCardId] = useState(null);

  const mainCards = (boardState.cardIds ?? [])
    .map(id => boardState.cardsById[id])
    .filter(c => c && !c.meta?.ingest);

  return (
    <div className="container-fluid p-3">
      <div className="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3">
        {mainCards.map(card => {
          const Body = CARD_RENDERERS[card.id] ?? DefaultBody;
          const chatOpen = chatCardId === card.id;
          return (
            <div key={card.id} className="col">
              <CardShell
                card={card}
                boardId={boardId}
                onChatToggle={() => setChatCardId(chatOpen ? null : card.id)}
              >
                <Body card={card} />
                {chatOpen && (
                  <ChatPane
                    card={card}
                    chatData={boardState.chatsById[card.id]}
                    boardId={boardId}
                    onClose={() => setChatCardId(null)}
                  />
                )}
              </CardShell>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DefaultBody({ card }) {
  return (
    <pre className="small text-muted mb-0" style={{ whiteSpace: 'pre-wrap' }}>
      {JSON.stringify(card.computed_values, null, 2)}
    </pre>
  );
}
