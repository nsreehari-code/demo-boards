(function () {
  // App-specific ingest package for board-livecards.
  //
  // This file intentionally owns only ingest behavior:
  // - ingest board theme and renderer registration
  // - ingest card sorting rules
  // - a thin mount API that targets a caller-provided DOM node
  //
  // Generic hydrated-state mounting lives in BoardLivecardsStatefulHost.
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

  var INGEST_OPEN_STATE_KEY = 'demo-board-ingest-open';
  var DONE_SECTION_ID = '__ingest_done__';

  function readIngestOpenId() {
    try { return window.localStorage.getItem(INGEST_OPEN_STATE_KEY) || null; } catch (_) { return null; }
  }
  function writeIngestOpenId(id) {
    try { window.localStorage.setItem(INGEST_OPEN_STATE_KEY, id || ''); } catch (_) { /* ignore */ }
  }

  (function () {
    var _LC = window.LiveCard;
    if (!_LC || typeof _LC.registerCardRenderer !== 'function') return;

    function disposePane(pane) {
      if (pane && typeof pane.dispose === 'function') {
        try { pane.dispose(); } catch (_) { /* ignore */ }
      }
    }

    function findHost(node) {
      var n = node;
      while (n && n !== document.body) {
        if (n.classList && n.classList.contains('lc-ingest-board-host')) return n;
        n = n.parentNode;
      }
      return null;
    }

    if (typeof _LC.registerBoardTheme === 'function') {
      _LC.registerBoardTheme('ingest', {
        boardClass: 'lc-ingest-board',
        listClass: 'lc-ingest-active-list',
        styles: [
          /* Layout shell: rail + collapse toggle */
          '.lc-ingest-board { position:relative; display:flex; width:auto; height:100%; min-height:100%; overflow:visible; }',
          '.lc-ingest-board-host { display:inline-flex; align-items:stretch; gap:.5rem; max-width:calc(100vw - 24px); height:100%; min-height:100%; }',
          '.lc-ingest-rail { position:relative; z-index:1050; pointer-events:auto; width:min(28rem, calc(100vw - 4.5rem)); height:100%; overflow:hidden; transition:width .24s ease, opacity .18s ease; }',
          '.lc-ingest-board-host.lc-ingest-collapsed .lc-ingest-rail { width:0; opacity:0; pointer-events:none; padding:0; border-color:transparent; box-shadow:none; }',
          '.lc-ingest-rail-toggle { pointer-events:auto; align-self:flex-start; margin-top:1rem; width:2rem; height:2rem; padding:0; display:inline-flex; align-items:center; justify-content:center; }',

          /* Carousel nav bar */
          '.lc-ingest-nav { flex:0 0 auto; display:flex; align-items:center; gap:.25rem; padding:.5rem .75rem; border-bottom:1px solid rgba(0,0,0,.08); }',
          '.lc-ingest-nav-btn { text-decoration:none; opacity:.55; line-height:1; }',
          '.lc-ingest-nav-btn:hover:not(:disabled) { opacity:.85; text-decoration:none; }',
          '.lc-ingest-nav-btn:disabled { opacity:.25; }',
          '.lc-ingest-nav-btn:focus-visible { outline:2px solid currentColor; outline-offset:2px; }',
          '.lc-ingest-nav-btn:focus:not(:focus-visible) { box-shadow:none; outline:none; }',  
          '.lc-ingest-nav-title { flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
          '.lc-ingest-counter { flex:0 0 auto; white-space:nowrap; }',

          /* Card slot: fills remaining rail height, cards stacked absolutely */
          '.lc-ingest-slot { flex:1 1 auto; min-height:0; position:relative; overflow:hidden; }',
          '.lc-ingest-active-list { position:absolute; inset:0; --bs-gutter-x:0; --bs-gutter-y:0; margin:0 !important; }',
          '.lc-ingest-active-list > * { position:absolute; inset:0; width:100% !important; height:100% !important; display:none; flex-direction:column; padding:0 !important; overflow:hidden; margin:0 !important; }',
          '.lc-ingest-active-list > .lc-ingest-current { display:flex; }',

          /* Shell fills its slot */
          '.lc-ingest-shell-wrap { height:100%; display:flex; flex-direction:column; min-height:0; overflow:hidden; }',
          '.lc-ingest-active-card, .lc-ingest-done-card { flex:1 1 auto; display:flex; flex-direction:column; min-height:0; overflow:hidden; }',
          '.lc-ingest-done-card .lc-chat-pane-input { display:none !important; }',

          /* Chat pane: messages scroll, input pinned at bottom */
          '.lc-ingest-chat-host { flex:1 1 auto; display:flex; flex-direction:column; min-height:0; overflow:hidden; padding:.5rem; gap:.5rem; }',
          '.lc-ingest-chat-host > .lc-chat-pane-body { flex:1 1 auto; min-height:0; max-height:none; overflow:auto; border-radius:.375rem; }',
          '.lc-ingest-chat-host .lc-chat-bubble-user { background:var(--bs-secondary-bg,#e9ecef) !important; }',
          '.lc-ingest-chat-host .lc-chat-bubble-assistant { background:rgba(var(--bs-primary-rgb,13,110,253),0.10) !important; }',
          '.lc-ingest-chat-host .lc-chat-bubble { margin-top:calc(.75rem) !important; margin-bottom:calc(.750rem) !important; }',
          '.lc-ingest-chat-host > .lc-chat-pane-input { flex:0 0 auto; border-radius:.375rem; overflow:hidden; }',

          /* Done card: files list scrolls */
          '.lc-ingest-done-files { flex:1 1 auto; min-height:0; overflow:auto; padding:.5rem; }' /* kept for legacy */
        ].join('')
      });
    }

    if (typeof _LC.registerBoardRenderer === 'function') {
      _LC.registerBoardRenderer('ingest', {
        createBoardHost: function (context) {
          var uid = Math.random().toString(36).slice(2, 8);
          var host = document.createElement('div');
          host.className = 'lc-ingest-board-host';
          host.__ingestUid = uid;
          host.__ingestCurrentId = readIngestOpenId();
          host.__ingestCurrentIndex = 0;

          var collapsed = readIngestRailCollapsed();
          if (collapsed) host.classList.add('lc-ingest-collapsed');

          /* Rail hide/show toggle */
          var toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'btn btn-light rounded-circle shadow-sm lc-ingest-rail-toggle';
          toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
          toggle.setAttribute('aria-label', collapsed ? 'Show ingest panel' : 'Hide ingest panel');
          toggle.textContent = collapsed ? '>' : '<';
          toggle.addEventListener('click', function () {
            collapsed = host.classList.toggle('lc-ingest-collapsed');
            toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
            toggle.setAttribute('aria-label', collapsed ? 'Show ingest panel' : 'Hide ingest panel');
            toggle.textContent = collapsed ? '>' : '<';
            writeIngestRailCollapsed(collapsed);
          });

          /* Rail card */
          var rail = document.createElement('div');
          rail.className = 'card lc-ingest-rail border-0 shadow-lg rounded-3';
          var railBody = document.createElement('div');
          railBody.className = 'card-body d-flex flex-column p-0 h-100 overflow-hidden';

          /* Carousel navigation bar */
          var nav = document.createElement('div');
          nav.className = 'lc-ingest-nav';

          var prevBtn = document.createElement('button');
          prevBtn.type = 'button';
          prevBtn.className = 'btn btn-sm btn-link text-secondary-emphasis py-0 px-1 lc-ingest-nav-btn';
          prevBtn.setAttribute('aria-label', 'Previous card');
          prevBtn.textContent = '▲';

          var counter = document.createElement('span');
          counter.className = 'lc-ingest-counter text-muted small';
          counter.textContent = '0 / 0';

          var navTitle = document.createElement('span');
          navTitle.className = 'lc-ingest-nav-title fw-semibold small';
          navTitle.textContent = '—';

          var navBadge = document.createElement('span');
          navBadge.className = 'badge lc-ingest-nav-badge';

          var nextBtn = document.createElement('button');
          nextBtn.type = 'button';
          nextBtn.className = 'btn btn-sm btn-link text-secondary-emphasis py-0 px-1 lc-ingest-nav-btn';
          nextBtn.setAttribute('aria-label', 'Next card');
          nextBtn.textContent = '▼';

          nav.appendChild(navTitle);
          nav.appendChild(navBadge);
          nav.appendChild(prevBtn);
          nav.appendChild(counter);
          nav.appendChild(nextBtn);

          /* Card slot: hosts the engine listEl, all cards overlap absolutely */
          var slot = document.createElement('div');
          slot.className = 'lc-ingest-slot';

          var listEl = context && context.defaultListEl ? context.defaultListEl : null;
          if (listEl) slot.appendChild(listEl);

          railBody.appendChild(nav);
          railBody.appendChild(slot);
          rail.appendChild(railBody);
          host.appendChild(toggle);
          host.appendChild(rail);

          /* Navigation helpers */
          function getShells() {
            if (!listEl) return [];
            /* Engine wraps shells in col-* divs; shells may also be direct children */
            var direct = Array.from(listEl.querySelectorAll(':scope > .lc-ingest-shell-wrap'));
            var nested = Array.from(listEl.querySelectorAll(':scope > * > .lc-ingest-shell-wrap'));
            return (direct.length ? direct : nested);
          }

          function goToIndex(idx) {
            var shells = getShells();
            var n = shells.length;
            if (!n) {
              counter.textContent = '0 / 0';
              navTitle.textContent = '—';
              navBadge.className = 'badge lc-ingest-nav-badge';
              navBadge.textContent = '';
              prevBtn.disabled = true;
              nextBtn.disabled = true;
              return;
            }
            idx = Math.max(0, Math.min(n - 1, idx));
            host.__ingestCurrentIndex = idx;

            /* Show only the wrapper of the current shell */
            shells.forEach(function (shell, i) {
              var wrapper = shell.parentElement;
              var target = (wrapper && wrapper !== listEl) ? wrapper : shell;
              if (i === idx) target.classList.add('lc-ingest-current');
              else target.classList.remove('lc-ingest-current');
            });

            /* Update nav from the current shell's ingest state */
            var shell = shells[idx];
            var st = shell.__ingestState;
            var parts = st && st.parts;
            var model = parts && parts._model;
            var meta = model && model.card && model.card.meta ? model.card.meta : {};
            var phase = st ? st.phase : null;

            host.__ingestCurrentId = shell.getAttribute('data-card-id');
            counter.textContent = (idx + 1) + ' / ' + n;
            navTitle.textContent = (meta && (meta.title || meta.name)) || (model && model.id) || '—';

            if (phase === 'done') {
              navBadge.className = 'badge bg-success-subtle text-success-emphasis lc-ingest-nav-badge';
              navBadge.textContent = 'done';
            } else if (phase) {
              navBadge.className = 'badge bg-primary-subtle text-primary-emphasis lc-ingest-nav-badge';
              navBadge.textContent = phase;
            } else {
              navBadge.className = 'badge lc-ingest-nav-badge';
              navBadge.textContent = '';
            }
            prevBtn.disabled = idx <= 0;
            nextBtn.disabled = idx >= n - 1;
            if (host.__ingestCurrentId) writeIngestOpenId(host.__ingestCurrentId);
          }

          function refreshNav() {
            var shells = getShells();
            /* Stay on the same card by ID; fall back to index 0 */
            var targetId = host.__ingestCurrentId;
            var idx = 0;
            if (targetId) {
              var found = shells.findIndex(function (s) {
                return s.getAttribute('data-card-id') === targetId;
              });
              if (found >= 0) idx = found;
            }
            goToIndex(idx);
          }

          prevBtn.addEventListener('click', function () { goToIndex((host.__ingestCurrentIndex || 0) - 1); });
          nextBtn.addEventListener('click', function () { goToIndex((host.__ingestCurrentIndex || 0) + 1); });

          host.__ingestGoTo = goToIndex;
          host.__ingestRefreshNav = refreshNav;

          return { mountEl: host, listEl: listEl || host };
        }
      });
    }

    function buildCard(model, phase) {
      var card = document.createElement('div');
      card.className = phase === 'done' ? 'lc-ingest-done-card' : 'lc-ingest-active-card';
      card.setAttribute('data-card-id', model.id);
      var errorEl = document.createElement('div');
      errorEl.className = 'alert alert-danger small mb-0 mx-2 mt-2 d-none';
      var chatHost = document.createElement('div');
      chatHost.className = 'lc-ingest-chat-host';
      card.appendChild(errorEl);
      card.appendChild(chatHost);
      return { root: card, errorEl: errorEl, chatHost: chatHost, _model: model };
    }

    _LC.registerCardRenderer('ingest', {
      styles: '',

      createShell: function (model) {
        var wrap = document.createElement('div');
        wrap.className = 'lc-ingest-shell-wrap';
        wrap.setAttribute('data-card-id', model.id);
        wrap.__ingestState = { phase: null, parts: null, chatPane: null };
        return wrap;
      },

      renderBody: function (model, shell, context) {
        var meta = model && model.card && model.card.meta ? model.card.meta : {};
        var stateField = meta.ingestStateField || meta.ingest_state_field || 'X';
        var phase = String(model && model.card_data && model.card_data[stateField] || 'active').toLowerCase();
        var st = shell.__ingestState;
        var host = findHost(shell);

        if (phase !== st.phase) {
          disposePane(st.chatPane); st.chatPane = null;
          shell.innerHTML = '';

          st.parts = buildCard(model, phase);
          shell.appendChild(st.parts.root);
          st.chatPane = context.mountChatPane({
            container: st.parts.chatHost,
            placeholder: meta.chatPlaceholder || 'Request another file or continue the ingest review...',
            fileAttach: true
          });
          st.phase = phase;

          /* Refresh nav after any phase change or new card arrival */
          if (host && host.__ingestRefreshNav) {
            queueMicrotask(function () { host.__ingestRefreshNav(); });
          }
        }

        /* Keep model reference fresh for nav display */
        if (st.parts) st.parts._model = model;

        /* Update error banner on every render */
        if (st.parts && st.parts.errorEl) {
          var hasError = model && model.card_data && model.card_data.status === 'error' && model.card_data.error;
          if (hasError) {
            st.parts.errorEl.textContent = model.card_data.error;
            st.parts.errorEl.classList.remove('d-none');
          } else {
            st.parts.errorEl.classList.add('d-none');
          }
        }
      }
    });
  })();

  function mountIngestBoard(options) {
    var mountOptions = options || {};
    var boardHost = window.BoardLivecardsStatefulHost;
    if (!boardHost || typeof boardHost.mount !== 'function') {
      throw new Error('BoardLivecardsStatefulHost.mount is required before ingest-board-package.js');
    }

    return boardHost.mount({
      rootElement: mountOptions.rootElement,
      runtimeProperty: '__ingestBoardRuntime',
      state: mountOptions.state,
      boardId: mountOptions.boardId,
      mode: mountOptions.mode || 'board',
      canvas: mountOptions.canvas || { height: '100%', overflow: 'auto' },
      boardPaths: mountOptions.boardPaths,
      getServerOrigin: mountOptions.getServerOrigin,
      getNodeIds: function (state) {
        return sortBoardCardIds(state);
      },
      selectNode: function (state, cardId) {
        return state.modelsById[cardId];
      },
      boardTheme: mountOptions.boardTheme || 'ingest',
      boardRenderer: mountOptions.boardRenderer || 'ingest',
      onPatchState: mountOptions.onPatchState,
      onRefresh: mountOptions.onRefresh,
      onAction: mountOptions.onAction,
      startReceivingChats: mountOptions.startReceivingChats,
      stopReceivingChats: mountOptions.stopReceivingChats,
    });
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

  window.IngestBoardPackage = window.IngestBoardPackage || {};
  window.IngestBoardPackage.mount = mountIngestBoard;
  window.IngestBoard = window.IngestBoardPackage;
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