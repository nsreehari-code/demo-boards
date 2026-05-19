import React, { useEffect, useRef, useState } from 'react';
import { useBoardState } from './hooks/useBoardState.js';
import { MainBoard }  from './components/MainBoard.jsx';
import { DEFAULT_BOARD_ID, PAGE_SUBTITLE, PAGE_TITLE, REFRESH_ALL_INTERVAL_MS } from './lib/appConfig.js';

const BOARD_ID = DEFAULT_BOARD_ID;
const DEFAULT_THEME = 'mist-ops';

function formatCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function App() {
  const board = useBoardState(BOARD_ID);
  const canRefreshAll = board?.hasRefreshableCards === true;
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + REFRESH_ALL_INTERVAL_MS);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [refreshingAll, setRefreshingAll] = useState(false);
  const refreshAllRef = useRef(null);
  const isMountedRef = useRef(true);

  const remainingMs = Math.max(0, nextRefreshAt - nowMs);

  refreshAllRef.current = board?.boardActions?.refreshAll ?? null;

  const resetCountdown = () => {
    const currentTime = Date.now();
    setNowMs(currentTime);
    setNextRefreshAt(currentTime + REFRESH_ALL_INTERVAL_MS);
  };

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  useEffect(() => {
    if (refreshingAll) {
      return undefined;
    }

    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [refreshingAll]);

  useEffect(() => {
    if (remainingMs > 0 || refreshingAll || !canRefreshAll) {
      return;
    }

    const runRefreshAll = async () => {
      setRefreshingAll(true);
      try {
        await refreshAllRef.current?.();
      } finally {
        if (isMountedRef.current) {
          setRefreshingAll(false);
          resetCountdown();
        }
      }
    };

    runRefreshAll();
  }, [canRefreshAll, refreshingAll, remainingMs]);

  const handleRefreshAll = async () => {
    if (refreshingAll) {
      return;
    }

    setRefreshingAll(true);
    try {
      await refreshAllRef.current?.();
    } finally {
      setRefreshingAll(false);
      resetCountdown();
    }
  };

  return (
    <div className="board-app-shell" data-theme={DEFAULT_THEME}>
      <nav className="board-topbar px-3 px-lg-4 py-1">
        <div className="board-topbar__layout d-flex align-items-center justify-content-between gap-2 flex-nowrap">
          <div className="board-topbar__title-group min-w-0 flex-grow-1 pe-2">
            <div className="board-topbar__brand text-truncate">{PAGE_TITLE}</div>
            <div className="board-topbar__subtitle text-truncate">{PAGE_SUBTITLE}</div>
          </div>
          <div className="board-topbar__actions d-flex align-items-center justify-content-end gap-2 flex-shrink-0 ms-auto">
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm board-button d-inline-flex align-items-center gap-2"
              onClick={handleRefreshAll}
              disabled={!canRefreshAll || refreshingAll}
              title="Refresh all cards"
            >
              {refreshingAll ? (
                <span className="spinner-border spinner-border-sm" aria-hidden="true" />
              ) : (
                <i className="bi bi-arrow-clockwise" />
              )}
              <span>{formatCountdown(remainingMs)}</span>
            </button>
          </div>
        </div>
      </nav>

      <main className="board-main">
        {!board
          ? (
            <div className="board-loading">
              <span className="spinner-border spinner-border-sm" role="status" />
              <p className="mb-0">Connecting to live board state…</p>
            </div>
          )
          : <MainBoard boardId={BOARD_ID} />}
      </main>
    </div>
  );
}
