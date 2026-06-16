export function applyLaneTuning(lane, tuning) {
  if (!tuning || typeof tuning !== 'object') return lane;
  return {
    ...lane,
    ...(tuning.pollIntervalMs != null ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
    ...(tuning.visibilityMs != null ? { visibilityMs: tuning.visibilityMs } : {}),
    ...(tuning.concurrency != null ? { concurrency: tuning.concurrency } : {}),
    ...(tuning.maxAttempts != null ? { maxAttempts: tuning.maxAttempts } : {}),
  };
}

function createLeaseOperationError(action) {
  const error = new Error(`Queue lease ${action} rejected`);
  error.leaseOperation = action;
  return error;
}

async function expectLeaseOperation(action, operation) {
  const settled = await operation();
  if (settled === false) {
    throw createLeaseOperationError(action);
  }
}

export function createQueueStorageLane(id, queue, handleMessage, onError) {
  return {
    id,
    async lease(opts) {
      const leased = await queue.lease(opts);
      return leased.map((lease) => ({
        id: lease.id,
        attempt: lease.attempt,
        message: lease.body,
        ack: () => expectLeaseOperation('ack', () => queue.ack(lease.id, lease.leaseToken)),
        nack: (nackOpts) => expectLeaseOperation('nack', () => queue.nack(lease.id, lease.leaseToken, nackOpts)),
      }));
    },
    async handle() {
      await handleMessage();
    },
    onError,
  };
}

export function createBoardWorkerLane(id, store, handleRequest, onError) {
  return {
    id,
    async lease(opts) {
      const leased = await store.leaseRequests(opts);
      return leased.map((lease) => ({
        id: lease.messageId,
        attempt: lease.attempt,
        message: lease.request,
        ack: () => expectLeaseOperation('ack', () => store.ackRequest(lease.messageId, lease.leaseToken)),
        nack: (nackOpts) => expectLeaseOperation('nack', () => store.nackRequest(lease.messageId, lease.leaseToken, nackOpts)),
      }));
    },
    async handle(message) {
      await handleRequest(message);
    },
    onError,
  };
}

export async function runLaneLease(lane, lease) {
  try {
    await lane.handle(lease.message, lease);
    await lease.ack();
  } catch (error) {
    let reportedError = error;
    if (error?.leaseOperation !== 'ack') {
      const dead = lease.attempt >= Math.max(1, Math.floor(lane.maxAttempts ?? 5));
      try {
        await lease.nack({
          dead,
          reason: error instanceof Error ? error.message : String(error),
        });
      } catch (nackError) {
        reportedError = new Error(
          `${error instanceof Error ? error.message : String(error)}; failed to nack lease: ${nackError instanceof Error ? nackError.message : String(nackError)}`,
        );
      }
    }
    if (typeof lane.onError === 'function') {
      lane.onError(reportedError, lease);
    }
  }
}

export async function drainLaneToIdle(lane, maxPasses = 256) {
  const visibilityMs = Math.max(1, Math.floor(lane.visibilityMs ?? 1_200_000));
  const concurrency = Math.max(1, Math.floor(lane.concurrency ?? 1));
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const leases = await lane.lease({ max: concurrency, visibilityMs });
    if (!leases.length) return total;
    total += leases.length;
    for (const lease of leases) {
      await runLaneLease(lane, lease);
    }
  }
  throw new Error(`Exceeded ${maxPasses} drain passes for lane ${lane.id}`);
}

export function startLaneRunner(lane) {
  const pollIntervalMs = Math.max(1, Math.floor(lane.pollIntervalMs ?? 250));
  const visibilityMs = Math.max(1, Math.floor(lane.visibilityMs ?? 1_200_000));
  const concurrency = Math.max(1, Math.floor(lane.concurrency ?? 1));
  let stopped = false;
  let leasing = false;
  let inFlight = 0;

  async function tick() {
    if (stopped || leasing || inFlight >= concurrency) {
      return;
    }

    leasing = true;
    try {
      const leases = await lane.lease({ max: Math.max(1, concurrency - inFlight), visibilityMs });
      for (const lease of leases) {
        inFlight += 1;
        void runLaneLease(lane, lease).finally(() => {
          inFlight = Math.max(0, inFlight - 1);
          if (!stopped) {
            void tick();
          }
        });
      }
    } finally {
      leasing = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function startLaneRunners(registryOrLanes) {
  const lanes = Array.isArray(registryOrLanes) ? registryOrLanes : registryOrLanes.lanes;
  const stops = lanes.map((lane) => startLaneRunner(lane));
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}

export function createWakeTrigger(lane, logger) {
  let running = false;
  let pending = false;

  async function drain() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await drainLaneToIdle(lane);
      } while (pending);
    } catch (error) {
      logger.error(`lane ${lane.id} drain failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }

  return () => {
    void drain();
  };
}

export function queueCollectionPath(boardId, laneId) {
  if (laneId === 'process-accumulated') return `boards/${boardId}/process-queue`;
  if (laneId === 'chat-agent') return `boards/${boardId}/chat-queue`;
  return `boards/${boardId}/worker-queue`;
}
