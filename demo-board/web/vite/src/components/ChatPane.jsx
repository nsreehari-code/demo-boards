import React, { useState, useEffect, useRef } from 'react';
import { useChatState } from '../hooks/useChatState.js';

// Subscribe to chat SSE on mount so the server sends card_chats notifications
function useChatSubscription(subscribeChat, unsubscribeChat, boardId, cardId, boardSseClientId) {
  useEffect(() => {
    if (!subscribeChat || !unsubscribeChat || !boardId || !cardId || !boardSseClientId) return;
    subscribeChat().catch(() => {});
    return () => { unsubscribeChat().catch(() => {}); };
  }, [subscribeChat, unsubscribeChat, boardId, cardId, boardSseClientId]);
}

function UserBubbleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function AssistantBubbleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function WorkingBubbleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ChatIconShell({ children }) {
  return (
    <span
      className="flex-shrink-0 d-inline-flex align-items-center"
      aria-hidden="true"
      style={{ lineHeight: 1.4, opacity: 0.55, marginTop: '0.1rem' }}
    >
      {children}
    </span>
  );
}

function ChatMessageText({ text, compact = false }) {
  return (
    <div
      className="board-chat__message"
      style={{
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        ...(compact ? {
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 8,
          overflow: 'hidden',
        } : null),
      }}
    >
      {text}
    </div>
  );
}

function ChatBubble({ msg, compact = false }) {
  const { role, text, files } = msg;
  if (role === 'system') {
    return <div className="text-center small text-muted fst-italic px-2 my-1">{text}</div>;
  }
  const isUser = role === 'user';
  return (
    <div className={`d-flex mb-2 ${isUser ? 'justify-content-end' : ''}`}>
      <div
        className={`px-2 py-2 rounded-3 small d-flex align-items-start ${isUser ? 'flex-row-reverse' : ''}`}
        style={{
          maxWidth: '82%',
          background: isUser
            ? 'var(--bs-primary-bg-subtle, #cfe2ff)'
            : 'var(--bs-light, #f8f9fa)',
          border: isUser ? 'none' : '1px solid var(--bs-border-color, #dee2e6)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
          overflowX: 'hidden',
          lineHeight: 1.4,
          gap: '0.45rem',
        }}
      >
        <ChatIconShell>
          {isUser ? <UserBubbleIcon /> : <AssistantBubbleIcon />}
        </ChatIconShell>
        <div className="flex-grow-1 min-w-0">
          <ChatMessageText text={text} compact={compact} />
          {(files ?? []).map((f, i) => (
            <div key={i} className="badge bg-secondary-subtle text-secondary-emphasis mt-1 d-block">{f}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkingBubble() {
  return (
    <div className="d-flex mb-2">
      <div
        className="px-2 py-1 rounded-3 small text-muted fst-italic d-inline-flex align-items-center"
        style={{
          maxWidth: '82%',
          background: 'var(--bs-light, #f8f9fa)',
          border: '1px solid var(--bs-border-color, #dee2e6)',
          gap: '0.45rem',
        }}
      >
        <ChatIconShell>
          <WorkingBubbleIcon />
        </ChatIconShell>
        <span>AI working...</span>
        <span
          className="spinner-border spinner-border-sm flex-shrink-0"
          role="status"
          aria-label="AI working"
          style={{ width: '0.75rem', height: '0.75rem', borderWidth: '0.12em' }}
        />
      </div>
    </div>
  );
}

function ChatComposer({ chatActions, placeholder, processing }) {
  const [text, setText] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const upload = (file) => {
    if (!file || processing) return;
    chatActions.uploadFileForChat(file).catch(() => {});
  };

  const send = () => {
    if (processing) return;
    const t = text.trim();
    if (!t) return;
    chatActions.sendChat(t).catch(() => {});
    setText('');
  };

  return (
    <div className="board-chat-pane__composer border-top p-2 d-flex flex-column gap-2 flex-shrink-0">
      <div
        className={`board-chat-pane__dropzone border rounded-3 p-2 small text-center${processing ? ' is-disabled' : dragActive ? ' is-active' : ''}`}
        role="button"
        tabIndex={0}
        aria-disabled={processing}
        onClick={() => { if (!processing) fileRef.current?.click(); }}
        onDragEnter={(e) => { e.preventDefault(); if (!processing) setDragActive(true); }}
        onDragOver={(e) => { e.preventDefault(); if (!processing) setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (!processing && e.currentTarget === e.target) setDragActive(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          upload(e.dataTransfer.files?.[0]);
        }}
        onKeyDown={(e) => {
          if (processing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
      >
        Drop a file here or click to browse
        <input
          ref={fileRef}
          type="file"
          className="d-none"
          disabled={processing}
          onChange={(e) => {
            upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="board-chat-pane__input-row d-flex gap-2 align-items-end">
        <textarea
          ref={textareaRef}
          className="board-chat-pane__textarea form-control form-control-sm"
          rows={1}
          value={text}
          placeholder={placeholder ?? 'Send a message…'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ resize: 'none', minHeight: '38px', maxHeight: '160px' }}
        />
        <button className="board-chat-pane__send btn btn-sm btn-primary flex-shrink-0" onClick={send} disabled={processing || !text.trim()}>
          <i className="bi bi-send" />
        </button>
      </div>
    </div>
  );
}

export function ChatPane({ boardId, cardId, readOnly = false, compact = false }) {
  const chat = useChatState(boardId, cardId);
  const messages = chat?.messages ?? [];
  const processing = chat?.processing ?? false;
  const chatActions = chat?.chatActions ?? null;
  const boardSseClientId = chat?.boardSseClientId ?? null;
  const bottomRef = useRef(null);

  useChatSubscription(chatActions?.subscribeChat, chatActions?.unsubscribeChat, boardId, cardId, boardSseClientId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!chat) return null;

  return (
    <div className="board-chat-pane">
      <div
        className="board-chat-pane__messages p-2"
      >
        {messages.map((msg, i) => <ChatBubble key={i} msg={msg} compact={compact} />)}
        {processing && <WorkingBubble />}
        <div ref={bottomRef} />
      </div>
      {!readOnly && chatActions && <ChatComposer chatActions={chatActions} processing={processing} />}
    </div>
  );
}
