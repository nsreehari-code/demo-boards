import React from 'react';
import { useBoardState } from '../hooks/useBoardState.js';
import { BoardCanvas } from './BoardCanvas.jsx';
import { CardShell } from './CardShell.jsx';

const CENTRE_PANE_LAYOUTS = {
  'flowing-cards': {
    containerClassName: 'board-centre-pane container-fluid px-3 py-2',
    listClassName: 'board-centre-grid row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3',
    itemClassName: 'board-centre-cell col',
  },
  'infinite-canvas': {
    containerClassName: 'board-centre-pane board-centre-pane--canvas',
    listClassName: 'board-centre-canvas',
    itemClassName: '',
  },
};

function resolveLayoutStrategy(layoutStrategy) {
  if (!layoutStrategy) return CENTRE_PANE_LAYOUTS['flowing-cards'];
  if (typeof layoutStrategy === 'string') {
    return CENTRE_PANE_LAYOUTS[layoutStrategy] ?? CENTRE_PANE_LAYOUTS['flowing-cards'];
  }

  return {
    ...CENTRE_PANE_LAYOUTS['flowing-cards'],
    ...layoutStrategy,
  };
}

export function CentrePane({ boardId, excludeFilters = [], layoutStrategy = 'flowing-cards' }) {
  const board = useBoardState(boardId);

  if (!board) return null;

  const layout = resolveLayoutStrategy(layoutStrategy);
  const visibleCardIds = [...board.excludedCards(excludeFilters)];

  if (layoutStrategy === 'infinite-canvas') {
    return (
      <div className={layout.containerClassName}>
        <BoardCanvas board={board} boardId={boardId} cardIds={visibleCardIds} />
      </div>
    );
  }

  return (
    <div className={layout.containerClassName}>
      <div className={layout.listClassName}>
        {visibleCardIds.map((cardId) => (
          <div key={cardId} className={layout.itemClassName}>
            <CardShell boardId={boardId} cardId={cardId} />
          </div>
        ))}
      </div>
    </div>
  );
}