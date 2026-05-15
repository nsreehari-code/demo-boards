(function () {
  var boardId = 'ingest1';
  var rootElement = document.getElementById('boardRoot');
  var clientApi = window.BoardLiveCardsClient || {};
  var createBoardRuntimeClient = clientApi.createBoardRuntimeClient;
  var defaultBoardPaths = clientApi.defaultBoardPaths;
  var runtimeClient = null;

  if (!rootElement) {
    throw new Error('Missing #boardRoot');
  }
  if (!createBoardRuntimeClient) {
    rootElement.textContent = 'board-livecards-client.js not loaded.';
    throw new Error('BoardLiveCardsClient not loaded');
  }
  if (typeof defaultBoardPaths !== 'function') {
    rootElement.textContent = 'defaultBoardPaths is not available.';
    throw new Error('BoardLiveCardsClient.defaultBoardPaths not loaded');
  }

  var serverConfig = null;
  var activeBoardId = boardId;

  async function loadServerConfig() {
    if (serverConfig) return serverConfig;
    var response = await fetch('../demo-board/server-config.json');
    if (!response.ok) {
      throw new Error('Failed to load demo-board/server-config.json: HTTP ' + response.status);
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

  var activeServerOrigin = null;

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

  async function bootstrap() {
    await loadServerConfig();

    runtimeClient = createBoardRuntimeClient({
      fetchServer: fetchServer,
      boardPaths: boardPaths,
      getServerOrigin: function () { return activeServerOrigin; },
      initialMode: 'board',
      canvas: { height: '100vh', overflow: 'auto' },
    });

    await runtimeClient.bootstrapBoard({
      boardId: boardId,
      rootElement: rootElement,
      mode: 'board',
    });
  }

  bootstrap().catch(function (error) {
    console.error(error);
    rootElement.innerHTML = '<pre style="white-space:pre-wrap">Failed to load ingest board: '
      + String(error && error.message || error) + '</pre>';
  });

  window.addEventListener('beforeunload', function () {
    if (runtimeClient) runtimeClient.dispose();
  });
})();