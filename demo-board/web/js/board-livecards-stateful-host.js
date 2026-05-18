(function () {
  function requireLiveCard() {
    var LiveCard = window.LiveCard;
    if (!LiveCard) {
      throw new Error('LiveCard global not loaded');
    }
    return LiveCard;
  }

  function requireClient() {
    return window.BoardLiveCardsClient || {};
  }

  function callMountHandler(handler, args) {
    if (typeof handler !== 'function') {
      return Promise.resolve();
    }
    return handler.apply(null, args);
  }

  function mount(options) {
    var mountOptions = options || {};
    var rootElement = mountOptions.rootElement;
    var runtimeProperty = String(mountOptions.runtimeProperty || '__statefulCustomBoardRuntime');
    var client = requireClient();

    if (!rootElement) {
      throw new Error('BoardLivecardsStatefulHost.mount requires rootElement');
    }
    if (!mountOptions.state || !Array.isArray(mountOptions.state.cardIds) || !mountOptions.state.modelsById) {
      rootElement.textContent = 'stateful custom board host requires a hydrated state object.';
      throw new Error('BoardLivecardsStatefulHost.mount requires options.state');
    }

    var LiveCard = requireLiveCard();
    if (rootElement[runtimeProperty] && typeof rootElement[runtimeProperty].dispose === 'function') {
      rootElement[runtimeProperty].dispose();
    }

    var activeState = mountOptions.state;
    var activeMode = mountOptions.mode || 'board';
    var activeBoardView = null;
    var runtimeClient = null;

    function fileUrlBase() {
      if (typeof client.buildFileUrlBase !== 'function' ||
          typeof mountOptions.boardPaths !== 'function' ||
          typeof mountOptions.getServerOrigin !== 'function') {
        return null;
      }
      return client.buildFileUrlBase({
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
      return activeState;
    }

    function dispose() {
      if (activeBoardView && typeof activeBoardView.destroy === 'function') {
        activeBoardView.destroy();
      }
      activeBoardView = null;
      activeState = null;
      if (rootElement[runtimeProperty] === runtimeClient) {
        rootElement[runtimeProperty] = null;
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
        return callMountHandler(mountOptions.onPatchState, [cardId, patch || {}]);
      },
      onRefresh: function (cardId) {
        return callMountHandler(mountOptions.onRefresh, [cardId]);
      },
      onAction: function (cardId, actionType, payload) {
        return callMountHandler(mountOptions.onAction, [cardId, actionType, payload || {}]);
      },
      startReceivingChats: function (cardId) {
        return callMountHandler(mountOptions.startReceivingChats, [cardId]);
      },
      stopReceivingChats: function (cardId) {
        return callMountHandler(mountOptions.stopReceivingChats, [cardId]);
      }
    });

    rootElement.innerHTML = '';
    activeBoardView = LiveCard.Board(engine, rootElement, {
      initialState: activeState,
      getNodeIds: typeof mountOptions.getNodeIds === 'function'
        ? mountOptions.getNodeIds
        : function (state) { return state.cardIds; },
      selectNode: typeof mountOptions.selectNode === 'function'
        ? mountOptions.selectNode
        : function (state, cardId) { return state.modelsById[cardId]; },
      mode: activeMode,
      canvas: mountOptions.canvas || { height: '100%', overflow: 'auto' },
      boardTheme: mountOptions.boardTheme,
      boardRenderer: mountOptions.boardRenderer
    });
    notifyBoardEngine();

    runtimeClient = {
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

    rootElement[runtimeProperty] = runtimeClient;
    runtimeClient.ready = Promise.resolve(runtimeClient);
    return runtimeClient;
  }

  window.BoardLivecardsStatefulHost = window.BoardLivecardsStatefulHost || {};
  window.BoardLivecardsStatefulHost.mount = mount;
  window.StatefulCustomBoardHost = window.BoardLivecardsStatefulHost;
})();