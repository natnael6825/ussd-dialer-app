import { createHash, randomUUID } from 'node:crypto';

import { ApiError } from './errors.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const TRANSITIONS = Object.freeze({
  delivery_uncertain: new Set(['accepted', 'failed', 'cancelled']),
  // A phone durably accepts before starting. If its one-shot `running`
  // update is lost, its later terminal report must still reconcile the run.
  accepted: new Set(['accepted', 'running', 'succeeded', 'failed', 'cancelled']),
  // Once an accepted job passes its deadline, the relay cannot know whether
  // it merely waited for unlock or already started and lost its `running`
  // update. This state is deliberately non-retryable but still reconcilable.
  outcome_uncertain: new Set(['running', 'succeeded', 'failed', 'cancelled']),
  running: new Set(['running', 'succeeded', 'failed', 'cancelled']),
});

function stableVariables(variables) {
  return Object.keys(variables).sort().map((key) => [key, variables[key]]);
}

function requestFingerprint(run, ttlSeconds) {
  return createHash('sha256').update(JSON.stringify({
    flowId: run.flowId,
    variables: stableVariables(run.variables),
    ttlSeconds,
  })).digest('hex');
}

function publicFlow(flow) {
  return {
    id: flow.id,
    name: flow.name,
    requiredVariables: [...flow.requiredVariables],
    updatedAt: flow.updatedAt,
  };
}

function publicRun(job) {
  return {
    id: job.id,
    deviceId: job.deviceId,
    flowId: job.flowId,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    deliveredAt: job.deliveredAt,
    acceptedAt: job.acceptedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
    result: job.result,
  };
}

