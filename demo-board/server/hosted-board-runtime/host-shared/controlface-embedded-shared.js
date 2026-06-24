(function (global) {
  function normalizeOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function parseJsonBodyOrEmpty(bodyText) {
    var text = String(bodyText || '').trim();
    if (!text) return {};
    return JSON.parse(text);
  }

  function cloneJsonValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function createHttpEnvelope(statusCode, payload, headers) {
    return JSON.stringify({
      statusCode: statusCode,
      headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}),
      body: JSON.stringify(payload),
    }, null, 2);
  }

  function createErrorEnvelope(statusCode, message) {
    return createHttpEnvelope(statusCode, {
      status: 'error',
      error: typeof message === 'string' && message.trim() ? message.trim() : 'request failed',
    });
  }

  function createError(statusCode, message, extras) {
    var error = new Error(typeof message === 'string' && message.trim() ? message.trim() : 'request failed');
    error.statusCode = Number(statusCode) || 500;
    if (extras && typeof extras === 'object') {
      Object.keys(extras).forEach(function (key) {
        error[key] = extras[key];
      });
    }
    return error;
  }

  function normalizeRequiredBoardId(boardId) {
    var normalized = normalizeOptionalString(boardId);
    if (!normalized) {
      throw new Error('Board id is required');
    }
    return normalized;
  }

  function createDefaultManagedBoardState(boardId) {
    return {
      boardId: boardId,
      board: {
        id: boardId,
        ui: {},
        metadata: {},
      },
      layout: null,
    };
  }

  function normalizeManagedBoardState(boardId, candidate) {
    var normalizedBoardId = normalizeRequiredBoardId(boardId);
    var state = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate
      : createDefaultManagedBoardState(normalizedBoardId);
    var board = state.board && typeof state.board === 'object' && !Array.isArray(state.board)
      ? state.board
      : {};
    var metadata = board.metadata && typeof board.metadata === 'object' && !Array.isArray(board.metadata)
      ? board.metadata
      : {};
    var ui = board.ui && typeof board.ui === 'object' && !Array.isArray(board.ui)
      ? board.ui
      : {};
    return {
      boardId: normalizedBoardId,
      board: Object.assign({}, board, {
        id: normalizeOptionalString(board.id) || normalizedBoardId,
        metadata: cloneJsonValue(metadata) || {},
        ui: cloneJsonValue(ui) || {},
      }),
      layout: state.layout == null ? null : cloneJsonValue(state.layout),
    };
  }

  function summarizeBoardForList(board) {
    return {
      id: board.id,
      label: board.label,
      ai: board.ai,
      aiWorkspaceTemplate: board.aiWorkspaceTemplate,
      uiTemplate: board.uiTemplate,
      metadata: board.metadata,
    };
  }

  function summarizeBoardLayout(layout) {
    return layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : null;
  }

  function normalizeImportMode(value) {
    var mode = normalizeOptionalString(value).toLowerCase();
    return mode === 'ingest' ? 'ingest' : 'replace';
  }

  function summarizeCardForImport(card) {
    return {
      id: typeof (card && card.id) === 'string' ? card.id.trim() : '',
      title: typeof (card && card.meta && card.meta.title) === 'string' ? card.meta.title.trim() : '',
    };
  }

  function parseBoardPayloadEnvelope(payload) {
    if (Array.isArray(payload)) {
      return { label: '', subtitle: '', cards: payload };
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.cards)) {
      return {
        label: typeof payload.boardLabel === 'string' ? payload.boardLabel.trim() : '',
        subtitle: typeof payload.boardSubtitle === 'string' ? payload.boardSubtitle.trim() : '',
        cards: payload.cards,
      };
    }
    return null;
  }

  function buildBoardImportPreview(currentCards, nextCards, mode) {
    var currentCardMap = new Map(
      (Array.isArray(currentCards) ? currentCards : [])
        .map(function (card) { return [String(card && card.id || '').trim(), card]; })
        .filter(function (entry) { return !!entry[0]; })
    );
    var nextCardMap = new Map(
      (Array.isArray(nextCards) ? nextCards : [])
        .map(function (card) { return [String(card && card.id || '').trim(), card]; })
        .filter(function (entry) { return !!entry[0]; })
    );
    var replaceIds = [];
    var addIds = [];
    var removeIds = [];

    nextCardMap.forEach(function (card, id) {
      var title = typeof (card && card.meta && card.meta.title) === 'string' ? card.meta.title.trim() : '';
      if (currentCardMap.has(id)) {
        replaceIds.push({ id: id, title: title });
      } else {
        addIds.push({ id: id, title: title });
      }
    });

    if (mode === 'replace') {
      currentCardMap.forEach(function (card, id) {
        if (!nextCardMap.has(id)) {
          var title = typeof (card && card.meta && card.meta.title) === 'string' ? card.meta.title.trim() : '';
          removeIds.push({ id: id, title: title });
        }
      });
    }

    replaceIds.sort(function (left, right) { return left.id.localeCompare(right.id); });
    addIds.sort(function (left, right) { return left.id.localeCompare(right.id); });
    removeIds.sort(function (left, right) { return left.id.localeCompare(right.id); });
    return { replaceIds: replaceIds, addIds: addIds, removeIds: removeIds };
  }
  function createManagedBoardLifecycle(deps) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('createManagedBoardLifecycle requires deps');
    }
    var storage = deps.storage && typeof deps.storage === 'object' ? deps.storage : null;
    if (!storage
      || typeof storage.list !== 'function'
      || typeof storage.get !== 'function'
      || typeof storage.has !== 'function'
      || typeof storage.put !== 'function'
      || typeof storage.set !== 'function'
      || typeof storage.archive !== 'function') {
      throw new Error('createManagedBoardLifecycle requires storage list/get/has/put/set/archive functions');
    }

    function cloneRecord(record, boardId) {
      var next = record && typeof record === 'object' && !Array.isArray(record) ? cloneJsonValue(record) : {};
      next.id = normalizeOptionalString(next.id) || normalizeRequiredBoardId(boardId);
      return next;
    }

    async function getRecord(boardId) {
      var normalizedBoardId = normalizeRequiredBoardId(boardId);
      var record = await Promise.resolve(storage.get(normalizedBoardId));
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return null;
      }
      return cloneRecord(record, normalizedBoardId);
    }

    return {
      async list() {
        var items = await Promise.resolve(storage.list());
        var list = Array.isArray(items) ? items : [];
        return list.map(function (entry) {
          if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.record && typeof entry.record === 'object' && !Array.isArray(entry.record)) {
            var entryBoardId = normalizeOptionalString(entry.id) || normalizeOptionalString(entry.record.id);
            return cloneRecord(entry.record, entryBoardId || 'unknown-board');
          }
          var boardId = normalizeOptionalString(entry && entry.id);
          return cloneRecord(entry, boardId || 'unknown-board');
        });
      },
      get(boardId) {
        return getRecord(boardId);
      },
      has(boardId) {
        return Promise.resolve(storage.has(normalizeRequiredBoardId(boardId)));
      },
      async provision(boardId, record, options) {
        var normalizedBoardId = normalizeRequiredBoardId(boardId);
        var nextRecord = cloneRecord(record, normalizedBoardId);
        await Promise.resolve(storage.put(normalizedBoardId, nextRecord));
        if (options && Object.prototype.hasOwnProperty.call(options, 'layout') && typeof storage.setLayout === 'function') {
          if (options.layout == null) {
            if (typeof storage.removeLayout === 'function') {
              await Promise.resolve(storage.removeLayout(normalizedBoardId));
            }
          } else {
            await Promise.resolve(storage.setLayout(normalizedBoardId, cloneJsonValue(options.layout)));
          }
        }
        return getRecord(normalizedBoardId);
      },
      async saveMeta(boardId, metadata) {
        var normalizedBoardId = normalizeRequiredBoardId(boardId);
        var existing = await getRecord(normalizedBoardId);
        if (!existing) {
          return null;
        }
        var nextMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? cloneJsonValue(metadata) : {};
        existing.metadata = Object.assign({}, existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? cloneJsonValue(existing.metadata) : {}, nextMetadata);
        await Promise.resolve(storage.set(normalizedBoardId, existing));
        return getRecord(normalizedBoardId);
      },
      async saveRecord(boardId, record) {
        var normalizedBoardId = normalizeRequiredBoardId(boardId);
        var nextRecord = cloneRecord(record, normalizedBoardId);
        await Promise.resolve(storage.set(normalizedBoardId, nextRecord));
        return getRecord(normalizedBoardId);
      },
      getLayout(boardId) {
        if (typeof storage.getLayout !== 'function') {
          return null;
        }
        return Promise.resolve(storage.getLayout(normalizeRequiredBoardId(boardId)));
      },
      saveLayout(boardId, layout) {
        if (typeof storage.setLayout !== 'function') {
          return null;
        }
        return Promise.resolve(storage.setLayout(normalizeRequiredBoardId(boardId), cloneJsonValue(layout)));
      },
      removeLayout(boardId) {
        if (typeof storage.removeLayout !== 'function') {
          return null;
        }
        return Promise.resolve(storage.removeLayout(normalizeRequiredBoardId(boardId)));
      },
      async deprecate(boardId) {
        var normalizedBoardId = normalizeRequiredBoardId(boardId);
        var archived = await Promise.resolve(storage.archive(normalizedBoardId));
        if (!archived || typeof archived !== 'object' || Array.isArray(archived)) {
          return null;
        }
        return {
          board: archived.record && typeof archived.record === 'object' && !Array.isArray(archived.record)
            ? cloneRecord(archived.record, normalizedBoardId)
            : null,
          layout: archived.layout == null ? null : cloneJsonValue(archived.layout),
          archiveId: normalizeOptionalString(archived.archiveId),
          archiveRecordPath: normalizeOptionalString(archived.archiveRecordPath),
          archiveWorkspaceDir: normalizeOptionalString(archived.archiveWorkspaceDir),
        };
      },
    };
  }

  function createManagedBoardsApi(deps) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('createManagedBoardsApi requires deps');
    }

    var lifecycle = deps.lifecycle && typeof deps.lifecycle === 'object'
      ? deps.lifecycle
      : (deps.dynamicBoards && typeof deps.dynamicBoards === 'object' ? deps.dynamicBoards : null);

    if (!lifecycle) {
      throw new Error('createManagedBoardsApi requires deps.lifecycle or deps.dynamicBoards');
    }
    if (typeof lifecycle.list !== 'function'
      || typeof lifecycle.get !== 'function'
      || typeof lifecycle.has !== 'function'
      || (typeof lifecycle.provision !== 'function' && typeof lifecycle.add !== 'function')
      || typeof lifecycle.saveMeta !== 'function'
      || typeof lifecycle.saveRecord !== 'function'
      || typeof lifecycle.deprecate !== 'function') {
      throw new Error('createManagedBoardsApi requires full board lifecycle functions');
    }

    function readHostConfigArgs(args) {
      var source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      return {
        hostConfigPath: normalizeOptionalString(source.hostConfigPath),
        localFsConfigLoaderPath: normalizeOptionalString(source.localFsConfigLoaderPath),
        templatesConfigPath: normalizeOptionalString(source.templatesConfigPath),
        assistantRegistryPath: normalizeOptionalString(source.assistantRegistryPath),
        setupSingleAiWorkspaceScriptPath: normalizeOptionalString(source.setupSingleAiWorkspaceScriptPath),
      };
    }

    async function getExistingState(boardId) {
      var normalizedBoardId = normalizeRequiredBoardId(boardId);
      var board = await Promise.resolve(lifecycle.get(normalizedBoardId));
      if (!board) {
        return null;
      }
      var layout = typeof lifecycle.getLayout === 'function'
        ? await Promise.resolve(lifecycle.getLayout(normalizedBoardId))
        : null;
      return normalizeManagedBoardState(normalizedBoardId, {
        boardId: normalizedBoardId,
        board: board,
        layout: layout,
      });
    }

    async function getState(boardId) {
      var existing = await getExistingState(boardId);
      if (existing) {
        return existing;
      }
      return normalizeManagedBoardState(boardId, null);
    }

    async function getRequiredState(boardId) {
      var normalizedBoardId = normalizeRequiredBoardId(boardId);
      var state = await getExistingState(normalizedBoardId);
      if (!state) {
        throw createError(404, "board '" + normalizedBoardId + "' not found");
      }
      return state;
    }

    async function saveState(boardId, state) {
      var normalized = normalizeManagedBoardState(boardId, state);
      var savedBoard = await Promise.resolve(lifecycle.saveRecord(normalized.boardId, normalized.board));
      if (!savedBoard) {
        throw createError(404, "board '" + normalized.boardId + "' not found");
      }
      if (normalized.layout == null) {
        if (typeof lifecycle.removeLayout === 'function') {
          await Promise.resolve(lifecycle.removeLayout(normalized.boardId));
        }
      } else if (typeof lifecycle.saveLayout === 'function') {
        await Promise.resolve(lifecycle.saveLayout(normalized.boardId, normalized.layout));
      }
      return normalizeManagedBoardState(normalized.boardId, {
        boardId: normalized.boardId,
        board: savedBoard,
        layout: normalized.layout,
      });
    }

    async function createState(boardId, state) {
      var normalized = normalizeManagedBoardState(boardId, state);
      var createdBoard = typeof lifecycle.provision === 'function'
        ? await Promise.resolve(lifecycle.provision(normalized.boardId, normalized.board, { layout: normalized.layout }))
        : await Promise.resolve(lifecycle.add(normalized.boardId, normalized.board));
      return normalizeManagedBoardState(normalized.boardId, {
        boardId: normalized.boardId,
        board: createdBoard,
        layout: normalized.layout,
      });
    }

    function getActiveBoardId() {
      return typeof deps.getActiveBoardId === 'function' ? normalizeOptionalString(deps.getActiveBoardId()) : '';
    }

    function requireActiveRuntimeBoard(boardId, missingStatusCode) {
      var normalizedBoardId = normalizeRequiredBoardId(boardId);
      var activeBoardId = getActiveBoardId();
      if (!activeBoardId || activeBoardId !== normalizedBoardId) {
        if (missingStatusCode === 409) {
          throw createError(409, "board runtime for '" + normalizedBoardId + "' is not active");
        }
        throw createError(404, "board runtime '" + normalizedBoardId + "' not found");
      }
      return activeBoardId;
    }

    async function invokeRuntimeRoute(method, path, body) {
      if (typeof deps.invokeRuntimeRoute !== 'function') {
        throw createError(501, 'Runtime route invocation is unavailable');
      }

      var raw = await deps.invokeRuntimeRoute(method, path, body || '');
      var envelope = raw && String(raw).trim() ? JSON.parse(raw) : {};
      var statusCode = Number(envelope.statusCode) || 200;
      var responseText = typeof envelope.body === 'string' ? envelope.body : '';
      var payload = responseText ? JSON.parse(responseText) : null;
      if (statusCode >= 400) {
        var message = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'runtime request failed';
        throw createError(statusCode, message, { payload: payload });
      }
      return payload;
    }

    async function invokeRuntimeTool(boardId, routeKind, tool, args) {
      var runtimeBoardId = requireActiveRuntimeBoard(boardId, 404);
      return invokeRuntimeRoute(
        'POST',
        '/api/boards/' + encodeURIComponent(runtimeBoardId) + '/' + routeKind,
        JSON.stringify({ tool: tool, args: args || {} })
      );
    }

    async function listRuntimeCardsForBoard(boardId) {
      var payload = await invokeRuntimeTool(boardId, 'mcp-controlplane', 'list-runtime-cards', { board_id: boardId });
      var cards = Array.isArray(payload && payload.data)
        ? payload.data
        : (Array.isArray(payload && payload.data && payload.data.cards) ? payload.data.cards : []);
      return Array.isArray(cards) ? cards : [];
    }

    async function validateImportCards(boardId, cards) {
      var results = [];
      var normalizedBoardId = requireActiveRuntimeBoard(boardId, 404);
      var list = Array.isArray(cards) ? cards : [];

      for (var index = 0; index < list.length; index += 1) {
        var card = list[index];
        var summary = summarizeCardForImport(card);
        var issues = [];
        var isValid = false;

        if (!summary.id) {
          issues.push('Every card in the runtime dump must have a non-empty string id');
        } else {
          try {
            var payload = await invokeRuntimeRoute(
              'POST',
              '/api/boards/' + encodeURIComponent(normalizedBoardId) + '/mcp',
              JSON.stringify({
                tool: 'preflight.validate-candidate-card-definition',
                args: {
                  board_id: normalizedBoardId,
                  candidate_card_content: card,
                },
              })
            );
            var data = payload && payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
            isValid = data.isValid === true;
            if (Array.isArray(data.issues)) {
              data.issues.forEach(function (issue) {
                if (typeof issue === 'string' && issue.trim()) {
                  issues.push(issue.trim());
                }
              });
            }
          } catch (error) {
            var message = error && error.message ? String(error.message).trim() : '';
            if (message) {
              issues.push(message);
            }
          }
        }

        results.push({
          id: summary.id,
          title: summary.title,
          isValid: isValid && issues.length === 0,
          issues: issues,
        });
      }

      return results;
    }

    async function buildBoardExport(state) {
      var cards = await listRuntimeCardsForBoard(state.boardId);
      var metadata = state.board && state.board.metadata && typeof state.board.metadata === 'object' && !Array.isArray(state.board.metadata)
        ? state.board.metadata
        : {};
      return {
        version: 1,
        boardId: state.boardId,
        exportedAt: new Date().toISOString(),
        boardLabel: typeof metadata.pageTitle === 'string' ? metadata.pageTitle : (typeof state.board.label === 'string' ? state.board.label : ''),
        boardSubtitle: typeof metadata.pageSubtitle === 'string' ? metadata.pageSubtitle : '',
        cards: cards,
      };
    }

    async function buildImportPreview(state, envelope, mode) {
      var currentCards = await listRuntimeCardsForBoard(state.boardId);
      var validation = await validateImportCards(state.boardId, envelope.cards);
      return {
        mode: mode,
        replaceIds: buildBoardImportPreview(currentCards, envelope.cards, mode).replaceIds,
        addIds: buildBoardImportPreview(currentCards, envelope.cards, mode).addIds,
        removeIds: buildBoardImportPreview(currentCards, envelope.cards, mode).removeIds,
        boardLabel: envelope.label,
        boardSubtitle: envelope.subtitle,
        validCards: validation.filter(function (entry) { return entry.isValid; }),
        invalidCards: validation.filter(function (entry) { return !entry.isValid; }),
      };
    }

    async function applyBoardImport(state, envelope, mode, applyBoardMetadata) {
      var currentCards = await listRuntimeCardsForBoard(state.boardId);
      var validation = await validateImportCards(state.boardId, envelope.cards);
      var invalidCards = validation.filter(function (entry) { return !entry.isValid; });
      if (invalidCards.length > 0) {
        throw createError(400, 'Import validation failed for ' + invalidCards.length + ' card' + (invalidCards.length === 1 ? '' : 's'), {
          validation: {
            validCards: validation.filter(function (entry) { return entry.isValid; }),
            invalidCards: invalidCards,
          },
        });
      }

      var nextCards = Array.isArray(envelope.cards) ? envelope.cards : [];
      var nextIds = {};
      for (var index = 0; index < nextCards.length; index += 1) {
        var card = nextCards[index];
        var cardId = typeof (card && card.id) === 'string' ? card.id.trim() : '';
        if (!cardId) {
          throw createError(400, 'Every card in the runtime dump must have a non-empty string id');
        }
        nextIds[cardId] = true;
        await invokeRuntimeTool(state.boardId, 'mcp-controlplane', 'manage.upsert-card', {
          board_id: state.boardId,
          card_id: cardId,
          candidate_card_content: card,
        });
      }

      if (mode === 'replace') {
        for (var currentIndex = 0; currentIndex < currentCards.length; currentIndex += 1) {
          var currentCard = currentCards[currentIndex];
          var currentCardId = typeof (currentCard && currentCard.id) === 'string' ? currentCard.id.trim() : '';
          if (currentCardId && !nextIds[currentCardId]) {
            await invokeRuntimeTool(state.boardId, 'mcp-controlplane', 'manage.remove-card', {
              board_id: state.boardId,
              card_id: currentCardId,
            });
          }
        }
      }

      var updatedBoard = null;
      if (applyBoardMetadata && (envelope.label || envelope.subtitle)) {
        var metadata = state.board.metadata && typeof state.board.metadata === 'object' && !Array.isArray(state.board.metadata)
          ? cloneJsonValue(state.board.metadata)
          : {};
        if (envelope.label) {
          metadata.pageTitle = envelope.label;
        }
        if (envelope.subtitle) {
          metadata.pageSubtitle = envelope.subtitle;
        }
        state.board.metadata = metadata;
        updatedBoard = saveState(state.boardId, state).board;
      }

      return {
        board: updatedBoard ? summarizeBoardForList(updatedBoard) : null,
        preview: {
          mode: mode,
          replaceIds: buildBoardImportPreview(currentCards, nextCards, mode).replaceIds,
          addIds: buildBoardImportPreview(currentCards, nextCards, mode).addIds,
          removeIds: buildBoardImportPreview(currentCards, nextCards, mode).removeIds,
          boardLabel: envelope.label,
          boardSubtitle: envelope.subtitle,
          validCards: validation,
          invalidCards: [],
        },
      };
    }

    async function handleRequest(method, bodyText) {
      if (String(method || 'GET').toUpperCase() !== 'POST') {
        return createErrorEnvelope(405, 'Method not allowed');
      }

      var body = parseJsonBodyOrEmpty(bodyText);
      var subcommand = normalizeOptionalString(body.subcommand);
      var args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};

      try {
        if (subcommand === 'list-boards') {
          var boards = (await Promise.resolve(lifecycle.list())).map(function (board) {
            return summarizeBoardForList(normalizeManagedBoardState(
              normalizeOptionalString(board && board.id) || 'unknown-board',
              { boardId: normalizeOptionalString(board && board.id) || 'unknown-board', board: board, layout: null }
            ).board);
          });
          return createHttpEnvelope(200, { status: 'success', data: { boards: boards } });
        }

        if (subcommand === 'get-board') {
          var getBoardState = await getRequiredState(args.boardId);
          return createHttpEnvelope(200, { status: 'success', data: { board: getBoardState.board } });
        }

        if (subcommand === 'get-layout') {
          var getLayoutState = await getRequiredState(args.boardId);
          return createHttpEnvelope(200, { status: 'success', data: { layout: summarizeBoardLayout(getLayoutState.layout) } });
        }

        if (subcommand === 'add-board') {
          var addBoardId = normalizeRequiredBoardId(args.boardId);
          var exists = await Promise.resolve(lifecycle.has(addBoardId));
          if (exists) {
            return createErrorEnvelope(400, "board '" + addBoardId + "' already exists");
          }
          var addRecord = args.record && typeof args.record === 'object' && !Array.isArray(args.record) ? cloneJsonValue(args.record) : null;
          if (!addRecord) {
            return createErrorEnvelope(400, 'args.record is required (object)');
          }
          addRecord.id = addBoardId;
          var addedState = await createState(addBoardId, { boardId: addBoardId, board: addRecord, layout: null });
          return createHttpEnvelope(200, { status: 'success', data: { board: summarizeBoardForList(addedState.board) } });
        }

        if (subcommand === 'describe-host-config') {
          if (!deps.hostBridge || typeof deps.hostBridge.DescribeHostConfigJson !== 'function') {
            return createErrorEnvelope(501, 'host config bridge is unavailable');
          }
          var describeArgs = readHostConfigArgs(args);
          var described = JSON.parse(deps.hostBridge.DescribeHostConfigJson(
            describeArgs.hostConfigPath,
            describeArgs.localFsConfigLoaderPath,
            describeArgs.templatesConfigPath,
            describeArgs.assistantRegistryPath,
            describeArgs.setupSingleAiWorkspaceScriptPath
          ));
          return createHttpEnvelope(200, { status: 'success', data: described });
        }

        if (subcommand === 'resolve-board-config') {
          if (!deps.hostBridge || typeof deps.hostBridge.ResolveBoardConfigJson !== 'function') {
            return createErrorEnvelope(501, 'host config bridge is unavailable');
          }
          var resolveBoardId = normalizeRequiredBoardId(args.boardId);
          var resolveRecord = args.record && typeof args.record === 'object' && !Array.isArray(args.record) ? cloneJsonValue(args.record) : null;
          if (!resolveRecord) {
            return createErrorEnvelope(400, 'args.record is required (object)');
          }
          var resolveArgs = readHostConfigArgs(args);
          var resolved = JSON.parse(deps.hostBridge.ResolveBoardConfigJson(
            resolveBoardId,
            JSON.stringify(resolveRecord),
            resolveArgs.hostConfigPath,
            resolveArgs.localFsConfigLoaderPath
          ));
          return createHttpEnvelope(200, { status: 'success', data: resolved });
        }

        if (subcommand === 'save-meta') {
          var metadata = args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata) ? cloneJsonValue(args.metadata) : null;
          if (!metadata) {
            return createErrorEnvelope(400, 'args.metadata is required (object)');
          }
          var saveMetaState = await getRequiredState(args.boardId);
          var updatedMetaBoard = await Promise.resolve(lifecycle.saveMeta(saveMetaState.boardId, metadata));
          if (!updatedMetaBoard) {
            return createErrorEnvelope(404, "board '" + saveMetaState.boardId + "' not found");
          }
          saveMetaState = normalizeManagedBoardState(saveMetaState.boardId, { boardId: saveMetaState.boardId, board: updatedMetaBoard, layout: saveMetaState.layout });
          return createHttpEnvelope(200, { status: 'success', data: { board: summarizeBoardForList(saveMetaState.board) } });
        }

        if (subcommand === 'save-layout') {
          var saveLayoutState = await getRequiredState(args.boardId);
          var layout = args.layout && typeof args.layout === 'object' && !Array.isArray(args.layout) ? cloneJsonValue(args.layout) : null;
          if (!layout) {
            return createErrorEnvelope(400, 'args.layout is required (object)');
          }
          await Promise.resolve(lifecycle.saveLayout(saveLayoutState.boardId, layout));
          saveLayoutState.layout = layout;
          return createHttpEnvelope(200, { status: 'success', data: { layout: summarizeBoardLayout(saveLayoutState.layout) } });
        }

        if (subcommand === 'save-board-record') {
          var saveRecordState = await getRequiredState(args.boardId);
          var saveRecord = args.record && typeof args.record === 'object' && !Array.isArray(args.record) ? cloneJsonValue(args.record) : null;
          if (!saveRecord) {
            return createErrorEnvelope(400, 'args.record is required (object)');
          }
          saveRecord.id = saveRecordState.boardId;
          var updatedRecordBoard = await Promise.resolve(lifecycle.saveRecord(saveRecordState.boardId, saveRecord));
          if (!updatedRecordBoard) {
            return createErrorEnvelope(404, "board '" + saveRecordState.boardId + "' not found");
          }
          saveRecordState = normalizeManagedBoardState(saveRecordState.boardId, { boardId: saveRecordState.boardId, board: updatedRecordBoard, layout: saveRecordState.layout });
          return createHttpEnvelope(200, { status: 'success', data: { board: summarizeBoardForList(saveRecordState.board) } });
        }

        if (subcommand === 'refresh-board') {
          var refreshState = await getRequiredState(args.boardId);
          requireActiveRuntimeBoard(refreshState.boardId, 409);
          return createHttpEnvelope(200, { status: 'success', data: { board: summarizeBoardForList(refreshState.board) } });
        }

        if (subcommand === 'setup-board-workspace') {
          if (!deps.hostBridge || typeof deps.hostBridge.SetupBoardWorkspace !== 'function') {
            return createErrorEnvelope(501, 'workspace setup bridge is unavailable');
          }
          var setupState = await getRequiredState(args.boardId);
          var setupArgs = readHostConfigArgs(args);
          deps.hostBridge.SetupBoardWorkspace(
            setupState.boardId,
            JSON.stringify(setupState.board),
            setupArgs.hostConfigPath,
            setupArgs.localFsConfigLoaderPath,
            setupArgs.setupSingleAiWorkspaceScriptPath
          );
          return createHttpEnvelope(200, { status: 'success', data: { board: summarizeBoardForList(setupState.board) } });
        }

        if (subcommand === 'deprecate-board') {
          var deprecateState = await getRequiredState(args.boardId);
          var archived = await Promise.resolve(lifecycle.deprecate(deprecateState.boardId));
          if (!archived || !archived.board) {
            return createErrorEnvelope(404, "board '" + deprecateState.boardId + "' not found");
          }
          var archivedState = normalizeManagedBoardState(deprecateState.boardId, {
            boardId: deprecateState.boardId,
            board: archived.board,
            layout: archived.layout,
          });
          return createHttpEnvelope(200, {
            status: 'success',
            data: {
              board: summarizeBoardForList(archivedState.board),
              archiveId: normalizeOptionalString(archived.archiveId),
              archiveRecordPath: normalizeOptionalString(archived.archiveRecordPath),
              archiveWorkspaceDir: normalizeOptionalString(archived.archiveWorkspaceDir),
            },
          });
        }

        if (subcommand === 'export-board') {
          var exportState = await getRequiredState(args.boardId);
          var payload = await buildBoardExport(exportState);
          return createHttpEnvelope(200, { status: 'success', data: { payload: payload } });
        }

        if (subcommand === 'preview-import-board') {
          var previewState = await getRequiredState(args.boardId);
          var previewEnvelope = parseBoardPayloadEnvelope(args.payload);
          if (!Array.isArray(previewEnvelope && previewEnvelope.cards)) {
            return createErrorEnvelope(400, 'args.payload must be a JSON array of cards or an object with a cards array');
          }
          var preview = await buildImportPreview(previewState, previewEnvelope, normalizeImportMode(args.mode));
          return createHttpEnvelope(200, { status: 'success', data: { preview: preview } });
        }

        if (subcommand === 'apply-import-board') {
          var importState = await getRequiredState(args.boardId);
          var importEnvelope = parseBoardPayloadEnvelope(args.payload);
          if (!Array.isArray(importEnvelope && importEnvelope.cards)) {
            return createErrorEnvelope(400, 'args.payload must be a JSON array of cards or an object with a cards array');
          }
          var result = await applyBoardImport(importState, importEnvelope, normalizeImportMode(args.mode), args.applyBoardMetadata === true);
          return createHttpEnvelope(200, { status: 'success', data: result });
        }

        return createErrorEnvelope(400, "unknown subcommand '" + subcommand + "'");
      } catch (error) {
        var statusCode = error && Number(error.statusCode) > 0 ? Number(error.statusCode) : 500;
        if (error && error.validation) {
          return createHttpEnvelope(statusCode, {
            status: 'error',
            error: error && error.message ? error.message : String(error),
            data: { validation: error.validation },
          });
        }
        return createErrorEnvelope(statusCode, error && error.message ? error.message : String(error));
      }
    }

    return {
      handleRequest: handleRequest,
      summarizeBoardForList: summarizeBoardForList,
      summarizeBoardLayout: summarizeBoardLayout,
    };
  }

  function createSampleTemplateCatalogApi(deps) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('createSampleTemplateCatalogApi requires deps');
    }

    async function handleHttpTool(method, bodyText) {
      if (String(method || 'GET').toUpperCase() !== 'POST') {
        return createErrorEnvelope(405, 'Method not allowed');
      }

      try {
        var body = parseJsonBodyOrEmpty(bodyText);
        var tool = normalizeOptionalString(body.tool);
        var args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
        if (!tool) {
          return createErrorEnvelope(400, 'tool is required');
        }
        if (tool === 'explore.list-sample-templates') {
          return createHttpEnvelope(200, deps.listEntries());
        }
        if (tool === 'explore.get-sample-template') {
          return createHttpEnvelope(200, deps.getEnvelope(args.key));
        }
        return createErrorEnvelope(400, "unknown mcp-extras tool '" + tool + "'");
      } catch (error) {
        return createErrorEnvelope(500, error && error.message ? error.message : String(error));
      }
    }

    return {
      handleHttpTool: handleHttpTool,
    };
  }

  global.ControlfaceEmbeddedShared = {
    createManagedBoardLifecycle: createManagedBoardLifecycle,
    createManagedBoardsApi: createManagedBoardsApi,
    createSampleTemplateCatalogApi: createSampleTemplateCatalogApi,
    summarizeBoardForList: summarizeBoardForList,
    summarizeBoardLayout: summarizeBoardLayout,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);