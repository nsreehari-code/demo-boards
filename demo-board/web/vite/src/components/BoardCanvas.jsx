import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { CardShell } from './CardShell.jsx';

const NODE_WIDTH = 360;
const COLUMN_GAP = 420;
const ROW_GAP = 280;
const STORAGE_VERSION = 1;
const EDGE_CURVATURE_SUBTLE = 0.26;
const EDGE_CURVATURE_BASE = 0.46;
const EDGE_CURVATURE_DRAMATIC = 0.68;

function storageKeyForBoard(boardId) {
  return `demo-board.canvas.${boardId}`;
}

function readCanvasState(boardId) {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKeyForBoard(boardId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCanvasState(boardId, payload) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(storageKeyForBoard(boardId), JSON.stringify({
      version: STORAGE_VERSION,
      ...payload,
    }));
  } catch {
    // Ignore localStorage failures.
  }
}

function sameCardSet(savedCardIds, cardIds) {
  if (!Array.isArray(savedCardIds) || savedCardIds.length !== cardIds.length) {
    return false;
  }

  const left = [...savedCardIds].sort();
  const right = [...cardIds].sort();
  return left.every((cardId, index) => cardId === right[index]);
}

function tokenHandleId(kind, token) {
  return `${kind}:${token}`;
}

function getStatusTone(status) {
  switch (status) {
    case 'completed':
      return 'board-tone--completed';
    case 'running':
      return 'board-tone--running';
    case 'failed':
      return 'board-tone--failed';
    case 'blocked':
      return 'board-tone--blocked';
    default:
      return 'board-tone--fresh';
  }
}

function uniqueTokens(tokens = []) {
  return [...new Set((Array.isArray(tokens) ? tokens : []).filter(Boolean).map(String))];
}

function resolveRequiredTokens(card) {
  if (Array.isArray(card?.requires)) {
    return uniqueTokens(card.requires);
  }
  if (card?.requires && typeof card.requires === 'object') {
    return uniqueTokens(Object.keys(card.requires));
  }
  return [];
}

function resolveProvidedTokens(card) {
  const provideDefs = Array.isArray(card?.provides) ? card.provides : [];
  const explicitTokens = provideDefs.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }
    if (entry && typeof entry === 'object' && typeof entry.bindTo === 'string') {
      return entry.bindTo;
    }
    return null;
  });

  return uniqueTokens(explicitTokens);
}

