import React from 'react';
import { useBoardState } from './hooks/useBoardState.js';
import { MainBoard }  from './components/MainBoard.jsx';

const BOARD_ID = 'finbook';

export default function App() {
  const board = useBoardState(BOARD_ID);

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
        {!board
          ? (
            <div className="d-flex align-items-center gap-2 p-4">
              <span className="spinner-border spinner-border-sm" role="status" />
              <p className="mb-0">Loading board…</p>
            </div>
          )
          : <MainBoard boardId={BOARD_ID} />}
      </div>
    </>
  );
}
