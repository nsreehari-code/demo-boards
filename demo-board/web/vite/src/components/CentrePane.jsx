import React from 'react';
import { useBoardState } from '../hooks/useBoardState.js';
import { CardShell } from './CardShell.jsx';

const CENTRE_PANE_LAYOUTS = {
  'flowing-cards': {
    containerClassName: 'container-fluid p-3',
    listClassName: 'row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3',
    itemClassName: 'col',
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