function resolveCanvasPosition(card) {
  const canvasLayout = card?.view?.layout?.canvas;
  if (!canvasLayout || typeof canvasLayout !== 'object') {
    return null;
  }
  const x = Number(canvasLayout.x);
  const y = Number(canvasLayout.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function buildGraph(cardIds, board) {
  const visibleIds = new Set(cardIds);
  const cards = {};
  const tokenProviders = new Map();

  for (const cardId of cardIds) {
    const card = board.cardContents[cardId] ?? {};
    const status = board.cardRuntimes[cardId]?.status ?? 'fresh';
    const requires = resolveRequiredTokens(card);
    const provides = resolveProvidedTokens(card);
    const providesActive = provides.filter((token) => token in (board.dataObjects ?? {}));

    cards[cardId] = {
      id: cardId,
      title: card.meta?.title ?? cardId,
      status,
      requires,
      provides,
      providesActive,
    };

    for (const token of provides) {
      const providers = tokenProviders.get(token) ?? [];
      providers.push(cardId);
      tokenProviders.set(token, providers);
    }
  }

  const edges = [];
  const incoming = new Map(cardIds.map((cardId) => [cardId, new Set()]));
  const outgoing = new Map(cardIds.map((cardId) => [cardId, new Set()]));

  for (const cardId of cardIds) {
    const card = cards[cardId];
    for (const token of card.requires) {
      const providers = tokenProviders.get(token) ?? [];
      for (const sourceId of providers) {
        if (sourceId === cardId || !visibleIds.has(sourceId)) {
          continue;
        }
        const isRunningEdge = card.status === 'running';
        edges.push({
          id: `${sourceId}::${cardId}::${token}`,
          source: sourceId,
          target: cardId,
          sourceHandle: tokenHandleId('provide', token),
          targetHandle: tokenHandleId('require', token),
          label: token,
          data: { token, isRunning: isRunningEdge },
          type: 'leaderLine',
          animated: isRunningEdge,
          className: 'board-flow__edge',
        });
        incoming.get(cardId)?.add(sourceId);
        outgoing.get(sourceId)?.add(cardId);
      }
    }
  }

  return { cards, edges, incoming, outgoing };
}

function buildLayout(cardIds, incoming, outgoing) {
  if (cardIds.length === 0) {
    return new Map();
  }

  const indegree = new Map(cardIds.map((cardId) => [cardId, incoming.get(cardId)?.size ?? 0]));
  const depth = new Map(cardIds.map((cardId) => [cardId, 0]));
  const queue = cardIds.filter((cardId) => (indegree.get(cardId) ?? 0) === 0);
  const visited = new Set();

  while (queue.length > 0) {
    const cardId = queue.shift();
    visited.add(cardId);
    const nextDepth = (depth.get(cardId) ?? 0) + 1;
    for (const nextId of outgoing.get(cardId) ?? []) {
      depth.set(nextId, Math.max(depth.get(nextId) ?? 0, nextDepth));
      const remaining = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, remaining);
      if (remaining === 0) {
        queue.push(nextId);
      }
    }
  }

  for (const cardId of cardIds) {
    if (!visited.has(cardId)) {
      depth.set(cardId, depth.get(cardId) ?? 0);
    }
  }

  const columns = new Map();
  for (const cardId of cardIds) {
    const column = depth.get(cardId) ?? 0;
    const columnCards = columns.get(column) ?? [];
    columnCards.push(cardId);
    columns.set(column, columnCards);
  }

  const positions = new Map();
  const orderedColumns = [...columns.entries()].sort((left, right) => left[0] - right[0]);
  for (const [column, columnCards] of orderedColumns) {
    columnCards.sort();
    columnCards.forEach((cardId, index) => {
      positions.set(cardId, {
        x: column * COLUMN_GAP,
        y: index * ROW_GAP,
      });
    });
  }

  return positions;
}

function sameStringArray(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function sameNodeView(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.id === right.id
    && left.type === right.type
    && left.position?.x === right.position?.x
    && left.position?.y === right.position?.y
    && left.style?.width === right.style?.width
    && left.data?.boardId === right.data?.boardId
    && left.data?.status === right.data?.status
    && left.data?.title === right.data?.title
    && left.data?.selectedToken === right.data?.selectedToken
    && left.data?.isHighlighted === right.data?.isHighlighted
    && left.data?.isDimmed === right.data?.isDimmed
    && left.data?.onTokenToggle === right.data?.onTokenToggle
    && sameStringArray(left.data?.provides, right.data?.provides)
    && sameStringArray(left.data?.providedTokens, right.data?.providedTokens)
    && sameStringArray(left.data?.availableTokens, right.data?.availableTokens)
    && sameStringArray(left.data?.requires, right.data?.requires);
}

function resolveLeaderCurve(sourceX, sourceY, targetX, targetY, emphasis = 'base') {
  const horizontalDistance = Math.abs(targetX - sourceX);
  const verticalDistance = Math.abs(targetY - sourceY);

  if (horizontalDistance < 180 && verticalDistance < 120) {
    return EDGE_CURVATURE_SUBTLE;
  }

  if (horizontalDistance > 520 || verticalDistance > 320) {
    return emphasis === 'dramatic' ? EDGE_CURVATURE_DRAMATIC : 0.58;
  }

  return emphasis === 'dramatic' ? 0.58 : EDGE_CURVATURE_BASE;
}

function LeaderLineEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  className,
  data,
  style,
}) {
  const isHighlighted = className?.includes('is-highlighted');
  const isDimmed = className?.includes('is-dimmed');
  const isRunning = Boolean(data?.isRunning);
  const curvature = resolveLeaderCurve(
    sourceX,
    sourceY,
    targetX,
    targetY,
    isHighlighted || isRunning ? 'dramatic' : 'base',
  );
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature,
  });
  const baseStrokeColor = 'rgba(83, 133, 137, 0.58)';
  const highlightStrokeColor = 'rgba(71, 122, 136, 0.78)';
  const dimStrokeColor = 'rgba(83, 133, 137, 0.2)';
  const strokeColor = isHighlighted
    ? highlightStrokeColor
    : isDimmed
      ? dimStrokeColor
      : baseStrokeColor;
  const flowColor = isHighlighted ? 'rgba(146, 208, 213, 0.86)' : 'rgba(166, 216, 220, 0.74)';
  const plugMarkerId = `${id}-plug`;
  const endPlugMarkerId = `${id}-end-plug`;
  const mainStrokeWidth = isHighlighted ? 2.4 : 1.7;

  return (
    <>
      <defs>
        <marker
          id={plugMarkerId}
          viewBox="0 0 10 10"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="5"
        >
          <circle cx="5" cy="5" r="3" fill={strokeColor} />
        </marker>
        <marker
          id={endPlugMarkerId}
          viewBox="0 0 12 12"
          markerWidth="8.5"
          markerHeight="8.5"
          refX="6"
          refY="6"
          orient="auto-start-reverse"
        >
          <circle cx="6" cy="6" r="3.9" fill={strokeColor} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        className="board-flow__edge-main"
        markerStart={`url(#${plugMarkerId})`}
        markerEnd={markerEnd ?? `url(#${endPlugMarkerId})`}
        style={{
          ...style,
          stroke: strokeColor,
          strokeWidth: mainStrokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }}
      />
      {isRunning ? (
        <BaseEdge
          id={`${id}-flow`}
          path={edgePath}
          className="board-flow__edge-flow"
          style={{
            stroke: flowColor,
            strokeWidth: mainStrokeWidth + 0.35,
          }}
        />
      ) : null}
    </>
  );
}

