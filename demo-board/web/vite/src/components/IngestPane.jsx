import React, { useMemo, useState } from 'react';
import { useBoardState } from '../hooks/useBoardState.js';
import { IngestCard } from './IngestCard.jsx';

const INGEST_PANE_LAYOUTS = {
  vertical: {
    asideStyle: {
      position: 'fixed',
      top: '68px',
      left: '12px',
      height: 'calc(100dvh - 80px)',
      zIndex: 1040,
      display: 'flex',
      alignItems: 'flex-start',
      pointerEvents: 'none',
    },
    railStyle: {
      pointerEvents: 'auto',
      width: 'min(30rem, calc(100vw - 4.5rem))',
      height: '100%',
      overflow: 'hidden',
    },
  },
};

function resolveLayoutStrategy(layoutStrategy) {
  if (!layoutStrategy) return INGEST_PANE_LAYOUTS.vertical;
  if (typeof layoutStrategy === 'string') {
    return INGEST_PANE_LAYOUTS[layoutStrategy] ?? INGEST_PANE_LAYOUTS.vertical;
  }

  return {
    ...INGEST_PANE_LAYOUTS.vertical,
    ...layoutStrategy,
  };
}

function IngestPaneNav({ cards, idx, onPrev, onNext }) {
  const card = cards[idx];
  const title = card?.meta?.title ?? card?.id ?? '—';
  const phase = card?.card_data?.phase ?? 'active';
  const total = cards.length;

  return (
    <div
      className="d-flex align-items-center gap-2 px-3 py-2 border-bottom"
      style={{ borderColor: 'rgba(0,0,0,.08)' }}
    >
      <span className="fw-semibold text-truncate flex-grow-1 small">{title}</span>
      <span className={`badge rounded-pill small ${phase === 'done' ? 'bg-success-subtle text-success-emphasis' : 'bg-primary-subtle text-primary-emphasis'}`}>
        {phase}
      </span>
      <button
        className="btn btn-sm btn-link text-secondary-emphasis py-0 px-1 opacity-55"
        style={{ textDecoration: 'none' }}
        onClick={onPrev}
        disabled={idx === 0}
        aria-label="Previous card"
      >
        ▲
      </button>
      <span className="small text-muted">{total > 0 ? `${idx + 1} / ${total}` : '—'}</span>
      <button
        className="btn btn-sm btn-link text-secondary-emphasis py-0 px-1 opacity-55"
        style={{ textDecoration: 'none' }}
        onClick={onNext}
        disabled={idx >= total - 1}
        aria-label="Next card"
      >
        ▼
      </button>
    </div>
  );
}

export function IngestPane({ boardId, includeFilters = [], layoutStrategy = 'vertical' }) {
  const board = useBoardState(boardId);
  const [visible, setVisible] = useState(true);
  const [idx, setIdx] = useState(0);
  const layout = resolveLayoutStrategy(layoutStrategy);
  const ingestCardIds = useMemo(() => {
    if (!board) return [];
    return [...board.filterCards(includeFilters)];
  }, [board, includeFilters]);

  const safeIdx = Math.min(idx, Math.max(0, ingestCardIds.length - 1));
  const cardId = ingestCardIds[safeIdx] ?? null;
  const cards = useMemo(() => {
    if (!board) return [];
    return ingestCardIds.map((currentCardId) => {
      const cardContent = board.cardContents[currentCardId] ?? null;
      return {
        id: currentCardId,
        meta: cardContent?.meta ?? {},
        card_data: cardContent?.card_data ?? {},
      };
    });
  }, [board, ingestCardIds]);

  if (!board) return null;

  return (
    <aside aria-label="Ingest pane" style={layout.asideStyle}>
      <button
        type="button"
        className="btn btn-sm btn-secondary me-1 mt-1"
        style={{ pointerEvents: 'auto', zIndex: 1050 }}
        onClick={() => setVisible((current) => !current)}
        aria-pressed={visible}
        title={visible ? 'Hide ingest pane' : 'Show ingest pane'}
      >
        {visible ? '‹' : '›'}
      </button>

      {visible ? (
        <div className="card border-0 shadow-lg rounded-3 d-flex flex-column" style={layout.railStyle}>
          <IngestPaneNav
            cards={cards}
            idx={safeIdx}
            onPrev={() => setIdx((current) => Math.max(0, current - 1))}
            onNext={() => setIdx((current) => Math.min(ingestCardIds.length - 1, current + 1))}
          />
          <div className="flex-grow-1 min-h-0 p-3">
            {cardId ? <IngestCard boardId={boardId} cardId={cardId} /> : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
