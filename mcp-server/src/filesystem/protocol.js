function optionalString(value) {
  return value === undefined || value === null ? undefined : String(value);
}

async function dispatchBlob(storage, operation, args) {
  switch (operation) {
    case 'read': return storage.read(String(args[0]));
    case 'write': return storage.write(String(args[0]), String(args[1]));
    case 'exists': return storage.exists(String(args[0]));
    case 'remove': return storage.remove(String(args[0]));
    case 'listKeys': return storage.listKeys(optionalString(args[0]));
    case 'renameKey': return storage.renameKey(String(args[0]), String(args[1]));
    case 'stat': return storage.stat(String(args[0]));
    case 'readBytes': {
      const value = await storage.readBytes(String(args[0]));
      return value ? Buffer.from(value).toString('base64') : null;
    }
    case 'writeBytes': return storage.writeBytes(String(args[0]), Buffer.from(String(args[1]), 'base64'));
    default: throw new Error(`Unsupported blob operation: ${operation}`);
  }
}

async function dispatchJournal(storage, operation, args) {
  switch (operation) {
    case 'append': return storage.append(args[0]);
    case 'readAll': return storage.readAll();
    case 'readAfter': return storage.readAfter(args[0] === null ? null : String(args[0]));
    case 'clear': return storage.clear();
    default: throw new Error(`Unsupported journal operation: ${operation}`);
  }
}