function deviceJob(job) {
  return {
    id: job.id,
    flowId: job.flowId,
    flowUpdatedAt: job.flowUpdatedAt,
    variables: { ...job.variables },
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

function queueJobMetadata(job) {
  return {
    id: job.id,
    flowId: job.flowId,
    flowName: job.flowName,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

export class RelayStore {
  constructor(config, { now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.devices = new Map();
    this.waiters = new Map();
    this.shuttingDown = false;
  }

  #newDevice(deviceId, name, registeredAt) {
    if (this.devices.size >= this.config.maxDevices) {
      throw new ApiError(503, 'DEVICE_CAPACITY_REACHED', 'The relay cannot register another device');
    }
    const device = {
      id: deviceId,
      name,
      registeredAt,
      lastSeenAt: 0,
      appVersion: undefined,
      androidVersion: undefined,
      state: 'ready',
      pendingJobId: undefined,
      catalogUpdatedAt: undefined,
      flows: new Map(),
      jobs: new Map(),
      queue: [],
      idempotency: new Map(),
    };
    this.devices.set(deviceId, device);
    return device;
  }

  register(deviceId, name) {
    const now = this.now();
    let device = this.devices.get(deviceId);
    if (!device) device = this.#newDevice(deviceId, name, now);
    device.name = name;
    device.lastSeenAt = now;
    return this.deviceSummary(device);
  }

  authenticateDevice(claim) {
    let device = this.devices.get(claim.deviceId);
    if (!device) {
      // Stateless signed tokens intentionally survive an in-memory relay restart.
      device = this.#newDevice(claim.deviceId, `Device ${claim.deviceId.slice(-8)}`, claim.issuedAt);
    }
    return device;
  }

  heartbeat(device, data = {}) {
    device.lastSeenAt = this.now();
    if (data.name !== undefined) device.name = data.name;
    if (data.appVersion !== undefined) device.appVersion = data.appVersion;
    if (data.androidVersion !== undefined) device.androidVersion = data.androidVersion;
    if (data.state !== undefined) {
      device.state = data.state;
      device.pendingJobId = data.state === 'busy' ? data.pendingJobId : undefined;
    }
    this.#reap(device);
    return {
      device: this.deviceSummary(device),
      queuedJobs: device.queue.reduce((count, id) => count + (device.jobs.get(id)?.status === 'queued' ? 1 : 0), 0),
      catalogRequired: device.catalogUpdatedAt === undefined,
    };
  }

  replaceCatalog(device, flows) {
    device.lastSeenAt = this.now();
    device.catalogUpdatedAt = device.lastSeenAt;
    device.flows = new Map(flows.map((flow) => [flow.id, { ...flow, requiredVariables: [...flow.requiredVariables] }]));
    return { flowCount: device.flows.size, catalogUpdatedAt: device.catalogUpdatedAt };
  }

  getCatalog(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    return {
      device: this.deviceSummary(device),
      catalogUpdatedAt: device.catalogUpdatedAt,
      flows: [...device.flows.values()].map(publicFlow),
    };
  }

  listDevices() {
    return [...this.devices.values()]
      .map((device) => this.deviceSummary(device))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  deviceSummary(device) {
    const online = device.lastSeenAt > 0 && this.now() - device.lastSeenAt <= this.config.deviceOnlineSeconds * 1_000;
    return {
      id: device.id,
      name: device.name,
      online,
      lastSeenAt: device.lastSeenAt || undefined,
      appVersion: device.appVersion,
      androidVersion: device.androidVersion,
      state: device.state,
      pendingJobId: device.pendingJobId,
    };
  }

  createJob(deviceId, run) {
    if (this.shuttingDown) throw new ApiError(503, 'SHUTTING_DOWN', 'Relay is shutting down');
    const device = this.devices.get(deviceId);
    if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    this.#reap(device);

    // Idempotent retries must return the original run even when the phone has
    // since gone offline or its catalog has changed. Checking mutable device
    // state first can tempt callers to submit a second financial command.
    const ttlSeconds = run.expiresInSeconds ?? this.config.jobDefaultTtlSeconds;
    const fingerprint = requestFingerprint(run, ttlSeconds);
    if (run.requestId) {
      const previous = device.idempotency.get(run.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new ApiError(409, 'REQUEST_ID_CONFLICT', 'requestId was already used for a different instruction');
        }
        const existing = device.jobs.get(previous.jobId);
        return { run: existing ? publicRun(existing) : previous.snapshot, duplicate: true };
      }
      if (device.idempotency.size >= this.config.maxJobsPerDevice * 2) {
        throw new ApiError(429, 'IDEMPOTENCY_CAPACITY_REACHED', 'This in-memory device has reached its idempotency-record limit');
      }
    }

    if (!this.deviceSummary(device).online) {
      throw new ApiError(503, 'DEVICE_OFFLINE', 'Device is offline; no USSD instruction was queued');
    }
    const flow = device.flows.get(run.flowId);
    if (!flow) throw new ApiError(404, 'FLOW_NOT_FOUND', 'Saved flow was not found on this device');

    const supplied = Object.keys(run.variables).sort();
    const required = [...flow.requiredVariables].sort();
    const missing = required.filter((name) => !Object.hasOwn(run.variables, name));
    const extra = supplied.filter((name) => !flow.requiredVariables.includes(name));
    if (missing.length || extra.length) {
      throw new ApiError(400, 'VARIABLE_MISMATCH', 'Variables must exactly match the saved flow requirements', { missing, extra });
    }

    if (device.queue.length >= this.config.maxQueuedJobsPerDevice) {
      throw new ApiError(
        429,
        'DEVICE_QUEUE_CAPACITY_REACHED',
        'This device already has the maximum number of queued runs',
        { limit: this.config.maxQueuedJobsPerDevice },
      );
    }

    this.#makeJobSpace(device);
    const now = this.now();
    const id = randomUUID();
    const requestId = run.requestId;
    const job = {
      id,
      requestId,
      requestFingerprint: fingerprint,
      deviceId,
      flowId: flow.id,
      flowName: flow.name,
      flowUpdatedAt: flow.updatedAt,
      variables: { ...run.variables },
      status: 'queued',
      message: 'Queued for the device',
      result: undefined,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1_000,
      updatedAt: now,
      deliveredAt: undefined,
      ackDeadline: undefined,
      acceptedAt: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      cancelledBeforeDelivery: false,
    };
    device.jobs.set(id, job);
    device.queue.push(id);
    if (requestId) {
      device.idempotency.set(requestId, { fingerprint, jobId: id, snapshot: publicRun(job), createdAt: now });
    }
    this.#wake(deviceId);
    return { run: publicRun(job), duplicate: false };
  }

  getJob(deviceId, jobId) {
    const device = this.devices.get(deviceId);
    if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    this.#reap(device);
    const job = device.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found; in-memory runs are lost when the relay restarts');
    return publicRun(job);
  }

  listQueuedJobs(device) {
    this.#reap(device);
    return device.queue
      .map((id) => device.jobs.get(id))
      .filter((job) => job?.status === 'queued')
      .map(queueJobMetadata)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  cancelQueuedJob(device, jobId) {
    this.#reap(device);
    const job = device.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'RUN_NOT_FOUND', 'Queued run not found or does not belong to this device');

    // DELETE is idempotent only for a run cancelled through this exact
    // pre-delivery operation. A cancellation reported after delivery is not
    // evidence that it was safe to remove from the queue.
    if (job.status === 'cancelled' && job.cancelledBeforeDelivery) {
      return queueJobMetadata(job);
    }
    if (job.status !== 'queued') {
      throw new ApiError(
        409,
        'RUN_NOT_CANCELLABLE',
        'Only a queued run can be cancelled before delivery',
        { currentStatus: job.status, requestedAction: 'cancel_queued' },
      );
    }

    const now = this.now();
    job.status = 'cancelled';
    job.message = 'Cancelled on the phone before delivery';
    job.updatedAt = now;
    job.finishedAt = now;
    job.cancelledBeforeDelivery = true;
    device.queue = device.queue.filter((id) => id !== job.id);
    this.#saveIdempotencySnapshot(device, job);
    return queueJobMetadata(job);
  }

  async waitForJob(device, waitSeconds, signal) {
    device.lastSeenAt = this.now();
    const immediate = this.#takeNext(device);
    if (immediate || waitSeconds === 0) return immediate;
    if (this.shuttingDown) throw new ApiError(503, 'SHUTTING_DOWN', 'Relay is shutting down');
    if (this.waiters.has(device.id)) {
      throw new ApiError(409, 'POLL_ALREADY_ACTIVE', 'This device already has an active job poll');
    }

    await new Promise((resolve) => {
      const finish = () => {
        const waiter = this.waiters.get(device.id);
        if (!waiter || waiter.finish !== finish) return;
        this.waiters.delete(device.id);
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, waitSeconds * 1_000);
      timer.unref?.();
      this.waiters.set(device.id, { finish, timer });
      signal?.addEventListener('abort', finish, { once: true });
    });
    if (signal?.aborted) return null;
    if (this.shuttingDown) throw new ApiError(503, 'SHUTTING_DOWN', 'Relay is shutting down');
    device.lastSeenAt = this.now();
    return this.#takeNext(device);
  }

  updateJob(device, jobId, update) {
    device.lastSeenAt = this.now();
    let job = device.jobs.get(jobId);
    if (!job) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found or does not belong to this device');

    if (job.status === 'delivery_uncertain' && update.status === 'accepted' && job.expiresAt <= this.now()) {
      const now = this.now();
      job.status = 'expired';
      job.message = 'Instruction expired before durable device acceptance';
      job.updatedAt = now;
      job.finishedAt = now;
      this.#saveIdempotencySnapshot(device, job);
      throw new ApiError(
        409,
        'RUN_EXPIRED',
        'Instruction expired before the device accepted it and must not be executed',
        { currentStatus: 'expired', requestedStatus: 'accepted' },
      );
    }

    this.#reap(device);
    job = device.jobs.get(jobId);
    if (TERMINAL.has(job.status)) {
      if (job.status === update.status) return publicRun(job);
      // The phone may report its local expiry immediately after the relay has
      // already expired the accepted job. A 2xx lets it clear durable state;
      // the relay keeps the more precise `expired` terminal status.
      if (job.status === 'expired' && (update.status === 'failed' || update.status === 'cancelled')) {
        return publicRun(job);
      }
      throw new ApiError(
        409,
        'RUN_ALREADY_FINISHED',
        `Run already finished with status ${job.status}`,
        { currentStatus: job.status, requestedStatus: update.status },
      );
    }
    const allowed = TRANSITIONS[job.status];
    if (!allowed?.has(update.status)) {
      throw new ApiError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Cannot change run from ${job.status} to ${update.status}`,
        { currentStatus: job.status, requestedStatus: update.status },
      );
    }
    const now = this.now();
    job.status = update.status;
    job.updatedAt = now;
    job.message = update.message ?? this.#defaultStatusMessage(update.status);
    if (update.result !== undefined) job.result = { ...update.result };
    if (update.status === 'accepted' && job.acceptedAt === undefined) job.acceptedAt = now;
    if (update.status === 'running' && job.startedAt === undefined) job.startedAt = now;
    if (TERMINAL.has(update.status)) job.finishedAt = now;
    this.#saveIdempotencySnapshot(device, job);
    return publicRun(job);
  }

  #defaultStatusMessage(status) {
    return {
      accepted: 'Accepted by the device',
      running: 'USSD flow is running',
      succeeded: 'USSD flow completed',
      failed: 'USSD flow failed',
      cancelled: 'USSD flow was cancelled',
      expired: 'Instruction expired before it could safely run',
      outcome_uncertain: 'Accepted instruction passed its deadline; do not retry until the phone reports its outcome',
    }[status];
  }

  #takeNext(device) {
    this.#reap(device);
    while (device.queue.length) {
      const id = device.queue.shift();
      const job = device.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      const now = this.now();
      job.status = 'delivery_uncertain';
      job.message = 'Sent to the device; awaiting durable acceptance';
      job.deliveredAt = now;
      job.ackDeadline = Math.min(job.expiresAt, now + this.config.jobAckTimeoutSeconds * 1_000);
      job.updatedAt = now;
      this.#saveIdempotencySnapshot(device, job);
      return deviceJob(job);
    }
    return null;
  }

  #reap(device) {
    const now = this.now();
    for (const job of device.jobs.values()) {
      if (job.status === 'queued' && job.expiresAt <= now) {
        job.status = 'expired';
        job.message = this.#defaultStatusMessage('expired');
        job.updatedAt = now;
        job.finishedAt = now;
        this.#saveIdempotencySnapshot(device, job);
      } else if (job.status === 'accepted' && job.expiresAt <= now) {
        job.status = 'outcome_uncertain';
        job.message = this.#defaultStatusMessage('outcome_uncertain');
        job.updatedAt = now;
        this.#saveIdempotencySnapshot(device, job);
      } else if (job.status === 'delivery_uncertain' && job.ackDeadline <= now) {
        // Never redeliver: it may already be persisted or executing on the phone.
        job.message = 'Delivery is uncertain; the instruction will not be retried automatically';
        job.updatedAt = Math.max(job.updatedAt, job.ackDeadline);
        this.#saveIdempotencySnapshot(device, job);
      }
    }
    device.queue = device.queue.filter((id) => device.jobs.get(id)?.status === 'queued');
  }

  #makeJobSpace(device) {
    if (device.jobs.size < this.config.maxJobsPerDevice) return;
    const removable = [...device.jobs.values()]
      .filter((job) => TERMINAL.has(job.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (device.jobs.size >= this.config.maxJobsPerDevice && removable.length) {
      device.jobs.delete(removable.shift().id);
    }
    if (device.jobs.size >= this.config.maxJobsPerDevice) {
      throw new ApiError(429, 'DEVICE_QUEUE_FULL', 'This device has too many unfinished runs');
    }
  }

  #saveIdempotencySnapshot(device, job) {
    const entry = device.idempotency.get(job.requestId);
    if (entry) entry.snapshot = publicRun(job);
  }

  #wake(deviceId) {
    this.waiters.get(deviceId)?.finish();
  }

  shutdown() {
    this.shuttingDown = true;
    for (const waiter of [...this.waiters.values()]) waiter.finish();
  }
}
