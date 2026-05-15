(function () {
  function createBoardViewRuntime(params) {
    var rootElement = params.rootElement;
    var boardState = params.boardState;
    var mode = params.mode;
    var canvas = params.canvas;
    var fetchServer = params.fetchServer;
    var boardPaths = params.boardPaths;
    var getServerOrigin = params.getServerOrigin;
    var BoardRuntimeShared = window.BoardRuntimeShared || {};

    var LiveCard = window.LiveCard;
    if (!LiveCard) {
      throw new Error("LiveCard global not loaded");
    }

    var currentState = boardState;

    function fileUrlBase() {
      if (typeof BoardRuntimeShared.buildFileUrlBase !== "function") {
        return null;
      }
      return BoardRuntimeShared.buildFileUrlBase({
        boardId: currentState && currentState.boardId,
        boardPaths: function () {
          return boardPaths();
        },
        getServerOrigin: getServerOrigin,
      });
    }

    function applySuccessfulAction(cardId, actionType, payload) {
      if (actionType !== "file-upload") {
        return;
      }

      var uploadedFiles = payload && Array.isArray(payload.files) ? payload.files.filter(Boolean) : [];
      if (!uploadedFiles.length) {
        return;
      }

      updateState(function (prev) {
        var model = prev && prev.modelsById ? prev.modelsById[cardId] : null;
        if (!model) {
          return prev;
        }

        var existingFiles = model.card_data && Array.isArray(model.card_data.files)
          ? model.card_data.files.filter(Boolean)
          : [];
        var seen = new Set(existingFiles.map(function (file) {
          return file && file.stored_name ? String(file.stored_name) : "";
        }));
        var mergedFiles = existingFiles.slice();

        uploadedFiles.forEach(function (file) {
          var key = file && file.stored_name ? String(file.stored_name) : "";
          if (key && !seen.has(key)) {
            seen.add(key);
            mergedFiles.push(file);
          }
        });

        var nextModel = {
          id: model.id,
          card: model.card,
          card_data: { ...(model.card_data || {}), files: mergedFiles },
          computed_values: model.computed_values || {},
          runtime_state: model.runtime_state || {},
          card_chats: model.card_chats || { messages: [], receiving: false },
        };

        return {
          boardId: prev.boardId,
          cardIds: prev.cardIds.slice(),
          modelsById: { ...prev.modelsById, [cardId]: nextModel },
        };
      });
    }

    function updateState(mutator) {
      if (!boardView || typeof boardView.setState !== "function") {
        return;
      }
      boardView.setState(function (prev) {
        var next = typeof mutator === "function" ? mutator(prev) : mutator;
        currentState = next || prev;
        return currentState;
      });
    }

    var engine = LiveCard.init({
      resolve: function (cardId) {
        return currentState && currentState.modelsById ? currentState.modelsById[cardId] : null;
      },
      chartLib: window.Chart || null,
      fileUrlBase: fileUrlBase() || undefined,
      markdown: window.marked ? function (value) { return window.marked.parse(value); } : null,
      sanitize: window.DOMPurify ? function (value) { return window.DOMPurify.sanitize(value); } : null,
      onPatchState: async function (cardId, patch) {
        await BoardRuntimeShared.patchCardState({
          fetchServer: fetchServer,
          boardPaths: function () { return boardPaths(); },
          boardId: currentState && currentState.boardId,
          cardId: cardId,
          patch: patch,
        });
        updateState(function (prev) {
          var model = prev && prev.modelsById ? prev.modelsById[cardId] : null;
          if (!model) {
            return prev;
          }
          var nextModel = {
            id: model.id,
            card: model.card,
            card_data: { ...(model.card_data || {}), ...(patch || {}) },
            computed_values: model.computed_values || {},
            runtime_state: model.runtime_state || {},
            card_chats: model.card_chats || { messages: [], receiving: false },
          };
          return {
            boardId: prev.boardId,
            cardIds: prev.cardIds.slice(),
            modelsById: { ...prev.modelsById, [cardId]: nextModel },
          };
        });
      },
      onRefresh: async function (cardId) {
        await BoardRuntimeShared.dispatchCardAction({
          fetchServer: fetchServer,
          boardPaths: function () { return boardPaths(); },
          boardId: currentState && currentState.boardId,
          cardId: cardId,
          actionType: "refresh",
          payload: {},
        });
      },
      onAction: async function (cardId, actionType, payload) {
        var result = await BoardRuntimeShared.dispatchCardAction({
          fetchServer: fetchServer,
          boardPaths: function () { return boardPaths(); },
          boardId: currentState && currentState.boardId,
          cardId: cardId,
          actionType: actionType,
          payload: payload,
        });
        applySuccessfulAction(cardId, actionType, result.payload);
      },
      startReceivingChats: function () { return Promise.resolve(); },
      stopReceivingChats: function () { return Promise.resolve(); },
    });

    rootElement.innerHTML = "";
    var boardView = LiveCard.Board(engine, rootElement, {
      initialState: currentState,
      getNodeIds: function (state) { return state.cardIds; },
      selectNode: function (state, cardId) { return state.modelsById[cardId]; },
      mode: mode,
      canvas: canvas,
    });

    return {
      dispose: function () {
        if (boardView && typeof boardView.destroy === "function") {
          boardView.destroy();
        }
      },
      setMode: function (nextMode) {
        if (boardView && boardView.core && typeof boardView.core.setMode === "function") {
          boardView.core.setMode(nextMode);
        }
      },
      autoLayout: function () {
        if (boardView && boardView.core) {
          if (typeof boardView.core.setMode === "function") {
            boardView.core.setMode("canvas");
          }
          if (typeof boardView.core.autoLayout === "function") {
            boardView.core.autoLayout();
          }
        }
      },
      setDevMode: function (enabled) {
        if (boardView && boardView.core && typeof boardView.core.setDevMode === "function") {
          boardView.core.setDevMode(!!enabled);
        }
      },
    };
  }

  function create(options) {
    var opts = options || {};
    var rootElement = opts.rootElement;
    var fetchServer = opts.fetchServer;
    var boardPaths = opts.boardPaths;
    var getServerOrigin = opts.getServerOrigin;

    if (!rootElement) {
      throw new Error("MainBoard.create requires options.rootElement");
    }

    if (typeof fetchServer !== "function") {
      throw new Error("MainBoard.create requires options.fetchServer");
    }

    if (typeof boardPaths !== "function") {
      throw new Error("MainBoard.create requires options.boardPaths");
    }

    if (typeof getServerOrigin !== "function") {
      throw new Error("MainBoard.create requires options.getServerOrigin");
    }

    var createBoardRuntimeClient =
      window.BoardLiveCardsClient && window.BoardLiveCardsClient.createBoardRuntimeClient;

    if (typeof createBoardRuntimeClient !== "function") {
      rootElement.innerHTML =
        '<div class="alert alert-danger">board-livecards-client.js not loaded.</div>';
      throw new Error("BoardLiveCardsClient not loaded");
    }

    var state = {
      runtimeClient: null,
      boardViewRuntime: null,
      boardId: "",
      mode: String(opts.initialMode || "board"),
      devMode: !!opts.devMode,
      canvas: opts.canvas || { height: "calc(100vh - 56px)", overflow: "auto" },
    };

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
        throw new Error("MainBoard.mountBoard requires boardId");
      }

      if (state.runtimeClient && typeof state.runtimeClient.dispose === "function") {
        state.runtimeClient.dispose();
      }
      if (state.boardViewRuntime && typeof state.boardViewRuntime.dispose === "function") {
        state.boardViewRuntime.dispose();
      }
      state.runtimeClient = null;
      state.boardViewRuntime = null;
      state.boardId = bid;

      showLoading("Loading board...");

      var runtimeClient = createBoardRuntimeClient({
        fetchServer: fetchServer,
        boardPaths: function (id) {
          return boardPaths(id || state.boardId);
        },
        getServerOrigin: getServerOrigin,
        initialMode: state.mode,
        canvas: state.canvas,
      });

      await runtimeClient.bootstrapBoard({
        boardId: bid,
        rootElement: rootElement,
        mode: state.mode,
      });

      state.runtimeClient = runtimeClient;

      if (state.devMode && typeof runtimeClient.setDevMode === "function") {
        runtimeClient.setDevMode(true);
      }

      if (typeof opts.onBoardMounted === "function") {
        opts.onBoardMounted({ boardId: bid, runtimeClient: runtimeClient });
      }
    }

    async function mountState(boardState, boardId) {
      if (!boardState || !Array.isArray(boardState.cardIds) || !boardState.modelsById) {
        throw new Error("MainBoard.mountState requires board state with cardIds and modelsById");
      }

      var bid = String(boardId || boardState.boardId || "").trim();
      if (!bid) {
        throw new Error("MainBoard.mountState requires boardId");
      }

      if (state.runtimeClient && typeof state.runtimeClient.dispose === "function") {
        state.runtimeClient.dispose();
      }
      if (state.boardViewRuntime && typeof state.boardViewRuntime.dispose === "function") {
        state.boardViewRuntime.dispose();
      }
      state.runtimeClient = null;
      state.boardViewRuntime = null;
      state.boardId = bid;

      state.boardViewRuntime = createBoardViewRuntime({
        rootElement: rootElement,
        boardState: boardState,
        mode: state.mode,
        canvas: state.canvas,
        fetchServer: fetchServer,
        boardPaths: function () { return boardPaths(state.boardId); },
        getServerOrigin: getServerOrigin,
      });

      if (state.devMode && typeof state.boardViewRuntime.setDevMode === "function") {
        state.boardViewRuntime.setDevMode(true);
      }
    }

    function setMode(mode) {
      state.mode = String(mode || "board");
      if (state.runtimeClient && typeof state.runtimeClient.setMode === "function") {
        state.runtimeClient.setMode(state.mode);
      }
      if (state.boardViewRuntime && typeof state.boardViewRuntime.setMode === "function") {
        state.boardViewRuntime.setMode(state.mode);
      }
    }

    function autoLayout() {
      if (state.runtimeClient && typeof state.runtimeClient.autoLayout === "function") {
        state.runtimeClient.autoLayout();
      }
      if (state.boardViewRuntime && typeof state.boardViewRuntime.autoLayout === "function") {
        state.boardViewRuntime.autoLayout();
      }
    }

    function setDevMode(enabled) {
      state.devMode = !!enabled;
      if (state.runtimeClient && typeof state.runtimeClient.setDevMode === "function") {
        state.runtimeClient.setDevMode(state.devMode);
      }
      if (state.boardViewRuntime && typeof state.boardViewRuntime.setDevMode === "function") {
        state.boardViewRuntime.setDevMode(state.devMode);
      }
    }

    function dispose() {
      if (state.runtimeClient && typeof state.runtimeClient.dispose === "function") {
        state.runtimeClient.dispose();
      }
      if (state.boardViewRuntime && typeof state.boardViewRuntime.dispose === "function") {
        state.boardViewRuntime.dispose();
      }
      state.runtimeClient = null;
      state.boardViewRuntime = null;
    }

    return {
      mountBoard: mountBoard,
      mountState: mountState,
      setMode: setMode,
      autoLayout: autoLayout,
      setDevMode: setDevMode,
      dispose: dispose,
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

  window.MainBoard = window.MainBoard || {};
  window.MainBoard.create = create;
  window.MainBoard.init = init;
})();
