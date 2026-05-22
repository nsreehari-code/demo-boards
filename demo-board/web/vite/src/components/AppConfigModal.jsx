import React, { useEffect, useState } from 'react';
import {
  clearStoredAppConfigOverride,
  getAppConfig,
  hasStoredAppConfigOverride,
  saveAppConfigOverride,
} from '../lib/appConfig.js';

function toFormState(config) {
  return {
    defaultBoardId: config?.defaultBoardId ?? '',
    defaultBoardLabel: config?.defaultBoard?.label ?? '',
    defaultBoardSubtitle: config?.defaultBoard?.subtitle ?? '',
    refreshAllIntervalSeconds: String(config?.refreshAllIntervalSeconds ?? ''),
    serverOrigin: config?.serverOrigin ?? '',
  };
}

function normalizeFormState(formState) {
  return {
    defaultBoardId: formState.defaultBoardId,
    defaultBoard: {
      label: formState.defaultBoardLabel,
      subtitle: formState.defaultBoardSubtitle,
    },
    refreshAllIntervalSeconds: Number(formState.refreshAllIntervalSeconds),
    serverOrigin: formState.serverOrigin,
  };
}

export function AppConfigModal({ autoOpen = false, serverUnreachable = false, serverUnreachableMessage = '' }) {
  const [open, setOpen] = useState(false);
  const [openedByAuto, setOpenedByAuto] = useState(false);
  const [formState, setFormState] = useState(() => toFormState(getAppConfig()));
  const overrideActive = hasStoredAppConfigOverride();

  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      setOpenedByAuto(true);
    }
  }, [autoOpen]);

  useEffect(() => {
    if (!serverUnreachable && openedByAuto) {
      setOpen(false);
      setOpenedByAuto(false);
    }
  }, [openedByAuto, serverUnreachable]);

  useEffect(() => {
    if (!open) return undefined;

    setFormState(toFormState(getAppConfig()));

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const updateField = (field) => (event) => {
    const value = event.target.value;
    setFormState((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    saveAppConfigOverride(normalizeFormState(formState));
    window.location.reload();
  };

  const handleReset = () => {
    clearStoredAppConfigOverride();
    window.location.reload();
  };

  return (
    <>
      <button
        type="button"
        className="board-settings-toggle d-inline-flex align-items-center justify-content-center"
        onClick={() => {
          setOpenedByAuto(false);
          setOpen(true);
        }}
        title="Board settings"
        aria-label="Open board settings"
      >
        <i className="bi bi-gear-fill" />
      </button>

      {open ? (
        <div className="board-settings-layer" role="presentation">
          <button
            type="button"
            className="board-settings-backdrop"
            aria-label="Close board settings"
            onClick={() => {
              setOpenedByAuto(false);
              setOpen(false);
            }}
          />

          <section
            className="board-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-settings-title"
          >
            <div className="board-settings-modal__header">
              <div>
                <div className="board-settings-modal__eyebrow">Runtime config</div>
                <h2 id="board-settings-title" className="board-settings-modal__title">Board settings</h2>
              </div>
              <button
                type="button"
                className="board-settings-modal__close board-ingest-pane__count board-ingest-pane__count-button d-inline-flex align-items-center justify-content-center"
                aria-label="Close board settings"
                onClick={() => {
                  setOpenedByAuto(false);
                  setOpen(false);
                }}
              >
                <i className="bi bi-x-lg" />
              </button>
            </div>

            <form className="board-settings-form" onSubmit={handleSubmit}>
              <label className="board-settings-field">
                <span>Server origin</span>
                <input
                  className={`board-input${serverUnreachable ? ' board-input--error' : ''}`}
                  type="url"
                  value={formState.serverOrigin}
                  onChange={updateField('serverOrigin')}
                  placeholder="http://localhost:7799"
                  aria-invalid={serverUnreachable ? 'true' : 'false'}
                />
                {serverUnreachable ? (
                  <div className="board-settings-alert" role="alert" aria-live="assertive">
                    <span className="board-settings-alert__badge">
                      <i className="bi bi-exclamation-triangle-fill" aria-hidden="true" />
                      Server unreachable
                    </span>
                    <span className="board-settings-alert__message">
                      {serverUnreachableMessage || 'Configured server origin is unreachable.'}
                    </span>
                  </div>
                ) : null}
              </label>

              <label className="board-settings-field">
                <span>Default board id</span>
                <input className="board-input" type="text" value={formState.defaultBoardId} onChange={updateField('defaultBoardId')} placeholder="live" />
              </label>

              <label className="board-settings-field">
                <span>Board label</span>
                <input className="board-input" type="text" value={formState.defaultBoardLabel} onChange={updateField('defaultBoardLabel')} placeholder="Live" />
              </label>

              <label className="board-settings-field">
                <span>Board subtitle</span>
                <input className="board-input" type="text" value={formState.defaultBoardSubtitle} onChange={updateField('defaultBoardSubtitle')} placeholder="Live operational intelligence for agent workflows" />
              </label>

              <label className="board-settings-field">
                <span>Refresh interval (seconds)</span>
                <input className="board-input" type="number" min="1" step="1" value={formState.refreshAllIntervalSeconds} onChange={updateField('refreshAllIntervalSeconds')} placeholder="300" />
              </label>

              <p className="board-settings-form__hint">
                Page title and subtitle now always mirror the board label and subtitle. Save writes a versioned local override and reloads the page so the app boots again with the new config.
                {overrideActive ? ' A stored override is active right now.' : ' No stored override is active right now.'}
              </p>

              <div className="board-settings-form__actions">
                <button type="button" className="btn btn-outline-secondary board-button" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="btn btn-outline-secondary board-button" onClick={handleReset}>Reset to shipped config</button>
                <button type="submit" className="btn btn-primary board-button">Save and reload</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}