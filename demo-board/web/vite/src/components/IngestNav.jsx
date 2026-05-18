import React from 'react';

/**
 * Carousel navigation bar for the ingest pane.
 */
export function IngestNav({ cards, idx, onPrev, onNext }) {
  const card   = cards[idx];
  const title  = card?.meta?.title ?? card?.id ?? '—';
  const phase  = card?.card_data?.phase ?? 'active';
  const total  = cards.length;

  return (
    <div className="d-flex align-items-center gap-2 px-3 py-2 border-bottom"
         style={{ borderColor: 'rgba(0,0,0,.08)' }}>
      {/* title + phase badge */}
      <span className="fw-semibold text-truncate flex-grow-1 small">{title}</span>
      <span className={`badge rounded-pill small ${phase === 'done' ? 'bg-success-subtle text-success-emphasis' : 'bg-primary-subtle text-primary-emphasis'}`}>
        {phase}
      </span>

      {/* prev / counter / next */}
      <button className="btn btn-sm btn-link text-secondary-emphasis py-0 px-1 opacity-55"
              style={{ textDecoration: 'none' }}
              onClick={onPrev} disabled={idx === 0} aria-label="Previous card">▲</button>
      <span className="small text-muted">{total > 0 ? `${idx + 1} / ${total}` : '—'}</span>
      <button className="btn btn-sm btn-link text-secondary-emphasis py-0 px-1 opacity-55"
              style={{ textDecoration: 'none' }}
              onClick={onNext} disabled={idx >= total - 1} aria-label="Next card">▼</button>
    </div>
  );
}
