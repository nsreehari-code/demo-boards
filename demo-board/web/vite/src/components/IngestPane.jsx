import React, { useState } from 'react';
import { IngestNav }  from './IngestNav.jsx';
import { IngestCard } from './IngestCard.jsx';

export function IngestPane({ boardState, boardId, visible, onToggle }) {
  const [idx, setIdx] = useState(0);

  const ingestCards = (boardState?.cardIds ?? [])
    .map(id => boardState.cardsById[id])
    .filter(c => c?.meta?.ingest === true);

  const safeIdx = Math.min(idx, Math.max(0, ingestCards.length - 1));
  const card    = ingestCards[safeIdx] ?? null;
  const chatData = card ? (boardState?.chatsById[card.id] ?? null) : null;

  return (
    <aside
      aria-label="Ingest board"
      style={{
        position: 'fixed',
        top: '72px',
        left: '12px',
        height: 'calc(100dvh - 84px)',
        paddingTop: '8px',
        zIndex: 1040,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'flex-start',
      }}
    >
      {/* toggle button */}
      <button
        className="btn btn-sm btn-secondary me-1 mt-1"
        style={{ pointerEvents: 'auto', zIndex: 1050 }}
        onClick={onToggle}
        aria-pressed={visible}
        title={visible ? 'Hide ingest panel' : 'Show ingest panel'}
      >
        {visible ? '‹' : '›'}
      </button>

      {/* rail */}
      {visible && (
        <div
          className="card border-0 shadow-lg rounded-3 d-flex flex-column"
          style={{
            pointerEvents: 'auto',
            width: 'min(28rem, calc(100vw - 4.5rem))',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <IngestNav
            cards={ingestCards}
            idx={safeIdx}
            onPrev={() => setIdx(i => Math.max(0, i - 1))}
            onNext={() => setIdx(i => Math.min(ingestCards.length - 1, i + 1))}
          />
          <IngestCard
            card={card}
            chatData={chatData}
            boardId={boardId}
          />
        </div>
      )}
    </aside>
  );
}
