import React, { useMemo, useState } from 'react';
import { useBoardState } from '../hooks/useBoardState.js';
import { resyncSeedCards } from '../lib/client.js';
import { IngestCard } from './IngestCard.jsx';

const INGEST_PANE_LAYOUTS = {
  vertical: {
    asideStyle: {
      position: 'fixed',
      top: 'calc(var(--nav-height) + 0.5rem)',
      left: '12px',
      height: 'calc(100dvh - var(--nav-height) - 1rem)',
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
  const phaseTone = phase === 'done' ? 'board-tone--done' : 'board-tone--active';

  return (
    <div className="board-ingest-nav">
      <div className="min-w-0 flex-grow-1">
        <div className="board-ingest-nav__title text-truncate">{title}</div>
      </div>
      <span className={`board-phase-pill ${phaseTone}`}>
        {phase}
      </span>
      <button
        type="button"
        className="board-icon-button"
        onClick={onPrev}
        disabled={idx === 0}
        aria-label="Previous card"
      >
        <i className="bi bi-chevron-up" />
      </button>
      <span className="board-ingest-nav__counter">{total > 0 ? `${idx + 1} / ${total}` : '—'}</span>
      <button
        type="button"
        className="board-icon-button"
        onClick={onNext}
        disabled={idx >= total - 1}
        aria-label="Next card"
      >
        <i className="bi bi-chevron-down" />
      </button>
    </div>
  );
}

export function IngestPane({ boardId, includeFilters = [], layoutStrategy = 'vertical' }) {
  const board = useBoardState(boardId);
  const [visible, setVisible] = useState(false);
  const [idx, setIdx] = useState(0);
  const [resyncing, setResyncing] = useState(false);
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

  const handleResyncSeedCards = async () => {
    if (resyncing) {
      return;
    }

    setResyncing(true);
    try {
      const response = await resyncSeedCards(boardId);
      if (!response.ok) {
        throw new Error(`Resync seed cards failed with status ${response.status}`);
      }
    } catch (error) {
      console.error('[IngestPane] Failed to resync seed cards', error);
    } finally {
      setResyncing(false);
    }
  };

  if (!board || ingestCardIds.length === 0) return null;

  return (
    <aside aria-label="Ingest pane" className={`board-ingest-layer${visible ? ' is-open' : ''}`} style={layout.asideStyle}>
      <button
        type="button"
        className={`board-ingest-toggle d-inline-flex align-items-center justify-content-center${visible ? ' is-open' : ''}`}
        onClick={() => setVisible((current) => !current)}
        aria-pressed={visible}
        title={visible ? 'Hide ingest pane' : 'Show ingest pane'}
      >
        <i className={`bi ${visible ? 'bi-chevron-left' : 'bi-chevron-right'}`} />
      </button>

      {visible ? (
        <>
          <div className="board-ingest-backdrop" aria-hidden="true" />
          <div className="board-ingest-pane d-flex flex-column" style={layout.railStyle}>
            <div className="board-ingest-pane__header">
              <div>
                <div className="board-ingest-pane__eyebrow">Board Manager</div>
              </div>
              <button
                type="button"
                className="board-ingest-pane__count board-ingest-pane__count-button"
                onClick={handleResyncSeedCards}
                disabled={resyncing}
                title="Resync seed cards"
              >
                {resyncing ? 'Resyncing…' : `${ingestCardIds.length} cards`}
              </button>
            </div>
            <IngestPaneNav
              cards={cards}
              idx={safeIdx}
              onPrev={() => setIdx((current) => Math.max(0, current - 1))}
              onNext={() => setIdx((current) => Math.min(ingestCardIds.length - 1, current + 1))}
            />
            <div className="board-ingest-pane__body flex-grow-1 min-h-0">
              {cardId ? <IngestCard boardId={boardId} cardId={cardId} /> : null}
            </div>
          </div>
        </>
      ) : null}
    </aside>
  );
}