function FlowCardNode({ id, data }) {
  const statusTone = getStatusTone(data.status);
  const isRunningCard = data.status === 'running';
  const requiresMissing = data.requires.filter((token) => !data.availableTokens.includes(token));
  const nodeTone = data.isDimmed ? ' is-dimmed' : data.isHighlighted ? ' is-highlighted' : '';

  const renderTokenGem = (token, variant, extraClassName = '') => {
    const active = data.selectedToken === token;
    const handleType = variant === 'provide' ? 'source' : 'target';
    const handlePosition = variant === 'provide' ? Position.Bottom : Position.Top;

    return (
      <div
        key={`${variant}-${id}-${token}`}
        className={`board-token-port board-token-port--${variant}`}
      >
        <Handle
          id={tokenHandleId(variant, token)}
          type={handleType}
          position={handlePosition}
          className={`board-flow-node__handle board-flow-node__handle--token board-flow-node__handle--${variant}`}
        />
        <button
          type="button"
          className={`board-token-gem board-token-gem--button board-token-gem--${variant}${extraClassName}${active ? ' is-selected' : ''}`}
          title={`${variant === 'provide' ? 'Provides' : 'Requires'} ${token}`}
          aria-label={`${variant === 'provide' ? 'Provides' : 'Requires'} ${token}`}
          onClick={() => data.onTokenToggle?.(token)}
        />
      </div>
    );
  };

  return (
    <div className={`board-flow-node ${statusTone}${nodeTone}`}>
      <div className="board-flow-node__tokens board-flow-node__tokens--top">
        {data.requires.length > 0 ? data.requires.map((token) => (
          renderTokenGem(
            token,
            'require',
            `${requiresMissing.includes(token) ? ' is-missing' : ''}${isRunningCard ? ' is-running' : ''}`,
          )
        )) : null}
      </div>
      <div className="board-flow-node__card">
        <CardShell boardId={data.boardId} cardId={id} />
      </div>
      <div className="board-flow-node__tokens board-flow-node__tokens--bottom">
        {data.provides.length > 0 ? data.provides.map((token) => (
          renderTokenGem(token, 'provide', data.providedTokens.includes(token) ? ' is-active' : '')
        )) : null}
      </div>
    </div>
  );
}

const nodeTypes = {
  boardCard: FlowCardNode,
};

const edgeTypes = {
  leaderLine: LeaderLineEdge,
};

function getMiniMapNodeColor(node) {
  return node?.data?.status === 'running' ? 'rgba(111, 192, 154, 0.92)' : 'rgba(125, 149, 171, 0.58)';
}

