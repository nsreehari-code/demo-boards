import React, { useEffect, useState } from 'react';
import { useCardState } from '../hooks/useCardState.js';
import { CardCore } from './CardCore.jsx';
import { ChatPane } from './ChatPane.jsx';

const CHAT_PROCESSING_PULSE_STYLE = {
  animation: 'card-shell-chat-pulse 0.9s ease-in-out infinite',
  transformOrigin: 'center',
};

function getStatusBadgeClass(status) {
  switch (status) {
    case 'completed':
      return 'bg-success-subtle text-success-emphasis';
    case 'running':
      return 'bg-primary-subtle text-primary-emphasis';
    case 'failed':
      return 'bg-danger-subtle text-danger-emphasis';
    case 'blocked':
      return 'bg-warning-subtle text-warning-emphasis';
    default:
      return 'bg-secondary-subtle text-secondary-emphasis';
  }
}

function ChatModal({ boardId, cardId, title, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
      style={{ background: 'rgba(0, 0, 0, 0.45)', zIndex: 1200, padding: '1rem' }}
      onClick={onClose}
    >
      <div
        className="card border-0 shadow-lg w-100"
        style={{ maxWidth: '960px', height: 'min(90vh, 720px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="card-header d-flex align-items-center justify-content-between gap-2 bg-transparent">
          <div className="fw-semibold text-truncate">Chat: {title}</div>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={onClose} title="Close chat">
            <i className="bi bi-x-lg" />
          </button>
        </div>
        <div className="card-body p-0 min-h-0">
          <ChatPane boardId={boardId} cardId={cardId} />
        </div>
      </div>
    </div>
  );
}

export function CardShell({ boardId, cardId }) {
  const cardState = useCardState(boardId, cardId);
  const [chatOpen, setChatOpen] = useState(false);

  if (!cardState?.cardContent) return null;

  const title = cardState.cardContent.meta?.title ?? cardId;
  const status = cardState.cardRuntime?.status ?? 'fresh';
  const refreshDisabled = cardState.cardRuntime?.status === 'running';
  const chatProcessing = cardState.chatState?.processing === true;
  const showRefresh = (cardState.cardContent.source_defs?.length ?? 0) > 0;
  console.log(cardState);

  return (
    <>
      <style>{`@keyframes card-shell-chat-pulse { 0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 1; transform: scale(1.24); } }`}</style>
      <div className="card h-100 shadow-sm border-0 rounded-3">
        <div className="card-header d-flex align-items-center justify-content-between gap-2 py-2 px-3 bg-transparent border-bottom">
          <div className="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
            <div className="fw-semibold text-truncate min-w-0">{title}</div>
            <span className={`badge rounded-pill small flex-shrink-0 ${getStatusBadgeClass(status)}`}>{status}</span>
          </div>
          <div className="d-flex align-items-center gap-1 flex-shrink-0">
            {showRefresh ? (
              refreshDisabled ? (
                <span
                  className="btn btn-sm border-0 bg-transparent text-secondary py-0 px-2 disabled d-inline-flex align-items-center justify-content-center"
                  aria-label="Refreshing"
                  title="Refreshing"
                >
                  <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm border-0 bg-transparent text-secondary py-0 px-2"
                  onClick={() => cardState.cardActions?.refresh()}
                  title="Refresh"
                >
                  <i className="bi bi-arrow-clockwise" />
                </button>
              )
            ) : null}
            <button
              type="button"
              className="btn btn-sm border-0 bg-transparent text-secondary py-0 px-2"
              onClick={() => setChatOpen(true)}
              title={chatProcessing ? 'Chat processing' : 'Open chat'}
            >
              <i className="bi bi-chat" style={chatProcessing ? CHAT_PROCESSING_PULSE_STYLE : undefined} />
            </button>
          </div>
        </div>
        <div className="card-body p-3">
          <CardCore boardId={boardId} cardId={cardId} />
        </div>
      </div>

      {chatOpen ? (
        <ChatModal boardId={boardId} cardId={cardId} title={title} onClose={() => setChatOpen(false)} />
      ) : null}
    </>
  );
}
