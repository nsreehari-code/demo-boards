import React, { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import { CardShell } from './CardShell.jsx';

const NODE_WIDTH = 360;
const COLUMN_GAP = 420;
const ROW_GAP = 280;

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

function buildGraph(cardIds, board) {
  const visibleIds = new Set(cardIds);
  const cards = {};
  const tokenProviders = new Map();

  for (const cardId of cardIds) {
    const card = board.cardContents[cardId] ?? {};
    const status = board.cardRuntimes[cardId]?.status ?? 'fresh';
    const requires = uniqueTokens(card.requires);
    const provides = uniqueTokens(card.provides ?? card.provides_declared);
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
        edges.push({
          id: `${sourceId}::${cardId}::${token}`,
          source: sourceId,
          target: cardId,
          label: token,
          data: { token },
          type: 'smoothstep',
          animated: cards[sourceId].status === 'running' || card.status === 'running',
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

function FlowCardNode({ id, data }) {
  const statusTone = getStatusTone(data.status);
  const requiresMissing = data.requires.filter((token) => !data.availableTokens.includes(token));

  return (
    <div className={`board-flow-node ${statusTone}`}>
      <Handle type="target" position={Position.Left} className="board-flow-node__handle" />
      <div className="board-flow-node__tokens board-flow-node__tokens--top">
        {data.provides.length > 0 ? data.provides.map((token) => (
          <span
            key={`provide-${id}-${token}`}
            className={`board-token-gem board-token-gem--provide${data.providedTokens.includes(token) ? ' is-active' : ''}`}
            title={`Provides ${token}`}
          >
            {token}
          </span>
        )) : <span className="board-token-gem board-token-gem--muted">source</span>}
      </div>
      <div className="board-flow-node__card">
        <CardShell boardId={data.boardId} cardId={id} />
      </div>
      <div className="board-flow-node__tokens board-flow-node__tokens--bottom">
        {data.requires.length > 0 ? data.requires.map((token) => (
          <span
            key={`require-${id}-${token}`}
            className={`board-token-gem board-token-gem--require${requiresMissing.includes(token) ? ' is-missing' : ''}`}
            title={`Requires ${token}`}
          >
            {token}
          </span>
        )) : <span className="board-token-gem board-token-gem--muted">entry</span>}
      </div>
      <Handle type="source" position={Position.Right} className="board-flow-node__handle" />
    </div>
  );
}

const nodeTypes = {
  boardCard: FlowCardNode,
};

export function BoardCanvas({ board, boardId, cardIds }) {
  const graph = useMemo(() => buildGraph(cardIds, board), [board, cardIds]);
  const baseLayout = useMemo(() => buildLayout(cardIds, graph.incoming, graph.outgoing), [cardIds, graph.incoming, graph.outgoing]);

  const initialNodes = useMemo(() => cardIds.map((cardId) => ({
    id: cardId,
    type: 'boardCard',
    position: baseLayout.get(cardId) ?? { x: 0, y: 0 },
    draggable: true,
    data: {
      boardId,
      status: graph.cards[cardId]?.status ?? 'fresh',
      provides: graph.cards[cardId]?.provides ?? [],
      providedTokens: graph.cards[cardId]?.providesActive ?? [],
      availableTokens: Object.keys(board.dataObjects ?? {}),
      requires: graph.cards[cardId]?.requires ?? [],
      title: graph.cards[cardId]?.title ?? cardId,
    },
    style: { width: NODE_WIDTH },
  })), [baseLayout, boardId, cardIds, graph.cards]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes((currentNodes) => {
      const positionsById = new Map(currentNodes.map((node) => [node.id, node.position]));
      return initialNodes.map((node) => ({
        ...node,
        position: positionsById.get(node.id) ?? node.position,
      }));
    });
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(graph.edges);
  }, [graph.edges, setEdges]);

  return (
    <div className="board-centre-canvas__viewport">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        fitViewOptions={{ padding: 0.14, minZoom: 0.4 }}
        minZoom={0.24}
        maxZoom={1.35}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { stroke: 'var(--color-accent)', strokeWidth: 1.5 },
          labelStyle: { fill: 'var(--color-text-soft)', fontSize: 11, fontWeight: 700 },
        }}
        proOptions={{ hideAttribution: true }}
        className="board-react-flow"
        panOnScroll
        selectionOnDrag
      >
        <MiniMap pannable zoomable className="board-react-flow__minimap" />
        <Controls className="board-react-flow__controls" showInteractive={false} />
        <Background gap={24} size={1.1} color="var(--color-border-strong)" className="board-react-flow__background" />
      </ReactFlow>
    </div>
  );
}