function getMiniMapNodeStrokeColor(node) {
  return node?.data?.status === 'running' ? 'rgba(34, 132, 93, 0.96)' : 'rgba(97, 122, 147, 0.34)';
}

function getMiniMapNodeClassName(node) {
  return node?.data?.status === 'running' ? 'is-running' : '';
}

export function BoardCanvas({ board, boardId, cardIds }) {
  const [selectedToken, setSelectedToken] = useState(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const persistedCanvasState = useMemo(() => readCanvasState(boardId), [boardId]);
  const canReusePersistedViewport = useMemo(
    () => sameCardSet(persistedCanvasState?.cardIds, cardIds),
    [cardIds, persistedCanvasState?.cardIds],
  );
  const hasRestoredViewportRef = useRef(false);
  const previousSelectedTokenRef = useRef(null);
  const graph = useMemo(() => buildGraph(cardIds, board), [board, cardIds]);
  const baseLayout = useMemo(() => buildLayout(cardIds, graph.incoming, graph.outgoing), [cardIds, graph.incoming, graph.outgoing]);
  const availableTokens = useMemo(() => Object.keys(board.dataObjects ?? {}), [board.dataObjects]);

  const highlightedEdgeIds = useMemo(() => {
    if (!selectedToken) {
      return new Set();
    }
    return new Set(
      graph.edges
        .filter((edge) => edge.data?.token === selectedToken)
        .map((edge) => edge.id),
    );
  }, [graph.edges, selectedToken]);

  const highlightedNodeIds = useMemo(() => {
    if (!selectedToken) {
      return new Set();
    }

    return new Set(cardIds.filter((cardId) => {
      const card = graph.cards[cardId];
      return card?.requires.includes(selectedToken) || card?.provides.includes(selectedToken);
    }));
  }, [cardIds, graph.cards, selectedToken]);

  const handleTokenToggle = useCallback((token) => {
    setSelectedToken((currentToken) => (currentToken === token ? null : token));
  }, []);

  const persistNodes = useCallback((nextNodes, viewport = null) => {
    const positions = Object.fromEntries(nextNodes.map((node) => [node.id, node.position]));
    writeCanvasState(boardId, {
      cardIds: nextNodes.map((node) => node.id),
      positions,
      viewport,
    });
  }, [boardId]);

  const graphNodes = useMemo(() => cardIds.map((cardId) => ({
    id: cardId,
    type: 'boardCard',
    position: canReusePersistedViewport ? persistedCanvasState?.positions?.[cardId] : null
      ?? resolveCanvasPosition(board.cardContents[cardId])
      ?? baseLayout.get(cardId)
      ?? { x: 0, y: 0 },
    draggable: true,
    data: {
      boardId,
      status: graph.cards[cardId]?.status ?? 'fresh',
      provides: graph.cards[cardId]?.provides ?? [],
      providedTokens: graph.cards[cardId]?.providesActive ?? [],
      availableTokens,
      requires: graph.cards[cardId]?.requires ?? [],
      title: graph.cards[cardId]?.title ?? cardId,
      selectedToken,
      onTokenToggle: handleTokenToggle,
      isHighlighted: !selectedToken || highlightedNodeIds.has(cardId),
      isDimmed: !!selectedToken && !highlightedNodeIds.has(cardId),
    },
    style: { width: NODE_WIDTH },
  })), [availableTokens, baseLayout, board.cardContents, boardId, canReusePersistedViewport, cardIds, graph.cards, handleTokenToggle, highlightedNodeIds, persistedCanvasState?.positions, selectedToken]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes((currentNodes) => {
      const positionsById = new Map(currentNodes.map((node) => [node.id, node.position]));
      const nextNodes = graphNodes.map((node) => ({
        ...node,
        position: positionsById.get(node.id) ?? node.position,
      }));

      if (currentNodes.length === nextNodes.length && currentNodes.every((node, index) => sameNodeView(node, nextNodes[index]))) {
        return currentNodes;
      }

      return nextNodes;
    });
  }, [graphNodes, setNodes]);

  useEffect(() => {
    if (!nodes.length) {
      return;
    }
    const viewport = reactFlowInstance?.getViewport?.() ?? (canReusePersistedViewport ? persistedCanvasState?.viewport : null) ?? null;
    persistNodes(nodes, viewport);
  }, [canReusePersistedViewport, nodes, persistNodes, reactFlowInstance, persistedCanvasState?.viewport]);

  useEffect(() => {
    setEdges(graph.edges.map((edge) => ({
      ...edge,
      className: [
        'board-flow__edge',
        selectedToken ? (highlightedEdgeIds.has(edge.id) ? 'is-highlighted' : 'is-dimmed') : '',
      ].filter(Boolean).join(' '),
    })));
  }, [graph.edges, highlightedEdgeIds, selectedToken, setEdges]);

  useEffect(() => {
    if (!reactFlowInstance || nodes.length === 0) {
      return undefined;
    }

    if (!hasRestoredViewportRef.current) {
      hasRestoredViewportRef.current = true;
      previousSelectedTokenRef.current = selectedToken;

      const frameId = window.requestAnimationFrame(() => {
        if (canReusePersistedViewport && persistedCanvasState?.viewport) {
          reactFlowInstance.setViewport(persistedCanvasState.viewport, { duration: 0 });
          return;
        }

        reactFlowInstance.fitView({
          nodes,
          duration: 0,
          padding: 0.18,
          minZoom: 0.35,
          maxZoom: 1.08,
        });
      });

      return () => window.cancelAnimationFrame(frameId);
    }

    if (previousSelectedTokenRef.current === selectedToken) {
      return undefined;
    }

    previousSelectedTokenRef.current = selectedToken;

    const focusedNodeIds = selectedToken ? [...highlightedNodeIds] : cardIds;
    const focusedNodes = nodes.filter((node) => focusedNodeIds.includes(node.id));

    if (focusedNodes.length === 0) {
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      reactFlowInstance.fitView({
        nodes: focusedNodes,
        duration: 280,
        padding: selectedToken ? 0.3 : 0.18,
        minZoom: selectedToken ? 0.5 : 0.35,
        maxZoom: 1.08,
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [canReusePersistedViewport, cardIds, highlightedNodeIds, nodes, persistedCanvasState?.viewport, reactFlowInstance, selectedToken]);

  const handleMoveEnd = useCallback((_event, viewport) => {
    writeCanvasState(boardId, {
      cardIds: nodes.map((node) => node.id),
      positions: Object.fromEntries(nodes.map((node) => [node.id, node.position])),
      viewport,
    });
  }, [boardId, nodes]);

  const handleNodeDragStop = useCallback(() => {
    const viewport = reactFlowInstance?.getViewport?.() ?? null;
    persistNodes(nodes, viewport);
  }, [nodes, persistNodes, reactFlowInstance]);

  return (
    <div className="board-centre-canvas__viewport">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        minZoom={0.24}
        maxZoom={1.35}
        defaultEdgeOptions={{
          type: 'leaderLine',
          style: { stroke: 'var(--color-accent)', strokeWidth: 1.5 },
        }}
        proOptions={{ hideAttribution: true }}
        className="board-react-flow"
        panOnScroll
        selectionOnDrag
        onInit={setReactFlowInstance}
        onMoveEnd={handleMoveEnd}
        onNodeDragStop={handleNodeDragStop}
      >
        {selectedToken ? (
          <div className="board-canvas-token-banner">
            <span className="board-canvas-token-banner__label">Token focus</span>
            <button type="button" className="board-token-gem board-token-gem--button is-selected" onClick={() => setSelectedToken(null)}>
              {selectedToken}
              <span className="board-canvas-token-banner__dismiss">×</span>
            </button>
          </div>
        ) : null}
        <MiniMap
          pannable
          zoomable
          className="board-react-flow__minimap"
          nodeColor={getMiniMapNodeColor}
          nodeStrokeColor={getMiniMapNodeStrokeColor}
          nodeStrokeWidth={1.5}
          nodeClassName={getMiniMapNodeClassName}
        />
        <Controls className="board-react-flow__controls" showInteractive={false} />
        <Background gap={24} size={1.1} color="var(--color-border-strong)" className="board-react-flow__background" />
      </ReactFlow>
    </div>
  );
}