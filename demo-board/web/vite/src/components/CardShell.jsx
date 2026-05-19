import React, { useEffect, useState } from 'react';
import { useCardState } from '../hooks/useCardState.js';
import { CardCore } from './CardCore.jsx';
import { ChatPane } from './ChatPane.jsx';

const CHAT_PROCESSING_PULSE_STYLE = {
  animation: 'card-shell-chat-pulse 0.9s ease-in-out infinite',
  transformOrigin: 'center',
};

function getStatusTone(status) {
  switch (status) {
    case 'completed':
      return 'board-tone--completed';
    case 'running':
      return 'board-tone--running';
    case 'failed':
      return 'board-tone--failed';
    case 'blocked':
      return 'board-tone--blocked';
    default:
      return 'board-tone--fresh';
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
      className="board-modal position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
      style={{ zIndex: 1200, padding: '1rem' }}
      onClick={onClose}
    >
      <div
        className="board-modal__dialog w-100"
        style={{ maxWidth: '960px', height: 'min(90vh, 720px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="board-modal__header d-flex align-items-center justify-content-between gap-2 px-3 py-3">
          <div className="board-modal__title text-truncate">Chat: {title}</div>
          <button type="button" className="board-icon-button" onClick={onClose} title="Close chat">
            <i className="bi bi-x-lg" />
          </button>
        </div>
        <div className="board-modal__body p-0" style={{ height: 'calc(100% - 65px)' }}>
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
  const statusTone = getStatusTone(status);
  const refreshDisabled = cardState.cardRuntime?.status === 'running';
  const chatProcessing = cardState.chatState?.processing === true;
  const showRefresh = cardState.canRefresh === true;

  return (
    <>
      <style>{`@keyframes card-shell-chat-pulse { 0%, 100% { opacity: 0.35; transform: scale(1); } 50% { opacity: 1; transform: scale(1.24); } }`}</style>
      <div className={`board-card ${statusTone}`}>
        <div className="board-card__header">
          <div className="board-card__title-wrap">
            <div className="board-card__title-block">
              <div className="board-card__title text-truncate">{title}</div>
              <div className="board-card__meta">
                {status !== 'completed' ? <span className={`board-status-pill ${statusTone}`}>{status}</span> : null}
              </div>
            </div>
          </div>
          <div className="board-card__actions">
            {showRefresh ? (
              refreshDisabled ? (
                <span
                  className="board-icon-button disabled"
                  aria-label="Refreshing"
                  title="Refreshing"
                >
                  <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                </span>
              ) : (
                <button
                  type="button"
                  className="board-icon-button"
                  onClick={() => cardState.cardActions?.refresh()}
                  title="Refresh"
                >
                  <i className="bi bi-arrow-clockwise" />
                </button>
              )
            ) : null}
            <button
              type="button"
              className="board-icon-button"
              onClick={() => setChatOpen(true)}
              title={chatProcessing ? 'Chat processing' : 'Open chat'}
            >
              <i className="bi bi-chat" style={chatProcessing ? CHAT_PROCESSING_PULSE_STYLE : undefined} />
            </button>
          </div>
        </div>
        <div className="board-card__body">
          <CardCore boardId={boardId} cardId={cardId} />
        </div>
      </div>

      {chatOpen ? (
        <ChatModal boardId={boardId} cardId={cardId} title={title} onClose={() => setChatOpen(false)} />
      ) : null}
    </>
  );
}
