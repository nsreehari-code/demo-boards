import React from 'react';
import { refreshCard } from '../lib/client.js';

function StatusBadge({ status }) {
  if (status === 'running' || status === 'in-progress') {
    return (
      <span className="badge bg-warning-subtle text-warning-emphasis rounded-pill small">
        <span className="spinner-border spinner-border-sm me-1" role="status" style={{ width: '0.6rem', height: '0.6rem' }} />
        running
      </span>
    );
  }
  if (status === 'failed') {
    return <span className="badge bg-danger-subtle text-danger-emphasis rounded-pill small">failed</span>;
  }
  return <span className="badge bg-success-subtle text-success-emphasis rounded-pill small">ok</span>;
}

export function CardShell({ card, boardId, children, onChatToggle }) {
  const { id, meta = {}, status } = card;

  return (
    <div className="card h-100 shadow-sm border-0 rounded-3">
      {/* header */}
      <div className="card-header d-flex align-items-start gap-2 py-2 px-3 bg-transparent border-bottom">
        <div className="flex-grow-1 min-w-0">
          <div className="fw-semibold text-truncate">{meta.title ?? id}</div>
          <div className="d-flex flex-wrap gap-1 mt-1">
            {(meta.tags ?? []).map(t => (
              <span key={t} className="badge bg-secondary-subtle text-secondary-emphasis rounded-pill"
                    style={{ fontSize: '0.65rem' }}>{t}</span>
            ))}
          </div>
        </div>
        <div className="d-flex align-items-center gap-1 flex-shrink-0">
          <StatusBadge status={status} />
          {onChatToggle && (
            <button className="btn btn-sm btn-outline-secondary py-0 px-2"
                    onClick={onChatToggle} title="Chat">
              <i className="bi bi-chat" />
            </button>
          )}
          <button className="btn btn-sm btn-outline-secondary py-0 px-2"
                  onClick={() => refreshCard(boardId, id)}
                  disabled={status === 'running'}
                  title="Refresh">
            <i className="bi bi-arrow-clockwise" />
          </button>
        </div>
      </div>
      {/* body */}
      <div className="card-body p-3 overflow-auto">{children}</div>
    </div>
  );
}
