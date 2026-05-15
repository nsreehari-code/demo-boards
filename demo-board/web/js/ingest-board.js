(function () {
  var INGEST_RAIL_STATE_KEY = 'demo-board-ingest-rail-collapsed';

  function readIngestRailCollapsed() {
    try {
      return window.localStorage.getItem(INGEST_RAIL_STATE_KEY) === 'true';
    } catch (_) {
      return false;
    }
  }

  function writeIngestRailCollapsed(collapsed) {
    try {
      window.localStorage.setItem(INGEST_RAIL_STATE_KEY, collapsed ? 'true' : 'false');
    } catch (_) {
      // Ignore storage failures; the rail still works without persistence.
    }
  }

  function getCardPhase(model) {
    var meta = model && model.card && model.card.meta ? model.card.meta : {};
    var stateField = meta.ingestStateField || meta.ingest_state_field || 'X';
    var rawState = model && model.card_data ? model.card_data[stateField] : null;
    return String(rawState || '').toLowerCase();
  }

  function getCardSortTimestamp(model) {
    var runtimeState = model && model.runtime_state && model.runtime_state.runtime ? model.runtime_state.runtime : null;
    var runtimeValue = runtimeState && runtimeState.last_transition_at ? runtimeState.last_transition_at : null;
    var cardValue = model && model.card_data && model.card_data.lastRun ? model.card_data.lastRun : null;
    var value = runtimeValue || cardValue || null;
    var time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : -Infinity;
  }

  function sortBoardCardIds(state) {
    var ids = state && Array.isArray(state.cardIds) ? state.cardIds.slice() : [];
    ids.sort(function (leftId, rightId) {
      var left = state.modelsById[leftId];
      var right = state.modelsById[rightId];
      var leftActive = getCardPhase(left) === 'active' ? 0 : 1;
      var rightActive = getCardPhase(right) === 'active' ? 0 : 1;
      if (leftActive !== rightActive) {
        return leftActive - rightActive;
      }

      var leftTime = getCardSortTimestamp(left);
      var rightTime = getCardSortTimestamp(right);
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }

      return String(leftId).localeCompare(String(rightId));
    });
    return ids;
  }

  (function () {
    var _LC = window.LiveCard;
    if (!_LC || typeof _LC.registerCardRenderer !== 'function') return;

    function normalizeMessages(messages) {
      return (Array.isArray(messages) ? messages : []).map(function (msg) {
        if (!msg || typeof msg !== 'object') return null;
        return {
          role: typeof msg.role === 'string' ? msg.role : 'system',
          text: typeof msg.text === 'string' ? msg.text : typeof msg.message === 'string' ? msg.message : '',
          files: Array.isArray(msg.files) ? msg.files : []
        };
      }).filter(Boolean);
    }

    function getChatMessages(model, context) {
      var chatState = context && context.chatState && typeof context.chatState === 'object'
        ? context.chatState
        : null;
      var stateMessages = normalizeMessages(chatState && chatState.messages);
      if (stateMessages.length) {
        return stateMessages;
      }
      return normalizeMessages(model && model.card_data && model.card_data.messages);
    }

    if (typeof _LC.registerBoardTheme === 'function') {
      _LC.registerBoardTheme('ingest', {
        boardClass: 'lc-ingest-board',
        listClass: 'lc-ingest-board-list',
        styles: [
          '.lc-ingest-board { position:relative; display:flex; justify-content:flex-start; align-items:stretch; width:auto; height:100%; min-height:100%; overflow:visible; }',
          '.lc-ingest-board-host { display:inline-flex; align-items:flex-start; justify-content:flex-start; gap:.5rem; width:auto; max-width:calc(100vw - 24px); height:100%; min-height:100%; padding:0; overflow:visible; pointer-events:auto; }',
          '.lc-ingest-board-rail { flex:0 0 auto; min-width:0; width:min(28rem, calc(100vw - 4.5rem)); max-width:min(28rem, calc(100vw - 4.5rem)); height:100%; max-height:none; display:flex; flex-direction:column; gap:1rem; padding:1rem; box-sizing:border-box; overflow:hidden auto; scrollbar-width:thin; scrollbar-color:rgba(15,23,42,.28) transparent; background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(248,250,252,.94)); border:1px solid rgba(15,23,42,.08); border-radius:1.25rem; box-shadow:0 20px 50px rgba(15,23,42,.12); backdrop-filter:blur(10px); opacity:1; transition:width .24s cubic-bezier(.22,1,.36,1), max-width .24s cubic-bezier(.22,1,.36,1), padding .24s cubic-bezier(.22,1,.36,1), border-color .24s cubic-bezier(.22,1,.36,1), box-shadow .24s cubic-bezier(.22,1,.36,1), opacity .18s ease; }',
          '.lc-ingest-board-rail::-webkit-scrollbar { width:8px; }',
          '.lc-ingest-board-rail::-webkit-scrollbar-track { background:transparent; }',
          '.lc-ingest-board-rail::-webkit-scrollbar-thumb { background:rgba(15,23,42,.22); border-radius:999px; border:2px solid transparent; background-clip:padding-box; }',
          '.lc-ingest-board-rail:hover::-webkit-scrollbar-thumb { background:rgba(15,23,42,.32); border-radius:999px; border:2px solid transparent; background-clip:padding-box; }',
          '.lc-ingest-board-host.lc-ingest-collapsed { width:2rem; max-width:2rem; pointer-events:none; }',
          '.lc-ingest-board-host.lc-ingest-collapsed .lc-ingest-board-rail { width:0; min-width:0; max-width:0; padding:0; border-color:transparent; box-shadow:none; opacity:0; pointer-events:none; }',
          '.lc-ingest-board-host.lc-ingest-collapsed .lc-ingest-board-toggle { pointer-events:auto; }',
          '.lc-ingest-board-toggle { position:relative; flex:0 0 auto; margin-top:1rem; width:2rem; height:2rem; border:1px solid rgba(15,23,42,.12); border-radius:999px; background:rgba(255,255,255,.96); color:#334155; box-shadow:0 8px 20px rgba(15,23,42,.12); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:transform .24s cubic-bezier(.22,1,.36,1), box-shadow .24s cubic-bezier(.22,1,.36,1); }',
          '.lc-ingest-board-toggle:hover { transform:translateY(-1px); box-shadow:0 12px 24px rgba(15,23,42,.16); }',
          '.lc-ingest-board-toggle:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }',
          '.lc-ingest-board-toggle-icon { font-size:0.95rem; line-height:1; }',
          '.lc-ingest-board-list { display:flex; flex-direction:column; gap:.6rem; width:100%; margin:0; }',
          '.lc-ingest-board-list > [class*="col-"] { width:100%; max-width:none; flex:0 0 auto; }'
        ].join('')
      });
    }

    if (typeof _LC.registerBoardRenderer === 'function') {
      _LC.registerBoardRenderer('ingest', {
        createBoardHost: function (context) {
          var host = document.createElement('div');
          host.className = 'lc-ingest-board-host';
          var collapsed = readIngestRailCollapsed();

          var toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'lc-ingest-board-toggle';
          toggle.setAttribute('aria-label', collapsed ? 'Show ingest panel' : 'Hide ingest panel');
          toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');

          var toggleIcon = document.createElement('span');
          toggleIcon.className = 'lc-ingest-board-toggle-icon';
          toggleIcon.textContent = collapsed ? '>' : '<';
          toggle.appendChild(toggleIcon);

          var rail = document.createElement('div');
          rail.className = 'lc-ingest-board-rail';

          var listEl = context && context.defaultListEl ? context.defaultListEl : null;
          if (listEl) {
            rail.appendChild(listEl);
          }

          if (collapsed) {
            host.classList.add('lc-ingest-collapsed');
          }

          toggle.addEventListener('click', function () {
            collapsed = host.classList.toggle('lc-ingest-collapsed');
            toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
            toggle.setAttribute('aria-label', collapsed ? 'Show ingest panel' : 'Hide ingest panel');
            toggleIcon.textContent = collapsed ? '>' : '<';
            writeIngestRailCollapsed(collapsed);
          });

          host.appendChild(toggle);
          host.appendChild(rail);

          return {
            mountEl: host,
            listEl: listEl || host
          };
        }
      });
    }

    _LC.registerCardRenderer('ingest', {
      styles: [
        '.lc-ingest-shell { background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(248,250,252,.98)); border:1px solid rgba(15,23,42,.08); border-radius:1rem; overflow:hidden; box-shadow:0 10px 30px rgba(15,23,42,.08); }',
        '.lc-ingest-shell-head { display:flex; align-items:center; justify-content:space-between; gap:.75rem; padding:.75rem .9rem; border-bottom:1px solid rgba(15,23,42,.08); background:rgba(248,250,252,.92); }',
        '.lc-ingest-shell-title { font-size:.78rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#334155; }',
        '.lc-ingest-shell-state { font-size:.72rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#475569; }',
        '.lc-ingest-body { padding:.9rem; min-height:0; }',
        '.lc-ingest-shell-active .lc-ingest-body { min-height:26rem; }',
        '.lc-ingest-shell-active .lc-chat-el { height:100%; display:flex; flex-direction:column; gap:.75rem; }',
        '.lc-ingest-shell-active .lc-chat-body { min-height:18rem; max-height:none; background:rgba(255,255,255,.85); border:1px solid rgba(148,163,184,.25); border-radius:.85rem; padding:.5rem; }',
        '.lc-ingest-shell-active .lc-chat-input-bar { padding:.5rem; border:1px solid rgba(148,163,184,.25); border-radius:.85rem; background:#fff; }',
        '.lc-ingest-shell-done .lc-ingest-body { min-height:0; padding-bottom:1.15rem; }',
        '.lc-ingest-files { display:flex; flex-direction:column; gap:.75rem; }',
        '.lc-ingest-files-label { font-size:.74rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#64748b; }',
        '.lc-ingest-empty { border:1px dashed rgba(148,163,184,.45); border-radius:.85rem; padding:1rem; color:#64748b; font-size:.85rem; background:rgba(248,250,252,.7); }',
        '.lc-ingest-error { margin-bottom:.75rem; padding:.65rem .8rem; border-radius:.75rem; border:1px solid rgba(239,68,68,.18); background:rgba(254,242,242,.96); color:#991b1b; font-size:.82rem; }'
      ].join(''),

      createShell: function (model) {
        var meta = model && model.card && model.card.meta ? model.card.meta : {};
        var wrap = document.createElement('div');
        wrap.className = 'lc-ingest-shell';
        var head = document.createElement('div');
        head.className = 'lc-ingest-shell-head';
        var title = document.createElement('div');
        title.className = 'lc-ingest-shell-title';
        title.textContent = meta.title || model.id;
        var stateLabel = document.createElement('div');
        stateLabel.className = 'lc-ingest-shell-state';
        head.appendChild(title);
        head.appendChild(stateLabel);
        var body = document.createElement('div');
        body.className = 'lc-ingest-body';
        wrap.appendChild(head);
        wrap.appendChild(body);
        return wrap;
      },

      renderBody: function (model, shell, context) {
        var meta = model && model.card && model.card.meta ? model.card.meta : {};
        var stateField = meta.ingestStateField || meta.ingest_state_field || 'X';
        var state = String(model && model.card_data && model.card_data[stateField] || 'active').toLowerCase();
        var body = shell && shell.querySelector ? shell.querySelector('.lc-ingest-body') : null;
        if (!body) {
          return;
        }
        shell.className = 'lc-ingest-shell lc-ingest-shell-' + state;
        var stateEl = shell.querySelector('.lc-ingest-shell-state');
        if (stateEl) stateEl.textContent = state;
        body.innerHTML = '';

        if (model && model.card_data && model.card_data.status === 'error' && model.card_data.error) {
          var errEl = document.createElement('div');
          errEl.className = 'lc-ingest-error';
          errEl.textContent = model.card_data.error;
          body.appendChild(errEl);
        }

        if (state === 'done') {
          Promise.resolve(context.stopReceivingChats()).catch(function () {});
          var filesWrap = document.createElement('div');
          filesWrap.className = 'lc-ingest-files';
          var label = document.createElement('div');
          label.className = 'lc-ingest-files-label';
          label.textContent = meta.doneLabel || 'Uploaded files';
          var content = document.createElement('div');
          filesWrap.appendChild(label);
          filesWrap.appendChild(content);
          body.appendChild(filesWrap);
          context.renderBuiltin(null, 'text',
            model && model.card_data && Array.isArray(model.card_data.files) ? model.card_data.files : [],
            content,
            { data: { format: 'file-links', cardId: model.id } }
          );
          return;
        }

        var host = document.createElement('div');
        body.appendChild(host);
        var chatState = context && context.chatState && typeof context.chatState === 'object'
          ? context.chatState
          : { receiving: false, messages: [] };
        if (!chatState.receiving) {
          Promise.resolve(context.startReceivingChats()).catch(function () {});
        }
        context.renderBuiltin(null, 'chat', getChatMessages(model, context), host, {
          id: 'ingest-chat-' + model.id,
          data: { fileAttach: true, placeholder: meta.chatPlaceholder || 'Type a message...' }
        });
      }
    });
  })();

  function mountIngestBoard(options) {
    var mountOptions = options || {};
    var rootElement = mountOptions.rootElement;
    var BoardRuntimeShared = window.BoardRuntimeShared || {};
    if (!rootElement) {
      throw new Error('mountIngestBoard requires rootElement');
    }
    if (!mountOptions.state || !Array.isArray(mountOptions.state.cardIds) || !mountOptions.state.modelsById) {
      rootElement.textContent = 'ingest board requires a hydrated state object.';
      throw new Error('mountIngestBoard requires options.state');
    }

    var LiveCard = window.LiveCard;
    if (!LiveCard) {
      rootElement.textContent = 'LiveCard global not loaded.';
      throw new Error('LiveCard global not loaded');
    }

    if (rootElement.__ingestBoardRuntime && typeof rootElement.__ingestBoardRuntime.dispose === 'function') {
      rootElement.__ingestBoardRuntime.dispose();
    }

    var activeState = mountOptions.state;
    var activeMode = mountOptions.mode || 'board';
    var activeBoardView = null;

    function fileUrlBase() {
      if (typeof BoardRuntimeShared.buildFileUrlBase !== 'function') {
        return null;
      }
      return BoardRuntimeShared.buildFileUrlBase({
        boardId: mountOptions.boardId || (activeState && activeState.boardId),
        boardPaths: mountOptions.boardPaths,
        getServerOrigin: mountOptions.getServerOrigin,
      });
    }

    function notifyBoardEngine() {
      var engine = activeBoardView && activeBoardView.core ? activeBoardView.core.engine : null;
      if (engine && typeof engine.onServerSseEvent === 'function') {
        engine.onServerSseEvent();
      } else if (engine && typeof engine.refreshOpenChatModal === 'function') {
        engine.refreshOpenChatModal();
      }
    }

    function setState(nextState) {
      if (!nextState || typeof nextState !== 'object') {
        return activeState;
      }
      activeState = nextState;
      if (activeBoardView && typeof activeBoardView.setState === 'function') {
        activeBoardView.setState(function () { return activeState; });
      }
      notifyBoardEngine();
      return activeState;
    }

    function dispose() {
      if (activeBoardView && typeof activeBoardView.destroy === 'function') {
        activeBoardView.destroy();
      }
      activeBoardView = null;
      activeState = null;
      if (rootElement.__ingestBoardRuntime === runtimeClient) {
        rootElement.__ingestBoardRuntime = null;
      }
    }

    var engine = LiveCard.init({
      resolve: function (cardId) {
        return activeState && activeState.modelsById ? activeState.modelsById[cardId] : null;
      },
      chartLib: window.Chart || null,
      fileUrlBase: fileUrlBase() || undefined,
      markdown: window.marked ? function (value) { return window.marked.parse(value); } : null,
      sanitize: window.DOMPurify ? function (value) { return window.DOMPurify.sanitize(value); } : null,
      onPatchState: function (cardId, patch) {
        if (typeof mountOptions.onPatchState === 'function') {
          return mountOptions.onPatchState(cardId, patch || {});
        }
        return Promise.resolve();
      },
      onRefresh: function (cardId) {
        if (typeof mountOptions.onRefresh === 'function') {
          return mountOptions.onRefresh(cardId);
        }
        return Promise.resolve();
      },
      onAction: function (cardId, actionType, payload) {
        if (typeof mountOptions.onAction === 'function') {
          return mountOptions.onAction(cardId, actionType, payload || {});
        }
        return Promise.resolve();
      },
      startReceivingChats: function (cardId) {
        if (typeof mountOptions.startReceivingChats === 'function') {
          return mountOptions.startReceivingChats(cardId);
        }
        return Promise.resolve();
      },
      stopReceivingChats: function (cardId) {
        if (typeof mountOptions.stopReceivingChats === 'function') {
          return mountOptions.stopReceivingChats(cardId);
        }
        return Promise.resolve();
      }
    });

    rootElement.innerHTML = '';
    activeBoardView = LiveCard.Board(engine, rootElement, {
      initialState: activeState,
      getNodeIds: function (state) {
        return sortBoardCardIds(state);
      },
      selectNode: function (state, cardId) {
        return state.modelsById[cardId];
      },
      mode: activeMode,
      canvas: mountOptions.canvas || { height: '100%', overflow: 'auto' },
      boardTheme: mountOptions.boardTheme || 'ingest',
      boardRenderer: mountOptions.boardRenderer || 'ingest'
    });
    notifyBoardEngine();

    var runtimeClient = {
      rootElement: rootElement,
      dispose: dispose,
      setState: setState,
      getState: function () {
        return activeState;
      },
      setMode: function (mode) {
        activeMode = String(mode || 'board');
        if (activeBoardView && activeBoardView.core && typeof activeBoardView.core.setMode === 'function') {
          activeBoardView.core.setMode(activeMode);
        }
      },
      autoLayout: function () {
        if (activeBoardView && activeBoardView.core) {
          if (typeof activeBoardView.core.setMode === 'function') {
            activeBoardView.core.setMode('canvas');
          }
          if (typeof activeBoardView.core.autoLayout === 'function') {
            activeBoardView.core.autoLayout();
          }
        }
      },
      setDevMode: function (enabled) {
        if (activeBoardView && activeBoardView.core && typeof activeBoardView.core.setDevMode === 'function') {
          activeBoardView.core.setDevMode(!!enabled);
        }
      }
    };

    rootElement.__ingestBoardRuntime = runtimeClient;
    runtimeClient.ready = Promise.resolve(runtimeClient);
    return runtimeClient;
  }

  function autoMountIngestBoards() {
    var roots = document.querySelectorAll('[data-ingest-board-root]');
    Array.prototype.forEach.call(roots, function (rootElement) {
      if (rootElement.dataset.ingestMounted === 'true' || !rootElement.__ingestInitialState) {
        return;
      }
      rootElement.dataset.ingestMounted = 'true';
      mountIngestBoard({
        rootElement: rootElement,
        state: rootElement.__ingestInitialState,
        canvas: { height: rootElement.dataset.canvasHeight || '100%', overflow: 'auto' }
      });
    });
  }

  window.IngestBoard = window.IngestBoard || {};
  window.IngestBoard.mount = mountIngestBoard;
  window.mountIngestBoard = mountIngestBoard;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMountIngestBoards, { once: true });
  } else {
    autoMountIngestBoards();
  }

  window.addEventListener('beforeunload', function () {
    var roots = document.querySelectorAll('[data-ingest-board-root]');
    Array.prototype.forEach.call(roots, function (rootElement) {
      if (rootElement.__ingestBoardRuntime && typeof rootElement.__ingestBoardRuntime.dispose === 'function') {
        rootElement.__ingestBoardRuntime.dispose();
      }
    });
  });
})();