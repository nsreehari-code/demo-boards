// board-runtime-shared.js
// Thin delegation layer — all implementations now live in BoardLiveCardsClient
// (yaml-flow >= 8.2.2). This file adapts the window.BoardRuntimeShared API
// surface that main-board.js and client-ui-wiring.js depend on.
(function () {
  var C = window.BoardLiveCardsClient;
  if (!C) {
    throw new Error('board-runtime-shared.js requires BoardLiveCardsClient to be loaded first');
  }

  window.BoardRuntimeShared = window.BoardRuntimeShared || {};
  window.BoardRuntimeShared.buildFileUrlBase    = C.buildFileUrlBase;
  window.BoardRuntimeShared.uploadCardFile      = C.uploadCardFile;
  window.BoardRuntimeShared.prepareActionPayload = C.prepareActionPayload;
  window.BoardRuntimeShared.patchCardState      = C.patchCardState;
  window.BoardRuntimeShared.dispatchCardAction  = C.dispatchCardAction;
})();