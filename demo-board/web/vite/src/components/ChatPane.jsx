import React, { useState, useEffect, useRef } from 'react';
import { useChatState } from '../hooks/useChatState.js';

// Subscribe to chat SSE on mount so the server sends card_chats notifications
function useChatSubscription(chatActions, boardId, cardId) {
  useEffect(() => {
    if (!chatActions || !boardId || !cardId) return;
    chatActions.subscribeChat().catch(() => {});
    return () => { chatActions.unsubscribeChat().catch(() => {}); };
  }, [chatActions, boardId, cardId]);
}

function ChatBubble({ msg }) {
  const { role, text, files } = msg;
  if (role === 'system') {
    return <div className="text-center small text-muted fst-italic px-2 my-1">{text}</div>;
  }
  const isUser = role === 'user';
  return (
    <div className={`d-flex mb-2 ${isUser ? 'justify-content-end' : ''}`}>
      <div className="px-3 py-2 rounded-3 small"
           style={{
             maxWidth: '85%',
             background: isUser
               ? 'var(--bs-secondary-bg, #e9ecef)'
               : 'rgba(var(--bs-primary-rgb,13,110,253),0.10)',
             whiteSpace: 'pre-wrap',
           }}>
        {text}
        {(files ?? []).map((f, i) => (
          <div key={i} className="badge bg-secondary-subtle text-secondary-emphasis mt-1 d-block">{f}</div>
        ))}
      </div>
    </div>
  );
}

function WorkingBubble() {
  return (
    <div className="d-flex mb-2">
      <div
        className="px-3 py-2 rounded-3 small text-muted fst-italic"
        style={{
          maxWidth: '85%',
          background: 'rgba(var(--bs-primary-rgb,13,110,253),0.08)',
        }}
      >
        AI working...
      </div>
    </div>
  );
}

function ChatComposer({ chatActions, placeholder }) {
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
    if (!file) return;
    chatActions.uploadFileForChat(file).catch(() => {});
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    chatActions.sendChat(t).catch(() => {});
    setText('');
  };

  return (
    <div className="border-top p-2 d-flex flex-column gap-2 flex-shrink-0">
      <div
        className={`border rounded-3 p-2 small text-center ${dragActive ? 'border-primary bg-primary-subtle' : 'border-secondary-subtle bg-body-tertiary'}`}
        role="button"
        tabIndex={0}
        onClick={() => fileRef.current?.click()}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragActive(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          upload(e.dataTransfer.files?.[0]);
        }}
        onKeyDown={(e) => {
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
          onChange={(e) => {
            upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="d-flex gap-2 align-items-end">
        <textarea
          ref={textareaRef}
          className="form-control form-control-sm"
          rows={1}
          value={text}
          placeholder={placeholder ?? 'Send a message…'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ resize: 'none', minHeight: '38px', maxHeight: '160px' }}
        />
        <button className="btn btn-sm btn-primary flex-shrink-0" onClick={send} disabled={!text.trim()}>
          <i className="bi bi-send" />
        </button>
      </div>
    </div>
  );
}

export function ChatPane({ boardId, cardId, readOnly = false }) {
  const chat = useChatState(boardId, cardId);
  const messages = chat?.messages ?? [];
  const processing = chat?.processing ?? false;
  const chatActions = chat?.chatActions ?? null;
  const bottomRef = useRef(null);

  useChatSubscription(chatActions, boardId, cardId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!chat) return null;

  return (
    <div className="d-flex flex-column h-100 min-h-0">
      <div className="flex-grow-1 overflow-auto p-2" style={{ minHeight: 0 }}>
        {messages.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
        {processing && <WorkingBubble />}
        <div ref={bottomRef} />
      </div>
      {!readOnly && chatActions && <ChatComposer chatActions={chatActions} />}
    </div>
  );
}