export function createFilesystemStorageDispatcher(storage) {
  const lockTokens = new Map();
  const transitionTokens = new Map();
  const runtimeStateKey = '__gik_runtime_state__';

  function runtimeRefs(request) {
    for (const name of ['stateRef', 'effectsQueueRef']) {
      if (typeof request?.[name] !== 'string' || !request[name]) {
        throw new Error(`${name} must be a non-empty string.`);
      }
    }
    const stateNamespace = storage.namespaceForRef(request.stateRef);
    const effectsNamespace = storage.namespaceForRef(request.effectsQueueRef);
    if (stateNamespace !== effectsNamespace) {
      throw new Error('Filesystem transitions require stateRef and effectsQueueRef to use the same namespace.');
    }
    return {
      stateRef: request.stateRef,
      effectsQueueRef: request.effectsQueueRef,
      effectsLane: optionalString(request.effectsLane),
    };
  }

  function transitionRefs(request) {
    if (typeof request?.journalRef !== 'string' || !request.journalRef) {
      throw new Error('journalRef must be a non-empty string.');
    }
    return { ...runtimeRefs(request), journalRef: request.journalRef };
  }

  function refsKey(refs) {
    return JSON.stringify(refs);
  }

  async function releaseTransition(token) {
    const held = transitionTokens.get(token);
    if (!held) return false;
    transitionTokens.delete(token);
    clearTimeout(held.timer);
    await held.release();
    return true;
  }

  async function initializeRuntime(request) {
    const refs = runtimeRefs(request);
    if (typeof request.kernelId !== 'string' || !request.kernelId) {
      throw new Error('kernelId must be a non-empty string.');
    }
    if (!Object.prototype.hasOwnProperty.call(request, 'initialState')) {
      throw new Error('initialState is required.');
    }
    const release = await storage.lockForRef(refs.stateRef).tryAcquire();
    if (!release) throw new Error('Runtime is busy.');
    try {
      const stateStorage = storage.kvStorageForRef(refs.stateRef);
      const current = await stateStorage.read(runtimeStateKey);
      if (current) {
        if (current.kernelId !== request.kernelId) {
          throw new Error(`Runtime state belongs to kernel ${current.kernelId}, not ${request.kernelId}.`);
        }
        return { created: false, revision: current.revision };
      }
      const revision = crypto.randomUUID();
      await stateStorage.write(runtimeStateKey, {
        kernelId: request.kernelId,
        revision,
        cursor: null,
        state: request.initialState,
      });
      return { created: true, revision };
    } finally {
      await release();
    }
  }

  async function acquireTransition(request) {
    const refs = transitionRefs(request);
    if (typeof request.kernelId !== 'string' || !request.kernelId) {
      throw new Error('kernelId must be a non-empty string.');
    }
    const release = await storage.lockForRef(refs.stateRef).tryAcquire();
    if (!release) return null;

    const leaseMs = Number.isInteger(request.leaseMs) && request.leaseMs > 0 ? request.leaseMs : 300_000;
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const timer = setTimeout(() => releaseTransition(leaseToken).catch(() => {}), leaseMs);
    timer.unref?.();
    transitionTokens.set(leaseToken, {
      refsKey: refsKey(refs),
      kernelId: request.kernelId,
      release,
      timer,
    });

    try {
      const persisted = await storage.kvStorageForRef(refs.stateRef).read(runtimeStateKey);
      if (!persisted) throw new Error('Runtime is not initialized.');
      if (persisted.kernelId !== request.kernelId) {
        throw new Error(`Runtime state belongs to kernel ${persisted.kernelId}, not ${request.kernelId}.`);
      }
      const cursor = persisted?.cursor ?? null;
      const journal = await storage.journalStorageForRef(refs.journalRef).readAfter(cursor);
      return {
        leaseToken,
        leaseExpiresAt,
        state: persisted.state,
        revision: persisted.revision,
        cursor,
        entries: journal.entries,
      };
    } catch (error) {
      await releaseTransition(leaseToken);
      throw error;
    }
  }

  async function commitTransition(request) {
    const refs = transitionRefs(request);
    const held = transitionTokens.get(request.leaseToken);
    if (!held || held.refsKey !== refsKey(refs) || held.kernelId !== request.kernelId) {
      return { ok: false, reason: 'lease-lost', revision: null };
    }
    try {
      const stateStorage = storage.kvStorageForRef(refs.stateRef);
      const current = await stateStorage.read(runtimeStateKey);
      const revision = current?.revision ?? null;
      if (revision !== request.expectedRevision || (current?.cursor ?? null) !== request.previousCursor) {
        return { ok: false, reason: 'conflict', revision };
      }
      if (!Array.isArray(request.effects)) throw new Error('effects must be an array.');
      const queue = storage.queueStorageForRef(refs.effectsQueueRef, refs.effectsLane);
      const staged = [];
      try {
        for (const effect of request.effects) staged.push(await queue.stage(effect));
        const nextRevision = crypto.randomUUID();
        await stateStorage.write(runtimeStateKey, {
          kernelId: request.kernelId,
          revision: nextRevision,
          cursor: String(request.nextCursor),
          state: request.state ?? null,
        });
        for (const message of staged) await queue.commitStaged(message.id);
        return { ok: true, revision: nextRevision };
      } catch (error) {
        for (const message of staged) await queue.discardStaged(message.id, 'transition commit failed').catch(() => false);
        throw error;
      }
    } finally {
      await releaseTransition(request.leaseToken);
    }
  }

  async function abortTransition(request) {
    const refs = transitionRefs(request);
    const held = transitionTokens.get(request.leaseToken);
    if (!held || held.refsKey !== refsKey(refs) || held.kernelId !== request.kernelId) return false;
    return releaseTransition(request.leaseToken);
  }

  async function dispatch(request) {
    if (!request || typeof request.ref !== 'string' || typeof request.operation !== 'string') {
      throw new Error('Storage request requires ref, capability, and operation.');
    }
    const args = Array.isArray(request.args) ? request.args : [];
    switch (request.capability) {
      case 'kv': {
        const target = storage.kvStorageForRef(request.ref);
        switch (request.operation) {
          case 'read': return target.read(String(args[0]));
          case 'write': return target.write(String(args[0]), args[1]);
          case 'delete': return target.delete(String(args[0]));
          case 'listKeys': return target.listKeys(optionalString(args[0]));
          default: throw new Error(`Unsupported KV operation: ${request.operation}`);
        }
      }
      case 'json': {
        const target = storage.jsonStorageForRef(request.ref);
        switch (request.operation) {
          case 'read': return target.read(String(args[0]));
          case 'write': return target.write(String(args[0]), args[1]);
          case 'delete': return target.delete(String(args[0]));
          case 'listKeys': return target.listKeys(optionalString(args[0]));
          case 'get': return target.get(String(args[0]), String(args[1]));
          case 'shallowMerge': return target.shallowMerge(String(args[0]), args[1]);
          case 'deepMerge': return target.deepMerge(String(args[0]), args[1]);
          case 'patch': return target.patch(String(args[0]), String(args[1]), args[2]);
          default: throw new Error(`Unsupported JSON operation: ${request.operation}`);
        }
      }
      case 'blob': return dispatchBlob(storage.blobStorageForRef(request.ref), request.operation, args);
      case 'journal': return dispatchJournal(storage.journalStorageForRef(request.ref), request.operation, args);
      case 'queue': {
        const target = storage.queueStorageForRef(request.ref, request.lane);
        switch (request.operation) {
          case 'enqueue': return target.enqueue(args[0]);
          case 'enqueueMany': return target.enqueueMany(args[0]);
          case 'enqueueIfAbsent': return target.enqueueIfAbsent(args[0], String(args[1]));
          case 'lease': return target.lease(args[0]);
          case 'ack': return target.ack(String(args[0]), String(args[1]));
          case 'nack': return target.nack(String(args[0]), String(args[1]), args[2]);
          case 'peekActive': return target.peekActive(optionalString(args[0]));
          case 'peekDeadLetter': return target.peekDeadLetter(optionalString(args[0]));
          case 'stage': return target.stage(args[0], args[1]);
          case 'commitStaged': return target.commitStaged(String(args[0]));
          case 'discardStaged': return target.discardStaged(String(args[0]), optionalString(args[1]));
          case 'peekStaged': return target.peekStaged(optionalString(args[0]));
          default: throw new Error(`Unsupported queue operation: ${request.operation}`);
        }
      }
      case 'lock': {
        if (request.operation === 'acquire') {
          const release = await storage.lockForRef(request.ref).tryAcquire();
          if (!release) return null;
          const token = crypto.randomUUID();
          lockTokens.set(token, { ref: request.ref, release });
          return token;
        }
        if (request.operation === 'release') {
          const token = String(args[0]);
          const held = lockTokens.get(token);
          if (!held || held.ref !== request.ref) return false;
          lockTokens.delete(token);
          await held.release();
          return true;
        }
        throw new Error(`Unsupported lock operation: ${request.operation}`);
      }
      case 'scratch': {
        const target = storage.scratchStorageForRef(request.ref);
        if (request.operation === 'getUniqueKey') return target.getUniqueKey(args[0], args[1]);
        if (request.operation === 'create') return target.create(String(args[0]), args[1], args[2]);
        if (request.operation === 'config.get') return target.config.get(String(args[0]));
        if (request.operation === 'config.set') return target.config.set(String(args[0]), args[1]);
        return dispatchBlob(target, request.operation, args);
      }
      case 'archive': {
        const target = storage.archiveFactoryForRef(request.ref);
        if (request.operation === 'listStreams') return target.listStreams(optionalString(args[0]));
        if (request.operation === 'listBlobs') return target.listBlobs(optionalString(args[0]));
        if (request.operation === 'config.get') return target.config.get(String(args[0]));
        if (request.operation === 'config.set') return target.config.set(String(args[0]), args[1]);
        if (!request.resource?.name) throw new Error('Archive operations require a named resource.');
        return request.resource.kind === 'stream'
          ? dispatchJournal(target.stream(request.resource.name), request.operation, args)
          : dispatchBlob(target.blob(request.resource.name), request.operation, args);
      }
      default: throw new Error(`Unsupported storage capability: ${String(request.capability)}`);
    }
  }

  return {
    dispatch,
    initializeRuntime,
    acquireTransition,
    commitTransition,
    abortTransition,
    async dispatchBatch(requests) {
      if (!Array.isArray(requests)) throw new Error('operations must be an array.');
      const results = [];
      for (const request of requests) {
        try { results.push({ ok: true, result: await dispatch(request) ?? null }); }
        catch (error) { results.push({ ok: false, error: String(error?.message || error) }); }
      }
      return results;
    },
  };
}