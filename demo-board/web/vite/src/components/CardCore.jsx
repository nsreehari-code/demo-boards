import React from 'react';
import { SERVER } from '../lib/client.js';
import { useCardState } from '../hooks/useCardState.js';
import { CardCoreView } from './CardCoreView.jsx';

function pathParts(path) {
  if (!path || typeof path !== 'string') return [];
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

function deepGet(source, path) {
  if (!path || !source) return undefined;
  let current = source;
  for (const part of pathParts(path)) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function deepSet(target, path, value) {
  const parts = pathParts(path);
  if (!parts.length) return target;
  const next = Array.isArray(target) ? [...target] : { ...(target ?? {}) };
  let current = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const existing = current[part];
    current[part] = Array.isArray(existing) ? [...existing] : { ...(existing ?? {}) };
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return next;
}

function buildNamespaces(boardId, cardState) {
  return {
    boardId,
    card: cardState.cardContent ?? {},
    card_data: cardState.cardData ?? {},
    requires: cardState.requiresDataObjects ?? {},
    computed_values: cardState.cardRuntime?.computed_values ?? {},
    runtime_state: cardState.cardRuntime?.runtime ?? {},
  };
}

function resolveBind(namespaces, bind) {
  if (!bind || typeof bind !== 'string') return undefined;
  const parts = pathParts(bind);
  if (!parts.length) return undefined;

  const root = parts[0];
  const rest = parts.slice(1).join('.');

  if (!(root in namespaces)) return undefined;
  return rest ? deepGet(namespaces[root], rest) : namespaces[root];
}

function resolveRefKind(namespaces, element, initialData) {
  const viewRaw = element?.data?.viewBind ? resolveBind(namespaces, element.data.viewBind) : undefined;
  if (typeof viewRaw === 'string' && viewRaw) return viewRaw;
  if (viewRaw && typeof viewRaw === 'object' && !Array.isArray(viewRaw) && typeof viewRaw.kind === 'string') {
    return viewRaw.kind;
  }
  if (element?.data?.fallbackKind) return element.data.fallbackKind;
  if (Array.isArray(initialData)) return 'table';
  if (typeof initialData === 'string') return 'text';
  return 'narrative';
}

function normalizeElement(namespaces, element) {
  const baseData = element?.data?.bind ? resolveBind(namespaces, element.data.bind) : undefined;

  if (element?.kind !== 'ref') {
    return { kind: element.kind, renderDef: element, data: baseData };
  }

  const viewRaw = element?.data?.viewBind ? resolveBind(namespaces, element.data.viewBind) : undefined;
  const resolvedExtra = viewRaw && typeof viewRaw === 'object' && !Array.isArray(viewRaw)
    ? (viewRaw.data && typeof viewRaw.data === 'object' ? viewRaw.data : {})
    : {};

  const mergedData = { ...resolvedExtra, ...(element.data ?? {}) };
  delete mergedData.viewBind;
  delete mergedData.fallbackKind;

  if (!mergedData.bind && resolvedExtra.bind) mergedData.bind = resolvedExtra.bind;

  const effectiveData = mergedData.bind ? resolveBind(namespaces, mergedData.bind) : baseData;
  const resolvedKind = resolveRefKind(namespaces, element, effectiveData);

  return {
    kind: resolvedKind,
    renderDef: {
      ...element,
      kind: resolvedKind,
      data: mergedData,
    },
    data: effectiveData,
  };
}

function normalizeLayoutElement(namespaces, element, index) {
  const normalizedElement = normalizeElement(namespaces, element);
  const bindKey = normalizedElement.renderDef?.data?.bind ?? normalizedElement.renderDef?.data?.writeTo ?? null;
  const reactKey = normalizedElement.renderDef?.id
    ?? bindKey
    ?? normalizedElement.renderDef?.label
    ?? `${normalizedElement.kind}-${element?.className ?? 'col-12'}-${index}`;

  return {
    reactKey,
    containerClassName: element?.className ?? 'col-12',
    containerStyle: element?.containerStyle ?? null,
    kind: normalizedElement.kind,
    renderDef: normalizedElement.renderDef,
    data: normalizedElement.data,
  };
}

function buildFileUrl(boardId, cardId, index, file) {
  if (!file?.stored_name) return null;
  return `${SERVER}/api/boards/${boardId}/cards/${cardId}/files/${index}?sn=${encodeURIComponent(file.stored_name)}`;
}

async function patchCardDataValue(cardState, writeTo, value) {
  if (!cardState.cardActions?.patch) return;

  if (writeTo === 'card_data') {
    const nextCardData = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(cardState.cardData ?? {}), ...value }
      : value;
    await cardState.cardActions.patch({ card_data: nextCardData });
    return;
  }

  if (writeTo && writeTo.startsWith('card_data.')) {
    const fieldPath = writeTo.slice('card_data.'.length);
    const nextCardData = deepSet(cardState.cardData ?? {}, fieldPath, value);
    await cardState.cardActions.patch({ card_data: nextCardData });
  }
}

function buildSaveHandler(cardState) {
  return async function handleSave(value, meta = {}) {
    if (!cardState.cardActions) return;

    if (meta.kind === 'actions' && meta.buttonId) {
      await cardState.cardActions.dispatchAction?.('action', {
        buttonId: meta.buttonId,
        elemId: meta.elemId,
      });
      return;
    }

    const writeTo = meta.writeTo;
    if (writeTo === 'card_data' || (writeTo && writeTo.startsWith('card_data.'))) {
      await patchCardDataValue(cardState, writeTo, value);
      return;
    }

    if (meta.kind === 'notes') {
      await cardState.cardActions.patch({ card_data: { ...(cardState.cardData ?? {}), notes: value } });
      return;
    }

    await cardState.cardActions.patch({ fieldValues: value });
  };
}

export function CardCore({ boardId, cardId }) {
  const cardState = useCardState(boardId, cardId);

  if (!cardState?.cardContent) return null;

  const card = cardState.cardContent;
  const view = card.view;
  if (!view?.elements?.length) return null;

  const namespaces = buildNamespaces(boardId, cardState);

  const layoutElements = view.elements
    .filter((element) => {
      if (!element.visible) return true;
      return !!resolveBind(namespaces, element.visible);
    })
    .map((element, index) => normalizeLayoutElement(namespaces, element, index));

  const handleSave = buildSaveHandler(cardState);

  return (
    <div className="row g-2 align-content-start">
      {layoutElements.map(({ reactKey, containerClassName, containerStyle, kind, renderDef, data }) => {
        return (
          <div
            key={reactKey}
            className={containerClassName}
            style={containerStyle ?? undefined}
          >
            <div className="w-100">
              <CardCoreView
                kind={kind}
                renderDef={{
                  ...renderDef,
                  resolvedWriteValue: renderDef.data?.writeTo ? resolveBind(namespaces, renderDef.data.writeTo) : undefined,
                  fileUrlForIndex: (index, file) => buildFileUrl(boardId, cardId, index, file),
                }}
                data={data}
                onSave={handleSave}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}