(function () {
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

  function getCardMeta(model) {
    return model && model.card && model.card.meta ? model.card.meta : {};
  }

  function resolveSelectionValue(options, rootElement, optionKeys, datasetKeys) {
    var index;
    for (index = 0; index < optionKeys.length; index += 1) {
      var optionKey = optionKeys[index];
      if (options && typeof options[optionKey] === 'string' && options[optionKey]) {
        return options[optionKey];
      }
    }
    if (rootElement && rootElement.dataset) {
      for (index = 0; index < datasetKeys.length; index += 1) {
        var datasetKey = datasetKeys[index];
        if (rootElement.dataset[datasetKey]) {
          return rootElement.dataset[datasetKey];
        }
      }
    }
    return '';
  }

  function resolveNamespaceFilter(options, rootElement) {
    return resolveSelectionValue(
      options,
      rootElement,
      ['namespace', 'subBoard', 'boardNamespace', 'layer'],
      ['namespace', 'subBoard', 'boardNamespace', 'layer']
    );
  }

  function resolveCardRendererFilter(options, rootElement) {
    return resolveSelectionValue(
      options,
      rootElement,
      ['cardRenderer', 'renderer'],
      ['cardRenderer', 'renderer']
    );
  }

  function applyCardRendererOverride(model, rendererName) {
    if (!model || !rendererName) {
      return model;
    }

    var nextModel = Object.assign({}, model);
    var nextCard = Object.assign({}, model.card || {});
    var nextMeta = Object.assign({}, nextCard.meta || {});
    nextMeta.cardRenderer = rendererName;
    nextCard.meta = nextMeta;
    nextModel.card = nextCard;
    return nextModel;
  }

  function matchesNamespace(model, namespace) {
    if (!namespace) return true;
    var target = String(namespace).toLowerCase();
    var meta = getCardMeta(model);
    if (target === 'gandalf' && meta._gandalfCard === true) {
      return true;
    }

    var candidates = [
      meta.boardNamespace,
      meta.board_namespace,
      meta.subBoard,
      meta.sub_board,
      meta.namespace,
      meta.layer
    ];

    return candidates.some(function (value) {
      return typeof value === 'string' && value.toLowerCase() === target;
    });
  }

  function matchesCardSelection(model, options, rootElement) {
    if (!model) return false;
    if (!matchesNamespace(model, resolveNamespaceFilter(options, rootElement))) {
      return false;
    }
    if (options && typeof options.cardFilter === 'function') {
      return options.cardFilter(model) !== false;
    }
    return true;
  }

  // ── Ingest card renderer ──────────────────────────────────────────────────
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
          '.lc-ingest-board { position:relative; display:flex; justify-content:flex-start; align-items:stretch; width:100%; height:100%; min-height:100%; overflow:visible; }',
          '.lc-ingest-board-host { position:relative; width:100%; height:100%; min-height:100%; display:flex; align-items:flex-start; justify-content:flex-start; padding:0; overflow:visible; }',
          '.lc-ingest-board-rail { width:min(100%, 28rem); max-width:100%; height:100%; max-height:none; display:flex; flex-direction:column; gap:1rem; padding:1rem; box-sizing:border-box; overflow:hidden; background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(248,250,252,.94)); border:1px solid rgba(15,23,42,.08); border-radius:1.25rem; box-shadow:0 20px 50px rgba(15,23,42,.12); backdrop-filter:blur(10px); transform:translateX(0); opacity:1; transition:transform .24s cubic-bezier(.22,1,.36,1), opacity .24s cubic-bezier(.22,1,.36,1); will-change:transform, opacity; }',
          '.lc-ingest-board-host.lc-ingest-collapsed .lc-ingest-board-rail { transform:translateX(calc(-100% - 1rem)); opacity:0; pointer-events:none; }',
          '.lc-ingest-board-toggle { position:absolute; top:1rem; left:calc(min(100%, 28rem) + 1rem); z-index:5; width:2rem; height:2rem; border:1px solid rgba(15,23,42,.12); border-radius:999px; background:rgba(255,255,255,.96); color:#334155; box-shadow:0 8px 20px rgba(15,23,42,.12); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; transition:left .24s cubic-bezier(.22,1,.36,1), transform .24s cubic-bezier(.22,1,.36,1), box-shadow .24s cubic-bezier(.22,1,.36,1); }',
          '.lc-ingest-board-toggle:hover { transform:translateY(-1px); box-shadow:0 12px 24px rgba(15,23,42,.16); }',
          '.lc-ingest-board-toggle:focus-visible { outline:2px solid #2563eb; outline-offset:2px; }',
          '.lc-ingest-board-host.lc-ingest-collapsed .lc-ingest-board-toggle { left:0.5rem; }',
          '.lc-ingest-board-toggle-icon { font-size:0.95rem; line-height:1; }',
          '.lc-ingest-board-list { display:flex; flex-direction:column; gap:1rem; width:100%; margin:0; }',
          '.lc-ingest-board-list > [class*="col-"] { width:100%; max-width:none; flex:0 0 100%; }'
        ].join('')
      });
    }

    if (typeof _LC.registerBoardRenderer === 'function') {
      _LC.registerBoardRenderer('ingest', {
        createBoardHost: function (context) {
          var host = document.createElement('div');
          host.className = 'lc-ingest-board-host';
          var container = context && context.containerEl ? context.containerEl : null;
          if (container && container.classList) {
            container.classList.remove('lc-ingest-host-collapsed');
          }

          var toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'lc-ingest-board-toggle';
          toggle.setAttribute('aria-label', 'Hide ingest panel');
          toggle.setAttribute('aria-pressed', 'false');

          var toggleIcon = document.createElement('span');
          toggleIcon.className = 'lc-ingest-board-toggle-icon';
          toggleIcon.textContent = '<';
          toggle.appendChild(toggleIcon);

          var rail = document.createElement('div');
          rail.className = 'lc-ingest-board-rail';

          var listEl = context && context.defaultListEl ? context.defaultListEl : null;
          if (listEl) {
            rail.appendChild(listEl);
          }
          toggle.addEventListener('click', function () {
            var collapsed = host.classList.toggle('lc-ingest-collapsed');
            if (container && container.classList) {
              container.classList.toggle('lc-ingest-host-collapsed', collapsed);
            }
            toggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
            toggle.setAttribute('aria-label', collapsed ? 'Show ingest panel' : 'Hide ingest panel');
            toggleIcon.textContent = collapsed ? '>' : '<';
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

  // ── Board bootstrap ───────────────────────────────────────────────────────
  var clientApi = window.BoardLiveCardsClient || {};
  var applyNotification = clientApi.applyNotification;
  var buildBoardState = clientApi.buildBoardState;
  var defaultBoardPaths = clientApi.defaultBoardPaths;
  var selectLiveCardModel = clientApi.selectLiveCardModel;

  function resolveBoardId(options, rootElement) {
    if (options && typeof options.boardId === 'string' && options.boardId) {
      return options.boardId;
    }
    if (rootElement && rootElement.dataset && rootElement.dataset.boardId) {
      return rootElement.dataset.boardId;
    }
    var params = new URLSearchParams(window.location.search || '');
    return params.get('boardId') || 'ingest1';
  }

  function resolveServerConfigPath(options, rootElement) {
    if (options && typeof options.serverConfigPath === 'string' && options.serverConfigPath) {
      return options.serverConfigPath;
    }
    if (rootElement && rootElement.dataset && rootElement.dataset.serverConfig) {
      return rootElement.dataset.serverConfig;
    }
    return '../demo-board/server-config.json';
  }

  function mountIngestBoard(options) {
    var mountOptions = options || {};
    var rootElement = mountOptions.rootElement;
    if (!rootElement) {
      throw new Error('mountIngestBoard requires rootElement');
    }
    if (typeof applyNotification !== 'function' || typeof buildBoardState !== 'function' || typeof selectLiveCardModel !== 'function') {
      rootElement.textContent = 'board-livecards-client helpers are not available.';
      throw new Error('BoardLiveCardsClient helpers not loaded');
    }
    if (typeof defaultBoardPaths !== 'function') {
      rootElement.textContent = 'defaultBoardPaths is not available.';
      throw new Error('BoardLiveCardsClient.defaultBoardPaths not loaded');
    }

    if (rootElement.__ingestBoardRuntime && typeof rootElement.__ingestBoardRuntime.dispose === 'function') {
      rootElement.__ingestBoardRuntime.dispose();
    }

    var serverConfigPath = resolveServerConfigPath(mountOptions, rootElement);
    var activeBoardId = resolveBoardId(mountOptions, rootElement);
    var serverConfig = null;
    var activeServerOrigin = null;
    var activeEventSource = null;
    var activeBoardView = null;
    var activeState = null;
    var activeMode = mountOptions.mode || 'board';
    var chatSubscriptions = {};
    var chatClientId = window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : 'ingest-' + Date.now() + '-' + Math.random().toString(36).slice(2);

    rootElement.innerHTML = mountOptions.loadingText || ('Loading ' + activeBoardId + ' board...');

    async function loadServerConfig() {
      if (serverConfig) return serverConfig;
      var response = await fetch(serverConfigPath);
      if (!response.ok) {
        throw new Error('Failed to load ' + serverConfigPath + ': HTTP ' + response.status);
      }
      serverConfig = await response.json();
      return serverConfig;
    }

    function candidateOrigins() {
      var values = [];
      function push(value) {
        if (!value || values.indexOf(value) !== -1) return;
        values.push(value);
      }

      var params = new URLSearchParams(window.location.search || '');
      var configPort = serverConfig && serverConfig.port ? Number(serverConfig.port) : 7799;
      var hostPref = window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
      var hostAlt = hostPref === 'localhost' ? '127.0.0.1' : 'localhost';

      push(params.get('serverOrigin'));
      push('http://' + hostPref + ':' + configPort);
      push('http://' + hostAlt + ':' + configPort);
      push('http://127.0.0.1:8080');
      push('http://localhost:8080');
      return values;
    }

    function boardPaths(currentBoardId) {
      return defaultBoardPaths(currentBoardId || activeBoardId || 'default');
    }

    async function fetchServer(path, init) {
      var origins = activeServerOrigin ? [activeServerOrigin] : candidateOrigins();
      var lastError = null;
      for (var i = 0; i < origins.length; i += 1) {
        var origin = origins[i];
        try {
          var response = await fetch(origin + path, init);
          if (!response.ok) {
            lastError = new Error('HTTP ' + response.status + ' from ' + origin + path);
            continue;
          }
          activeServerOrigin = origin;
          return response;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('Unable to reach backend server');
    }

    function getPayload() {
      return activeState ? activeState.payload : null;
    }

    function pushState(nextState) {
      activeState = nextState;
      if (activeBoardView) {
        activeBoardView.setState(function () { return nextState; });
      }
    }

    function notifyBoardEngine() {
      var engine = activeBoardView && activeBoardView.engine;
      if (engine && typeof engine.onServerSseEvent === 'function') {
        engine.onServerSseEvent();
      } else if (engine && typeof engine.refreshOpenChatModal === 'function') {
        engine.refreshOpenChatModal();
      }
    }

    function updateCardChats(cardId, messages, receiving) {
      if (!activeState) return;
      pushState(applyNotification(activeState, [{
        kind: 'card_chats',
        cardId: cardId,
        messages: Array.isArray(messages) ? messages : [],
        receiving: !!receiving
      }], selectLiveCardModel, getPayload));
      notifyBoardEngine();
    }

    async function subscribeCardChats(paths, cardId) {
      chatSubscriptions[cardId] = true;
      updateCardChats(cardId, activeState && activeState.modelsById && activeState.modelsById[cardId] && activeState.modelsById[cardId].card_chats && activeState.modelsById[cardId].card_chats.messages, true);
      try {
        await fetchServer(paths.chatSubscribeSse(cardId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: chatClientId })
        });
      } catch (_error) {}
    }

    async function unsubscribeCardChats(paths, cardId) {
      delete chatSubscriptions[cardId];
      try {
        await fetchServer(paths.chatUnsubscribeSse(cardId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: chatClientId })
        });
      } catch (_error) {}
      updateCardChats(cardId, activeState && activeState.modelsById && activeState.modelsById[cardId] && activeState.modelsById[cardId].card_chats && activeState.modelsById[cardId].card_chats.messages, false);
    }

    function resubscribeAll(paths) {
      Object.keys(chatSubscriptions).forEach(function (cardId) {
        fetchServer(paths.chatSubscribeSse(cardId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: chatClientId })
        }).catch(function () {});
      });
    }

    async function uploadFile(paths, cardId, file, uploadOptions) {
      if (!file) return null;
      var inChat = uploadOptions && uploadOptions.inChat === true;
      var fileName = typeof file.name === 'string' ? file.name : 'upload.bin';
      var fileType = file.type || 'application/octet-stream';
      var url = inChat ? paths.cardFile(cardId) + '?inChat=true' : paths.cardFile(cardId);
      var response = await fetchServer(url, {
        method: 'POST',
        headers: {
          'content-type': fileType,
          'x-file-name': encodeURIComponent(fileName)
        },
        body: file
      });
      var json = await response.json();
      return json && json.file ? json.file : null;
    }

    async function resolveActionPayload(paths, cardId, actionType, payload) {
      if (actionType !== 'chat-send' && actionType !== 'file-upload') return payload || {};
      var nextPayload = Object.assign({}, payload || {});
      var files = Array.isArray(nextPayload.files) ? nextPayload.files : [];
      if (!files.length) {
        nextPayload.files = [];
        return nextPayload;
      }
      var uploadedFiles = [];
      for (var index = 0; index < files.length; index += 1) {
        var uploaded = await uploadFile(paths, cardId, files[index], { inChat: actionType === 'chat-send' });
        if (uploaded) uploadedFiles.push(uploaded);
      }
      nextPayload.files = actionType === 'chat-send' ? [] : uploadedFiles;
      return nextPayload;
    }

    function dispose() {
      if (activeEventSource) {
        activeEventSource.close();
        activeEventSource = null;
      }
      Object.keys(chatSubscriptions).forEach(function (cardId) {
        delete chatSubscriptions[cardId];
      });
      activeBoardView = null;
      activeState = null;
      if (rootElement.__ingestBoardRuntime === runtimeClient) {
        rootElement.__ingestBoardRuntime = null;
      }
    }

    async function bootstrap() {
      await loadServerConfig();

      var paths = boardPaths(activeBoardId);
      await fetchServer(paths.initBoard);
      if (!activeServerOrigin) {
        throw new Error('Server origin not resolved before SSE start');
      }

      var initialPayload = await new Promise(function (resolve, reject) {
        var streamUrl = activeServerOrigin + paths.stream
          + (paths.stream.indexOf('?') >= 0 ? '&' : '?')
          + 'clientId=' + encodeURIComponent(chatClientId);
        var source = new EventSource(streamUrl);
        activeEventSource = source;
        var settled = false;
        var timeout = setTimeout(function () {
          if (!settled) reject(new Error('SSE initial payload timeout (15s)'));
        }, 15000);

        source.onmessage = function (event) {
          try {
            var data = JSON.parse(event.data || '{}');
            if (!settled && data && (data.cardDefinitions || Array.isArray(data))) {
              settled = true;
              clearTimeout(timeout);
              resolve(data);
            }
          } catch (_error) {}
        };

        source.onerror = function () {
          if (!settled) {
            clearTimeout(timeout);
            reject(new Error('SSE connection failed during bootstrap'));
          }
        };
      });

      activeState = buildBoardState(initialPayload, null, selectLiveCardModel);

      var LiveCard = window.LiveCard;
      if (!LiveCard) {
        throw new Error('LiveCard global not loaded');
      }

      var engine = LiveCard.init({
        resolve: function (cardId) {
          return activeState && activeState.modelsById ? activeState.modelsById[cardId] : null;
        },
        chartLib: window.Chart || null,
        markdown: window.marked ? function (value) { return window.marked.parse(value); } : null,
        sanitize: window.DOMPurify ? function (value) { return window.DOMPurify.sanitize(value); } : null,
        onPatchState: async function (cardId, patch) {
          await fetchServer(paths.patchCard(cardId), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch || {})
          });
        },
        onRefresh: async function (cardId) {
          await fetchServer(paths.patchCard(cardId), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
          });
        },
        onAction: async function (cardId, actionType, payload) {
          var actionPayload = await resolveActionPayload(paths, cardId, actionType, payload);
          await fetchServer(paths.cardAction(cardId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actionType: actionType, payload: actionPayload || {} })
          });
        },
        startReceivingChats: function (cardId) {
          return subscribeCardChats(paths, cardId);
        },
        stopReceivingChats: function (cardId) {
          return unsubscribeCardChats(paths, cardId);
        }
      });

      rootElement.innerHTML = '';
      activeBoardView = LiveCard.Board(engine, rootElement, {
        initialState: activeState,
        getNodeIds: function (state) {
          return sortBoardCardIds(state).filter(function (cardId) {
            return matchesCardSelection(state && state.modelsById ? state.modelsById[cardId] : null, mountOptions, rootElement);
          });
        },
        selectNode: function (state, cardId) {
          var model = state.modelsById[cardId];
          return applyCardRendererOverride(model, resolveCardRendererFilter(mountOptions, rootElement));
        },
        mode: activeMode,
        canvas: mountOptions.canvas || { height: '100%', overflow: 'auto' },
        boardTheme: mountOptions.boardTheme || 'ingest',
        boardRenderer: mountOptions.boardRenderer || 'ingest'
      });

      activeEventSource.onopen = function () {
        resubscribeAll(paths);
      };

      activeEventSource.onmessage = function (event) {
        try {
          var data = JSON.parse(event.data || '{}');
          if (data && data.kind === 'notification-batch' && Array.isArray(data.notifications)) {
            pushState(applyNotification(activeState, data.notifications, selectLiveCardModel, getPayload));
          } else if (data && data.cardDefinitions) {
            pushState(buildBoardState(data, activeState, selectLiveCardModel));
          }
          notifyBoardEngine();
        } catch (error) {
          console.warn('Bad SSE payload', error);
        }
      };
    }

    var runtimeClient = {
      boardId: activeBoardId,
      rootElement: rootElement,
      dispose: dispose
    };
    rootElement.__ingestBoardRuntime = runtimeClient;

    var startPromise = bootstrap().catch(function (error) {
      dispose();
      console.error(error);
      rootElement.innerHTML = '<pre style="white-space:pre-wrap">Failed to load ingest board: '
        + String(error && error.message || error) + '</pre>';
      throw error;
    });

    runtimeClient.ready = startPromise.then(function () { return runtimeClient; });
    return runtimeClient;
  }

  function autoMountIngestBoards() {
    var roots = document.querySelectorAll('[data-ingest-board-root]');
    Array.prototype.forEach.call(roots, function (rootElement) {
      if (rootElement.dataset.ingestMounted === 'true') {
        return;
      }
      rootElement.dataset.ingestMounted = 'true';
      mountIngestBoard({
        rootElement: rootElement,
        boardId: rootElement.dataset.boardId || '',
        serverConfigPath: rootElement.dataset.serverConfig || '',
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