(function () {
  function resolveBoardPaths(options) {
    var opts = options || {};
    if (typeof opts.boardPaths !== 'function') {
      throw new Error('boardPaths is required');
    }
    return opts.boardPaths(opts.boardId);
  }

  function buildFileUrlBase(options) {
    var opts = options || {};
    if (typeof opts.getServerOrigin !== 'function' || typeof opts.boardPaths !== 'function') {
      return null;
    }

    var boardId = String(opts.boardId || '').trim();
    if (!boardId) {
      return null;
    }

    var paths = opts.boardPaths(boardId);
    return String(opts.getServerOrigin()) + String(paths && paths.initBoard || '').replace(/\/init-board$/, '');
  }

  async function uploadCardFile(options) {
    var opts = options || {};
    if (!opts.file) {
      return null;
    }
    if (typeof opts.fetchServer !== 'function') {
      throw new Error('fetchServer is required');
    }

    var paths = resolveBoardPaths(opts);
    var requestPath = String(paths.cardFile(opts.cardId)) + (opts.inChat ? '?inChat=true' : '');
    var fileName = typeof opts.file.name === 'string' && opts.file.name ? opts.file.name : 'upload.bin';
    var contentType = opts.file.type || 'application/octet-stream';

    var res = await opts.fetchServer(requestPath, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-file-name': encodeURIComponent(fileName),
      },
      body: opts.file,
    });

    if (!res.ok) {
      var message = '';
      try {
        message = await res.text();
      } catch (_) {
        message = '';
      }
      throw new Error('Upload failed for ' + opts.cardId + ' (' + res.status + ')' + (message ? ': ' + message : ''));
    }

    var payload = await res.json();
    return payload && payload.file ? payload.file : null;
  }

  async function prepareActionPayload(options) {
    var opts = options || {};
    var nextPayload = opts.payload && typeof opts.payload === 'object' ? { ...opts.payload } : {};
    var files = Array.isArray(nextPayload.files) ? nextPayload.files : [];

    if ((opts.actionType !== 'file-upload' && opts.actionType !== 'chat-send') || !files.length) {
      if (opts.actionType === 'file-upload' || opts.actionType === 'chat-send') {
        nextPayload.files = files;
      }
      return nextPayload;
    }

    var uploadedFiles = [];
    for (var index = 0; index < files.length; index += 1) {
      var uploaded = await uploadCardFile({
        fetchServer: opts.fetchServer,
        boardPaths: opts.boardPaths,
        boardId: opts.boardId,
        cardId: opts.cardId,
        file: files[index],
        inChat: opts.actionType === 'chat-send',
      });
      if (uploaded) {
        uploadedFiles.push(uploaded);
      }
    }

    nextPayload.files = opts.actionType === 'chat-send' ? [] : uploadedFiles;
    return nextPayload;
  }

  async function patchCardState(options) {
    var opts = options || {};
    if (typeof opts.fetchServer !== 'function') {
      throw new Error('fetchServer is required');
    }
    var paths = resolveBoardPaths(opts);
    var res = await opts.fetchServer(paths.patchCard(opts.cardId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.patch || {}),
    });
    if (!res.ok) {
      throw new Error('PATCH failed for ' + opts.cardId + ' (' + res.status + ')');
    }
    return res;
  }

  async function dispatchCardAction(options) {
    var opts = options || {};
    if (typeof opts.fetchServer !== 'function') {
      throw new Error('fetchServer is required');
    }
    var paths = resolveBoardPaths(opts);
    var requestPayload = await prepareActionPayload(opts);
    var res = await opts.fetchServer(paths.cardAction(opts.cardId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionType: opts.actionType, payload: requestPayload }),
    });
    if (!res.ok) {
      throw new Error((opts.actionType === 'refresh' ? 'Refresh' : 'Action') + ' failed for ' + opts.cardId + ' (' + res.status + ')');
    }
    return { response: res, payload: requestPayload };
  }

  window.BoardRuntimeShared = window.BoardRuntimeShared || {};
  window.BoardRuntimeShared.buildFileUrlBase = buildFileUrlBase;
  window.BoardRuntimeShared.prepareActionPayload = prepareActionPayload;
  window.BoardRuntimeShared.patchCardState = patchCardState;
  window.BoardRuntimeShared.dispatchCardAction = dispatchCardAction;
})();