import React, { useState } from 'react';
import { useBoardSSE, useBoardState } from './hooks/useBoardState.js';
import { MainBoard }  from './components/MainBoard.jsx';
import { IngestPane } from './components/IngestPane.jsx';

const BOARD_ID = 'finbook';

export default function App() {
  const [ingestVisible, setIngestVisible] = useState(true);
  const boardState = useBoardSSE(BOARD_ID);
  const x = useBoardState(BOARD_ID);
  console.log('[useBoardState]', x);
  if (x) {
    Object.keys(x.cardContents).forEach(id =>
      console.log('[card]', id, {
        cardContent:         x.cardContents[id],
        cardData:            x.cardContents[id]?.card_data ?? {},
        cardRuntime:         x.cardRuntimes[id],
        requiresDataObjects: Object.fromEntries(
          (x.cardContents[id]?.requires ?? []).map(t => [t, x.dataObjects[t]])
        ),
      })
    );
  }

  return (
    <>
      {/* ── top nav ── */}
      <nav className="navbar navbar-expand-lg bg-body-tertiary border-bottom px-3 py-2"
           style={{ height: '56px' }}>
        <span className="navbar-brand fw-bold mb-0">Live Boards</span>
        <span className="ms-2 badge bg-secondary-subtle text-secondary-emphasis">
          {BOARD_ID}
        </span>
      </nav>

      {/* ── main content ── */}
      <div style={{ paddingTop: '56px' }}>
        {!boardState
          ? (
            <div className="d-flex align-items-center gap-2 p-4">
              <span className="spinner-border spinner-border-sm" role="status" />
              <p className="mb-0">Loading board…</p>
            </div>
          )
          : <MainBoard boardState={boardState} boardId={BOARD_ID} />}
      </div>

      {/* ── ingest overlay ── */}
      <IngestPane
        boardState={boardState}
        boardId={BOARD_ID}
        visible={ingestVisible}
        onToggle={() => setIngestVisible(v => !v)}
      />
    </>
  );
}
