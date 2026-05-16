(function () {
  // Standalone host API for board-livecards.
  //
  // This module mounts a board-livecards runtime into a caller-provided DOM node.
  // It does not own the page shell, header, or surrounding layout. A host page can
  // mount one or many board views by providing different root elements.
  //
  // Public host surface:
  // - BoardLivecardsHost.create({ rootElement, fetchServer, boardPaths, getServerOrigin, ... })
  // - BoardLivecardsHost.init({ ...createOptions, initialBoardId? })
  //
  // `MainBoard` is kept as a compatibility alias for the existing page wiring.
  function requireClient() {
    var client = window.BoardLiveCardsClient;
    if (!client || typeof client.createBoardRuntimeSession !== "function" ||
        typeof client.createDerivedBoardRuntime !== "function") {
      throw new Error("BoardLiveCardsClient runtime APIs are required");
    }
    return client;
  }

  function create(options) {
    var opts = options || {};
    var rootElement = opts.rootElement;
    var fetchServer = opts.fetchServer;
    var boardPaths = opts.boardPaths;
    var getServerOrigin = opts.getServerOrigin;

    if (!rootElement) {
      throw new Error("BoardLivecardsHost.create requires options.rootElement");
    }

    if (typeof fetchServer !== "function") {
      throw new Error("BoardLivecardsHost.create requires options.fetchServer");
    }

    if (typeof boardPaths !== "function") {
      throw new Error("BoardLivecardsHost.create requires options.boardPaths");
    }

    if (typeof getServerOrigin !== "function") {
      throw new Error("BoardLivecardsHost.create requires options.getServerOrigin");
    }

    var client = requireClient();

    if (!client) {
      rootElement.innerHTML =
        '<div class="alert alert-danger">board-livecards-client.js not loaded.</div>';
      throw new Error("BoardLiveCardsClient not loaded");
    }

    var state = {
      runtimeSessions: new Map(),
      mountedRuntime: null,
      boardId: "",
      mode: String(opts.initialMode || "board"),
      devMode: !!opts.devMode,
      canvas: opts.canvas || { height: "calc(100vh - 56px)", overflow: "auto" },
    };

    function disposeMountedRuntime() {
      if (state.mountedRuntime && typeof state.mountedRuntime.dispose === "function") {
        state.mountedRuntime.dispose();
      }
      state.mountedRuntime = null;
    }

    function disposeRuntimeSession(session) {
      if (session && typeof session.dispose === "function") {
        session.dispose();
      }
    }

    function createRuntimeSession(boardId) {
      return client.createBoardRuntimeSession({
        fetchServer: fetchServer,
        boardPaths: function (id) {
          return boardPaths(id || boardId || state.boardId);
        },
        getServerOrigin: getServerOrigin,
      });
    }

    async function ensureRuntimeSession(boardId, options) {
      var opts = options || {};
      var bid = String(boardId || "").trim();
      if (!bid) {
        throw new Error("boardId is required");
      }

      var runtimeSession = state.runtimeSessions.get(bid) || null;
      if (!runtimeSession) {
        runtimeSession = createRuntimeSession(bid);
        state.runtimeSessions.set(bid, runtimeSession);
      }

      if (!runtimeSession.getState() && opts.state) {
        runtimeSession.attachProvidedState({ boardId: bid, state: opts.state });
      }

      if (!runtimeSession.isConnected()) {
        await runtimeSession.bootstrap({
          boardId: bid,
          skipInitBoard: !!opts.state && opts.skipInitBoard !== false,
        });
      }

      return runtimeSession;
    }

    function activateRuntime(runtime) {
      disposeMountedRuntime();
      state.mountedRuntime = runtime;

      if (state.devMode && runtime && typeof runtime.setDevMode === "function") {
        runtime.setDevMode(true);
      }
    }

    function showLoading(label) {
      rootElement.innerHTML =
        '<div class="d-flex align-items-center justify-content-center" style="height:90vh">' +
        '<div class="text-center"><div class="spinner-border mb-3" role="status">' +
        '<span class="visually-hidden">Loading...</span></div>' +
        '<p class="text-muted">' +
        label +
        "</p></div></div>";
    }

    async function mountBoard(boardId) {
      var bid = String(boardId || "").trim();
      if (!bid) {
        throw new Error("BoardLivecardsHost.mountBoard requires boardId");
      }

      state.boardId = bid;
      showLoading("Loading board...");

      var runtimeSession = await ensureRuntimeSession(bid);
      var runtime = client.createDerivedBoardRuntime({
        session: runtimeSession,
        initialMode: state.mode,
        canvas: state.canvas,
      });

      runtime.mountBoard({
        rootElement: rootElement,
        mode: state.mode,
      });

      activateRuntime(runtime);

      if (typeof opts.onBoardMounted === "function") {
        opts.onBoardMounted({ boardId: bid, runtimeSession: runtimeSession, runtime: runtime });
      }
    }

    async function mountState(boardState, boardId) {
      if (!boardState || !Array.isArray(boardState.cardIds) || !boardState.modelsById) {
        throw new Error("BoardLivecardsHost.mountState requires board state with cardIds and modelsById");
      }

      var bid = String(boardId || boardState.boardId || "").trim();
      if (!bid) {
        throw new Error("BoardLivecardsHost.mountState requires boardId");
      }

      state.boardId = bid;
      var runtimeSession = await ensureRuntimeSession(bid, { state: boardState, skipInitBoard: false });
      var allowedIds = new Set((boardState.cardIds || []).map(function (cardId) {
        return String(cardId);
      }));
      var runtime = client.createDerivedBoardRuntime({
        session: runtimeSession,
        initialMode: state.mode,
        canvas: state.canvas,
        includeCard: function (model) {
          return !!model && allowedIds.has(String(model.id));
        },
      });

      runtime.mountBoard({
        rootElement: rootElement,
        mode: state.mode,
      });

      activateRuntime(runtime);
    }

    function setMode(mode) {
      state.mode = String(mode || "board");
      if (state.mountedRuntime && typeof state.mountedRuntime.setMode === "function") {
        state.mountedRuntime.setMode(state.mode);
      }
    }

    function autoLayout() {
      if (state.mountedRuntime && typeof state.mountedRuntime.autoLayout === "function") {
        state.mountedRuntime.autoLayout();
      }
    }

    function setDevMode(enabled) {
      state.devMode = !!enabled;
      if (state.mountedRuntime && typeof state.mountedRuntime.setDevMode === "function") {
        state.mountedRuntime.setDevMode(state.devMode);
      }
    }

    function dispose() {
      disposeMountedRuntime();
      state.runtimeSessions.forEach(function (session) {
        disposeRuntimeSession(session);
      });
      state.runtimeSessions.clear();
    }

    return {
      mountBoard: mountBoard,
      mountState: mountState,
      setMode: setMode,
      autoLayout: autoLayout,
      setDevMode: setDevMode,
      dispose: dispose,
      ensureRuntimeSession: ensureRuntimeSession,
      getRuntimeSession: function (boardId) {
        var bid = String(boardId || state.boardId || "").trim();
        return bid ? (state.runtimeSessions.get(bid) || null) : null;
      },
      getActiveBoardId: function () {
        return state.boardId;
      },
      getCurrentMode: function () {
        return state.mode;
      },
    };
  }

  async function init(options) {
    var controller = create(options || {});
    if (options && options.initialBoardId) {
      await controller.mountBoard(options.initialBoardId);
    }
    return controller;
  }

  window.BoardLivecardsHost = window.BoardLivecardsHost || {};
  window.BoardLivecardsHost.create = create;
  window.BoardLivecardsHost.init = init;
  window.MainBoard = window.BoardLivecardsHost;
})();