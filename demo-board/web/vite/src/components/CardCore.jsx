import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

function buildUpstreamSignature(cardState) {
  return JSON.stringify({
    boardSseClientId: cardState.boardSseClientId ?? null,
    cardContent: cardState.cardContent ?? null,
    cardRuntime: cardState.cardRuntime ?? null,
  });
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

async function patchCardDataValue(cardActions, cardData, writeTo, value) {
  if (!cardActions?.patch) return;

  if (writeTo === 'card_data') {
    const nextCardData = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(cardData ?? {}), ...value }
      : value;
    if (deepEqual(cardData ?? {}, nextCardData)) return;
    await cardActions.patch({ card_data: nextCardData });
    return;
  }

  if (writeTo && writeTo.startsWith('card_data.')) {
    const fieldPath = writeTo.slice('card_data.'.length);
    const nextCardData = deepSet(cardData ?? {}, fieldPath, value);
    if (deepEqual(cardData ?? {}, nextCardData)) return;
    await cardActions.patch({ card_data: nextCardData });
  }
}

export function CardCore({ boardId, cardId }) {
  const cardState = useCardState(boardId, cardId);
  const [saving, setSaving] = useState(false);
  const pendingUpstreamSignatureRef = useRef(null);

  if (!cardState?.cardContent) return null;

  const card = cardState.cardContent;
  const view = card.view;
  if (!view?.elements?.length) return null;

  const cardActions = cardState.cardActions;
  const cardData = cardState.cardData;
  const cardFieldValues = cardState.cardContent?.fieldValues;
  const upstreamSignature = useMemo(() => buildUpstreamSignature(cardState), [
    cardState.boardSseClientId,
    cardState.cardContent,
    cardState.cardRuntime,
  ]);

  const namespaces = useMemo(() => buildNamespaces(boardId, cardState), [
    boardId,
    cardState.cardContent,
    cardState.cardData,
    cardState.requiresDataObjects,
    cardState.cardRuntime,
  ]);

  const layoutElements = useMemo(() => view.elements
    .filter((element) => {
      if (!element.visible) return true;
      return !!resolveBind(namespaces, element.visible);
    })
    .map((element, index) => normalizeLayoutElement(namespaces, element, index)), [namespaces, view.elements]);

  const fileUrlForIndex = useCallback((index, file) => buildFileUrl(boardId, cardId, index, file), [boardId, cardId]);

  useEffect(() => {
    if (!saving) return;
    if (!pendingUpstreamSignatureRef.current) return;
    if (upstreamSignature === pendingUpstreamSignatureRef.current) return;
    pendingUpstreamSignatureRef.current = null;
    setSaving(false);
  }, [saving, upstreamSignature]);

  const beginSaving = useCallback(() => {
    pendingUpstreamSignatureRef.current = upstreamSignature;
    setSaving(true);
  }, [upstreamSignature]);

  const handleSave = useCallback(async (value, meta = {}) => {
    if (!cardActions || saving) return;

    try {
      if (meta.kind === 'actions' && meta.buttonId) {
        beginSaving();
        await cardActions.dispatchAction?.('action', {
          buttonId: meta.buttonId,
          elemId: meta.elemId,
        });
        return;
      }

      const writeTo = meta.writeTo;
      if (writeTo === 'card_data' || (writeTo && writeTo.startsWith('card_data.'))) {
        const nextCardData = writeTo === 'card_data'
          ? (value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(cardData ?? {}), ...value }
            : value)
          : deepSet(cardData ?? {}, writeTo.slice('card_data.'.length), value);
        if (deepEqual(cardData ?? {}, nextCardData)) return;
        beginSaving();
        await patchCardDataValue(cardActions, cardData, writeTo, value);
        return;
      }

      if (meta.kind === 'notes') {
        if (deepEqual(cardData?.notes ?? '', value ?? '')) return;
        beginSaving();
        await cardActions.patch({ card_data: { ...(cardData ?? {}), notes: value } });
        return;
      }

      const currentValue = meta.renderDef?.resolvedWriteValue ?? cardFieldValues;
      if (deepEqual(currentValue, value)) return;

      beginSaving();
      await cardActions.patch({ fieldValues: value });
    } catch (error) {
      pendingUpstreamSignatureRef.current = null;
      setSaving(false);
      throw error;
    }
  }, [beginSaving, cardActions, cardData, cardFieldValues, saving]);

  const decoratedLayoutElements = useMemo(() => layoutElements.map(({ renderDef, ...layoutElement }) => ({
    ...layoutElement,
    renderDef: {
      ...renderDef,
      resolvedWriteValue: renderDef.data?.writeTo ? resolveBind(namespaces, renderDef.data.writeTo) : undefined,
      fileUrlForIndex,
    },
  })), [fileUrlForIndex, layoutElements, namespaces]);

  return (
    <div className="board-card-core position-relative" aria-busy={saving}>
      <div className="row g-2 align-content-start">
        {decoratedLayoutElements.map(({ reactKey, containerClassName, containerStyle, kind, renderDef, data }) => {
          return (
            <div
              key={reactKey}
              className={containerClassName}
              style={containerStyle ?? undefined}
            >
              <div className="w-100">
                <CardCoreView
                  kind={kind}
                  renderDef={renderDef}
                  data={data}
                  onSave={handleSave}
                />
              </div>
            </div>
          );
        })}
      </div>
      {saving ? (
        <div className="board-card-core__overlay" aria-hidden="true">
          <div className="board-card-core__overlay-spinner">
            <span className="spinner-border" role="status" aria-hidden="true" />
          </div>
        </div>
      ) : null}
    </div>
  );
}