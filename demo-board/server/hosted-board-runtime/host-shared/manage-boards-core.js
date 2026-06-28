// Host-agnostic manage-boards orchestration shared by BOTH hosts:
//   * the Node hosted controlface server (http-mcp-controlface/controlface-server.js)
//   * the embedded WinUI V8 runtime (host-shared/controlface-embedded-shared.js)
//
// The goal is that "add a board" follows the SAME hosted path in both hosts:
//   ensure workspace -> provision a board runtime -> seed admin template cards.
//
// Everything host-specific (filesystem vs host-bridge storage, building a runtime,
// provisioning an AI workspace) is injected as an adapter. The orchestration and the
// admin-template seeding logic live here exactly once so the two hosts can never drift.
//
// Authored as a plain IIFE that attaches to globalThis (no import/export, no node deps)
// so it can be:
//   * executed verbatim inside ClearScript V8 (engine.Execute), and
//   * imported for side-effect from Node ESM (import './manage-boards-core.js') and then
//     read off globalThis.ManageBoardsCore.
(function (global) {
  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeTrimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // Returns the board's admin template cards (board.ui['admin-cards']), filtered to
  // plain-object entries. These are the cards (e.g. gandalf-intake) that must be seeded
  // into the board runtime as control-plane-only admin cards.
  function listAdminTemplateCards(board) {
    var ui = board && typeof board.ui === 'object' && board.ui ? board.ui : null;
    var cards = ui ? ui['admin-cards'] : null;
    return Array.isArray(cards)
      ? cards.filter(function (card) {
        return card && typeof card === 'object' && !Array.isArray(card);
      })
      : [];
  }

  // Flattens a template card's __private section into addressable dotted-key entries,
  // skipping the visible_controlplane_only flag (which is applied by the upsert tool
  // itself). Mirrors the original backend collectTemplatePrivateEntries semantics:
  // a parent object that is itself addressable is emitted BEFORE its nested entries.
  function collectTemplatePrivateEntries(templatePrivateSection, parentKey) {
    parentKey = parentKey || '';
    if (!isPlainObject(templatePrivateSection)) {
      return [];
    }

    var results = [];
    Object.keys(templatePrivateSection).forEach(function (rawKey) {
      var normalizedKey = normalizeTrimmedString(rawKey);
      if (!normalizedKey) {
        return;
      }
      if (normalizedKey === 'visible_controlplane_only') {
        return;
      }

      var value = templatePrivateSection[rawKey];
      var dottedKey = parentKey ? parentKey + '.' + normalizedKey : normalizedKey;
      var isAddressablePrivateKey = dottedKey.indexOf('.') !== -1;

      if (!isPlainObject(value)) {
        if (isAddressablePrivateKey) {
          results.push({ key: dottedKey, value: value });
        }
        return;
      }

      var nestedEntries = collectTemplatePrivateEntries(value, dottedKey);
      if (!isAddressablePrivateKey) {
        results = results.concat(nestedEntries);
        return;
      }

      results.push({ key: dottedKey, value: value });
      if (nestedEntries.length > 0) {
        results = results.concat(nestedEntries);
      }
    });
    return results;
  }

  // Applies a template card's private state (__private) onto a seeded card via the
  // setstate.card-private control-plane tool. invokeRuntimeTool is injected by the host
  // and routes the tool call into that board's runtime.
  async function applyTemplatePrivateState(params) {
    var boardId = params.boardId;
    var cardId = params.cardId;
    var card = params.card;
    var invokeRuntimeTool = params.invokeRuntimeTool;

    var templatePrivate = card ? card.__private : null;
    var entries = collectTemplatePrivateEntries(templatePrivate);
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      await invokeRuntimeTool(boardId, 'mcp-controlplane', {
        tool: 'setstate.card-private',
        args: {
          board_id: boardId,
          card_id: cardId,
          key: entry.key,
          value: entry.value,
        },
      });
    }
  }

  // Seeds every admin template card declared by the board's resolved UI template into
  // the board runtime, then applies each card's private state. invokeRuntimeTool(boardId,
  // routeKind, { tool, args }) is injected by the host.
  async function upsertAdminTemplateCards(params) {
    var board = params.board;
    var invokeRuntimeTool = params.invokeRuntimeTool;

    var boardId = normalizeTrimmedString(board && board.id);
    if (!boardId) {
      throw new Error('Board id is required to upsert admin template cards');
    }

    var cards = listAdminTemplateCards(board);
    for (var index = 0; index < cards.length; index += 1) {
      var card = cards[index];
      var cardId = normalizeTrimmedString(card && card.id);
      if (!cardId) {
        throw new Error("Admin template card for board '" + boardId + "' must have a non-empty string id");
      }

      await invokeRuntimeTool(boardId, 'mcp-controlplane', {
        tool: 'manage.admin-upsert-card',
        args: {
          board_id: boardId,
          card_id: cardId,
          candidate_card_content: card,
        },
      });

      await applyTemplatePrivateState({
        boardId: boardId,
        cardId: cardId,
        card: card,
        invokeRuntimeTool: invokeRuntimeTool,
      });
    }
  }

  // The shared "hosted path" for bringing a board's runtime up to a seeded state.
  // Used by add-board / save-board-record / reset-board on both hosts:
  //   1. ensure the board's AI workspace is ready (optional adapter)
  //   2. provision (build + register) the board runtime
  //   3. seed admin template cards into that runtime
  // Adapters:
  //   ensureWorkspace(board)            -> optional, may be omitted
  //   provisionRuntime(board)           -> returns the host's runtime entry handle
  //   invokeRuntimeTool(entry, boardId, routeKind, { tool, args }) -> routes into the runtime
  // Returns the provisioned runtime entry.
  async function provisionAndSeedBoard(params) {
    var board = params.board;
    var ensureWorkspace = params.ensureWorkspace;
    var provisionRuntime = params.provisionRuntime;
    var invokeRuntimeTool = params.invokeRuntimeTool;

    if (typeof provisionRuntime !== 'function') {
      throw new Error('provisionAndSeedBoard requires a provisionRuntime adapter');
    }
    if (typeof invokeRuntimeTool !== 'function') {
      throw new Error('provisionAndSeedBoard requires an invokeRuntimeTool adapter');
    }

    if (typeof ensureWorkspace === 'function') {
      await ensureWorkspace(board);
    }

    var runtimeEntry = await provisionRuntime(board);

    await upsertAdminTemplateCards({
      board: board,
      invokeRuntimeTool: function (boardId, routeKind, payload) {
        return invokeRuntimeTool(runtimeEntry, boardId, routeKind, payload);
      },
    });

    return runtimeEntry;
  }

  // Re-seeds admin template cards into an already-provisioned (active) board runtime.
  // Used by refresh-board, where the runtime already exists and only the admin cards
  // need to be re-applied.
  async function seedAdminCardsIntoRuntime(params) {
    var board = params.board;
    var runtimeEntry = params.runtimeEntry;
    var invokeRuntimeTool = params.invokeRuntimeTool;

    if (typeof invokeRuntimeTool !== 'function') {
      throw new Error('seedAdminCardsIntoRuntime requires an invokeRuntimeTool adapter');
    }

    await upsertAdminTemplateCards({
      board: board,
      invokeRuntimeTool: function (boardId, routeKind, payload) {
        return invokeRuntimeTool(runtimeEntry, boardId, routeKind, payload);
      },
    });
  }

  global.ManageBoardsCore = {
    isPlainObject: isPlainObject,
    listAdminTemplateCards: listAdminTemplateCards,
    collectTemplatePrivateEntries: collectTemplatePrivateEntries,
    applyTemplatePrivateState: applyTemplatePrivateState,
    upsertAdminTemplateCards: upsertAdminTemplateCards,
    provisionAndSeedBoard: provisionAndSeedBoard,
    seedAdminCardsIntoRuntime: seedAdminCardsIntoRuntime,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
