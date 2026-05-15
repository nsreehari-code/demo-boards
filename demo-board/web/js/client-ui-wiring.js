(function () {
  function disposeRuntime(runtime) {
    if (runtime && typeof runtime.dispose === "function") {
      runtime.dispose();
    }
  }

  function toBoardState(boardId, payload) {
    var cardDefs = Array.isArray(payload.cardDefinitions) ? payload.cardDefinitions : [];
    var runtimeById = payload.cardRuntimeById && typeof payload.cardRuntimeById === "object"
      ? payload.cardRuntimeById
      : {};
    var chatsByCardId = payload.cardChatsByCardId && typeof payload.cardChatsByCardId === "object"
      ? payload.cardChatsByCardId
      : {};

    var statusByName = {};
    var statusCards = payload.statusSnapshot && payload.statusSnapshot.cards;
    if (statusCards && typeof statusCards === "object") {
      Object.keys(statusCards).forEach(function (key) {
        var item = statusCards[key];
        if (item && typeof item.name === "string") {
          statusByName[item.name] = item;
        }
      });
    }

    var modelsById = {};
    var cardIds = [];

    cardDefs.forEach(function (def) {
      if (!def || !def.id) {
        return;
      }
      var cardId = String(def.id);
      var runtime = runtimeById[cardId] || {};
      var defaultCardData = def.card_data && typeof def.card_data === "object" ? def.card_data : {};
      var runtimeCardData = runtime.card_data && typeof runtime.card_data === "object" ? runtime.card_data : {};
      modelsById[cardId] = {
        id: cardId,
        card: def,
        card_data: {
          ...defaultCardData,
          ...runtimeCardData,
        },
        computed_values: runtime.computed_values && typeof runtime.computed_values === "object" ? runtime.computed_values : {},
        runtime_state: statusByName[cardId] || {},
        card_chats: chatsByCardId[cardId] && typeof chatsByCardId[cardId] === "object"
          ? chatsByCardId[cardId]
          : { messages: [], receiving: false },
      };
      cardIds.push(cardId);
    });

    return { boardId: boardId, cardIds: cardIds, modelsById: modelsById };
  }

  function pickBoardState(sourceState, selectedIds) {
    var ids = Array.isArray(selectedIds) ? selectedIds : [];
    var idSet = new Set(ids.map(function (id) { return String(id); }));
    var nextIds = sourceState.cardIds.filter(function (id) {
      return idSet.has(String(id));
    });

    var nextModelsById = {};
    nextIds.forEach(function (id) {
      nextModelsById[id] = sourceState.modelsById[id];
    });

    return {
      boardId: sourceState.boardId,
      cardIds: nextIds,
      modelsById: nextModelsById,
    };
  }

  function subtractBoardState(sourceState, excludedIdsSet) {
    var nextIds = sourceState.cardIds.filter(function (id) {
      return !excludedIdsSet.has(String(id));
    });

    var nextModelsById = {};
    nextIds.forEach(function (id) {
      nextModelsById[id] = sourceState.modelsById[id];
    });

    return {
      boardId: sourceState.boardId,
      cardIds: nextIds,
      modelsById: nextModelsById,
    };
  }

  async function derivePluginState(plugin, sourceState, context) {
    if (typeof plugin.filter === "function") {
      var selectedIds = sourceState.cardIds.filter(function (cardId) {
        var model = sourceState.modelsById[cardId];
        return !!plugin.filter(model, {
          activeBoardId: context.activeBoardId,
          sourceBoardId: context.sourceBoardId,
          plugin: plugin,
          sourceState: sourceState,
        });
      });
      return {
        state: pickBoardState(sourceState, selectedIds),
        selectedIds: selectedIds,
      };
    }

    if (typeof plugin.deriveState !== "function") {
      throw new Error("Plugin \"" + String(plugin.name || "plugin") + "\" must provide deriveState() or filter()");
    }

    return {
      state: await plugin.deriveState({
        activeBoardId: context.activeBoardId,
        sourceBoardId: context.sourceBoardId,
        serverConfig: context.serverConfig,
        mainBoard: context.mainBoard,
        mainBoardState: context.mainBoardState,
        plugin: plugin,
        fetchServer: context.fetchServer,
        boardPaths: context.boardPaths,
        loadBoardState: context.loadBoardState,
        sourceState: sourceState,
      }),
      selectedIds: [],
    };
  }

  async function init(MainBoardModule, pluginSpecs, options) {
    var opts = options || {};
    var plugins = Array.isArray(pluginSpecs) ? pluginSpecs : [];
    var BoardRuntimeShared = window.BoardRuntimeShared || {};

    if (!MainBoardModule || typeof MainBoardModule.init !== "function") {
      throw new Error("ClientUiWiring.init requires MainBoard module");
    }

    if (!window.BoardLiveCardsClient || typeof window.BoardLiveCardsClient.defaultBoardPaths !== "function") {
      throw new Error("BoardLiveCardsClient.defaultBoardPaths is required");
    }

    if (!opts.serverConfigPath) {
      throw new Error("ClientUiWiring.init requires options.serverConfigPath");
    }

    if (!opts.mounts || !opts.mounts.mainBoard) {
      throw new Error("ClientUiWiring.init requires options.mounts.mainBoard");
    }
    var mainBoardMount = opts.mounts.mainBoard;

    var state = {
      serverConfig: null,
      activeServerOrigin: null,
      activeBoardId: String(opts.initialBoardId || "").trim(),
      currentMode: localStorage.getItem("demo-board-mode") || "board",
      devMode: localStorage.getItem("demo-board-devmode") === "true",
      boards: [],
      boardById: new Map(),
      mainBoard: null,
      pluginRuntimes: new Map(),
      disposed: false,
      listeners: {
        boardChanged: [],
      },
    };

    function resolveApiOrigin() {
      var port = (state.serverConfig && state.serverConfig.port) || 7799;
      var host = window.location.hostname === "localhost" ? "localhost" : "127.0.0.1";
      return "http://" + host + ":" + port;
    }

    function boardPaths(boardId) {
      return window.BoardLiveCardsClient.defaultBoardPaths(boardId || state.activeBoardId);
    }

    async function fetchServer(path, initReq) {
      if (!state.activeServerOrigin) {
        state.activeServerOrigin = resolveApiOrigin();
      }
      return fetch(state.activeServerOrigin + path, initReq);
    }

    async function loadServerConfig() {
      var res = await fetch(String(opts.serverConfigPath));
      if (!res.ok) {
        throw new Error("Failed to fetch " + opts.serverConfigPath + ": " + res.status);
      }
      state.serverConfig = await res.json();
    }

    async function loadBoardsFromServer() {
      var listRes = await fetchServer("/api/boards");
      if (!listRes.ok) {
        throw new Error("Failed to list boards (" + listRes.status + ")");
      }

      var listPayload = await listRes.json();
      var boards = Array.isArray(listPayload && listPayload.boards) ? listPayload.boards : [];
      if (!boards.length) {
        throw new Error("Server returned no boards from /api/boards");
      }

      state.boards = boards.map(function (board) {
        return { id: String(board.id), label: board.label || String(board.id) };
      });
      state.boardById = new Map(state.boards.map(function (board) { return [board.id, board]; }));
    }

    function ensureActiveBoardId() {
      if (!state.activeBoardId) {
        state.activeBoardId = state.boards[0].id;
      }

      if (!state.boardById.has(state.activeBoardId)) {
        throw new Error("Unknown board id in URL: " + state.activeBoardId);
      }
    }

    function getBoards() {
      return state.boards.map(function (board) {
        return { id: board.id, label: board.label };
      });
    }

    function emitBoardChanged() {
      var board = state.boardById.get(state.activeBoardId) || null;
      var payload = {
        boardId: state.activeBoardId,
        board: board,
        boards: getBoards(),
      };
      state.listeners.boardChanged.forEach(function (listener) {
        listener(payload);
      });
    }

    async function loadBoardState(boardId) {
      var bid = String(boardId || state.activeBoardId || "").trim();
      if (!bid) {
        throw new Error("loadBoardState requires a boardId");
      }

      var initPath = boardPaths(bid).initBoard;
      var res = await fetchServer(initPath);
      if (!res.ok) {
        throw new Error("Failed to init board snapshot for " + bid + " (" + res.status + ")");
      }

      return toBoardState(bid, await res.json());
    }

    async function mountPlugin(plugin, mainBoardState, consumedMainIds) {
      var name = String(plugin.name || "plugin");
      var mountElement = plugin.mountElement;

      if (!mountElement) {
        return;
      }

      disposeRuntime(state.pluginRuntimes.get(name));
      state.pluginRuntimes.delete(name);

      var context = {
        activeBoardId: state.activeBoardId,
        serverConfig: state.serverConfig,
        mainBoard: state.mainBoard,
        mainBoardState: mainBoardState,
        plugin: plugin,
        fetchServer: fetchServer,
        boardPaths: boardPaths,
        loadBoardState: loadBoardState,
      };

      var shouldMount = typeof plugin.shouldMount === "function" ? !!plugin.shouldMount(context) : true;
      if (!shouldMount) {
        mountElement.style.display = "none";
        mountElement.innerHTML = "";
        return;
      }

      if (!plugin.BoardModule || typeof plugin.BoardModule.mount !== "function") {
        throw new Error("Plugin \"" + name + "\" must provide BoardModule.mount");
      }

      var sourceBoardId = plugin.sourceBoardId ? String(plugin.sourceBoardId) : state.activeBoardId;
      var sourceState = sourceBoardId === state.activeBoardId
        ? mainBoardState
        : await loadBoardState(sourceBoardId);

      var pluginContext = {
        activeBoardId: state.activeBoardId,
        sourceBoardId: sourceBoardId,
        serverConfig: state.serverConfig,
        mainBoard: state.mainBoard,
        mainBoardState: mainBoardState,
        plugin: plugin,
        fetchServer: fetchServer,
        boardPaths: boardPaths,
        loadBoardState: loadBoardState,
      };
      var derived = await derivePluginState(plugin, sourceState, pluginContext);
      var derivedState = derived.state;

      if (sourceBoardId === state.activeBoardId && plugin.excludeFromMain !== false) {
        derived.selectedIds.forEach(function (id) {
          consumedMainIds.add(String(id));
        });
      }

      if (!derivedState || !Array.isArray(derivedState.cardIds) || !derivedState.modelsById) {
        throw new Error("Plugin \"" + name + "\" deriveState must return { cardIds, modelsById }");
      }

      mountElement.style.display = "block";
      var runtime = null;
      async function syncPluginRuntime() {
        if (!runtime || typeof runtime.setState !== 'function') {
          return;
        }
        var nextSourceState = await loadBoardState(sourceBoardId);
        var nextDerived = await derivePluginState(plugin, nextSourceState, pluginContext);
        runtime.setState(nextDerived.state);
      }

      runtime = plugin.BoardModule.mount({
        rootElement: mountElement,
        state: derivedState,
        boardId: sourceBoardId,
        mode: plugin.mode || "board",
        canvas: plugin.canvas || { height: "100%", overflow: "auto" },
        fetchServer: fetchServer,
        boardPaths: function (boardId) {
          return boardPaths(boardId || sourceBoardId);
        },
        getServerOrigin: function () {
          return state.activeServerOrigin;
        },
        onPatchState: async function (cardId, patch) {
          await BoardRuntimeShared.patchCardState({
            fetchServer: fetchServer,
            boardPaths: function (boardId) {
              return boardPaths(boardId || sourceBoardId);
            },
            boardId: sourceBoardId,
            cardId: cardId,
            patch: patch,
          });
          await syncPluginRuntime();
        },
        onRefresh: async function (cardId) {
          await BoardRuntimeShared.dispatchCardAction({
            fetchServer: fetchServer,
            boardPaths: function (boardId) {
              return boardPaths(boardId || sourceBoardId);
            },
            boardId: sourceBoardId,
            cardId: cardId,
            actionType: 'refresh',
            payload: {},
          });
          await syncPluginRuntime();
        },
        onAction: async function (cardId, actionType, payload) {
          await BoardRuntimeShared.dispatchCardAction({
            fetchServer: fetchServer,
            boardPaths: function (boardId) {
              return boardPaths(boardId || sourceBoardId);
            },
            boardId: sourceBoardId,
            cardId: cardId,
            actionType: actionType,
            payload: payload,
          });
          await syncPluginRuntime();
        },
        startReceivingChats: function () { return Promise.resolve(); },
        stopReceivingChats: function () { return Promise.resolve(); },
      });
      state.pluginRuntimes.set(name, runtime || null);
    }

    async function syncPlugins(mainBoardState, consumedMainIds) {
      for (var i = 0; i < plugins.length; i += 1) {
        await mountPlugin(plugins[i], mainBoardState, consumedMainIds);
      }
    }

    async function refreshBoardViews() {
      var baseState = await loadBoardState(state.activeBoardId);
      var consumedMainIds = new Set();

      await syncPlugins(baseState, consumedMainIds);

      var remainingState = subtractBoardState(baseState, consumedMainIds);
      if (typeof state.mainBoard.mountState === "function") {
        await state.mainBoard.mountState(remainingState, state.activeBoardId);
      } else {
        if (consumedMainIds.size > 0) {
          throw new Error("MainBoard module must support mountState for filtered optional boards");
        }
        await state.mainBoard.mountBoard(state.activeBoardId);
      }
    }

    async function switchBoard(boardId) {
      var nextId = String(boardId || "").trim();
      if (!nextId) {
        throw new Error("switchBoard requires boardId");
      }
      if (!state.boardById.has(nextId)) {
        throw new Error("Unknown board id: " + nextId);
      }

      state.activeBoardId = nextId;
      var url = new URL(window.location);
      url.searchParams.set("l", state.activeBoardId);
      history.replaceState(null, "", url);

      await refreshBoardViews();
      emitBoardChanged();
    }

    function setMode(mode) {
      state.currentMode = String(mode || "board");
      localStorage.setItem("demo-board-mode", state.currentMode);
      if (state.mainBoard) {
        state.mainBoard.setMode(state.currentMode);
      }
    }

    function setDevMode(enabled) {
      state.devMode = !!enabled;
      localStorage.setItem("demo-board-devmode", String(state.devMode));
      if (state.mainBoard) {
        state.mainBoard.setDevMode(state.devMode);
      }
    }

    function autoLayout() {
      if (state.mainBoard) {
        state.mainBoard.autoLayout();
      }
    }

    function onBoardChanged(listener) {
      if (typeof listener !== "function") {
        throw new Error("onBoardChanged requires a function");
      }
      state.listeners.boardChanged.push(listener);
      listener({
        boardId: state.activeBoardId,
        board: state.boardById.get(state.activeBoardId) || null,
        boards: getBoards(),
      });
      return function unsubscribe() {
        var idx = state.listeners.boardChanged.indexOf(listener);
        if (idx >= 0) {
          state.listeners.boardChanged.splice(idx, 1);
        }
      };
    }

    function dispose() {
      if (state.disposed) {
        return;
      }
      state.disposed = true;
      disposeRuntime(state.mainBoard);
      state.pluginRuntimes.forEach(function (runtime) {
        disposeRuntime(runtime);
      });
      state.pluginRuntimes.clear();
      state.listeners.boardChanged.length = 0;
    }

    await loadServerConfig();
    await loadBoardsFromServer();
    ensureActiveBoardId();

    state.mainBoard = await MainBoardModule.init({
      rootElement: mainBoardMount,
      fetchServer: fetchServer,
      boardPaths: boardPaths,
      getServerOrigin: function () {
        return state.activeServerOrigin;
      },
      initialMode: state.currentMode,
      devMode: state.devMode,
      canvas: { height: "calc(100vh - 56px)", overflow: "auto" },
    });

    await refreshBoardViews();
    emitBoardChanged();

    return {
      init: init,
      switchBoard: switchBoard,
      setMode: setMode,
      setDevMode: setDevMode,
      autoLayout: autoLayout,
      onBoardChanged: onBoardChanged,
      getActiveBoardId: function () {
        return state.activeBoardId;
      },
      getBoards: getBoards,
      getCurrentMode: function () {
        return state.currentMode;
      },
      getDevMode: function () {
        return state.devMode;
      },
      dispose: dispose,
    };
  }

  window.ClientUiWiring = window.ClientUiWiring || {};
  window.ClientUiWiring.init = init;
})();
