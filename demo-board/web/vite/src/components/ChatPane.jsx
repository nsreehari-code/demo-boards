import React, { useState, useEffect, useRef } from 'react';
import { dispatchAction, uploadFile, subscribeCardChats, unsubscribeCardChats } from '../lib/client.js';

// Subscribe to chat SSE on mount so the server sends card_chats notifications
function useChatSubscription(boardId, cardId) {
  useEffect(() => {
    if (!boardId || !cardId) return;
    subscribeCardChats(boardId, cardId).catch(() => {});
    return () => { unsubscribeCardChats(boardId, cardId).catch(() => {}); };
  }, [boardId, cardId]);
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

function ChatInput({ boardId, cardId, placeholder }) {
  const [text, setText] = useState('');
  const fileRef = useRef(null);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    dispatchAction(boardId, cardId, 'chat-send', { text: t }).catch(() => {});
    setText('');
  };

  return (
    <div className="border-top p-2 d-flex gap-1 flex-shrink-0">
      <button className="btn btn-sm btn-outline-secondary"
              onClick={() => fileRef.current?.click()} title="Attach file">
        <i className="bi bi-paperclip" />
        <input ref={fileRef} type="file" className="d-none"
               onChange={e => {
                 const f = e.target.files?.[0];
                 if (f) uploadFile(boardId, cardId, f).catch(() => {});
                 e.target.value = '';
               }} />
      </button>
      <textarea
        className="form-control form-control-sm"
        rows={1}
        value={text}
        placeholder={placeholder ?? 'Send a message…'}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        style={{ resize: 'none' }}
      />
      <button className="btn btn-sm btn-primary" onClick={send} disabled={!text.trim()}>
        <i className="bi bi-send" />
      </button>
    </div>
  );
}

export function ChatPane({ card, chatData, boardId, onClose }) {
  const { id, meta = {}, card_data = {} } = card;
  const { messages = [], processing = false } = chatData ?? {};
  const done = card_data.phase === 'done';
  const bottomRef = useRef(null);

  useChatSubscription(boardId, id);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="d-flex flex-column" style={{ minHeight: 0 }}>
      {onClose && (
        <div className="d-flex align-items-center border-top pt-2 pb-1 px-1">
          <span className="small fw-semibold flex-grow-1">{meta.title} — Chat</span>
          {processing && <span className="spinner-border spinner-border-sm me-2" />}
          <button className="btn btn-sm btn-close" onClick={onClose} />
        </div>
      )}
      <div className="overflow-auto p-2" style={{ maxHeight: '30vh' }}>
        {messages.map((msg, i) => <ChatBubble key={i} msg={msg} />)}
        {processing && <div className="small text-muted fst-italic">Assistant is typing…</div>}
        <div ref={bottomRef} />
      </div>
      {!done && <ChatInput boardId={boardId} cardId={id} placeholder={meta.chatPlaceholder} />}
    </div>
  );
}
