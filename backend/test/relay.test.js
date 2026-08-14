import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createRelayServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const CONTROL_KEY = 'control-key-00000000000000000000000000000000';
const ENROLLMENT_KEY = 'enroll-key-00000000000000000000000000000000';
const TOKEN_SECRET = 'token-secret-00000000000000000000000000000000';

function configuration(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    controlApiKey: CONTROL_KEY,
    deviceEnrollmentKey: ENROLLMENT_KEY,
    deviceTokenSecret: TOKEN_SECRET,
    deviceTokenTtlSeconds: 3_600,
    deviceOnlineSeconds: 60,
    jobDefaultTtlSeconds: 120,
    jobAckTimeoutSeconds: 15,
    maxBodyBytes: 65_536,
    maxDevices: 20,
    maxFlowsPerDevice: 20,
    maxQueuedJobsPerDevice: 20,
    maxJobsPerDevice: 20,
    ...overrides,
  };
}

async function start(options = {}) {
  const relay = createRelayServer({
    config: configuration(options.config),
    now: options.now,
    logger: () => {},
  });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const { port } = relay.server.address();
  return { ...relay, baseUrl: `http://127.0.0.1:${port}` };
}

async function request(baseUrl, path, { method = 'GET', auth, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : undefined };
}

async function enrollAndSync(baseUrl, deviceId = 'phone-alpha') {
  const registered = await request(baseUrl, '/api/device/register', {
    method: 'POST',
    auth: `Bearer ${ENROLLMENT_KEY}`,
    body: { deviceId, name: 'Samsung M12' },
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.json.deviceId, deviceId);
  const deviceAuth = `Device ${registered.json.deviceToken}`;
  const catalog = await request(baseUrl, '/api/device/catalog', {
    method: 'PUT',
    auth: deviceAuth,
    body: {
      flows: [{
        id: 'send-money',
        name: 'Send money',
        requiredVariables: ['phone', 'amount'],
        updatedAt: 1_723_500_000_000,
      }],
    },
  });
  assert.equal(catalog.response.status, 200);
  return { deviceAuth, deviceToken: registered.json.deviceToken };
}

test('control API discovers safe device summaries and requires authentication', async (t) => {
  const relay = await start();
  t.after(() => relay.shutdown());
  await enrollAndSync(relay.baseUrl, 'phone-zulu');
  await enrollAndSync(relay.baseUrl, 'phone-alpha');

  const unauthorized = await request(relay.baseUrl, '/api/devices');
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.json.error.code, 'UNAUTHORIZED');

  const forbiddenCredential = await request(relay.baseUrl, '/api/devices', {
    auth: `Bearer ${ENROLLMENT_KEY}`,
  });
  assert.equal(forbiddenCredential.response.status, 401);

  const discovered = await request(relay.baseUrl, '/api/devices', {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(discovered.response.status, 200);
  assert.deepEqual(discovered.json.devices.map((device) => device.id), ['phone-alpha', 'phone-zulu']);
  for (const device of discovered.json.devices) {
    assert.equal(device.online, true);
    assert.equal(device.state, 'ready');
    assert.equal(typeof device.lastSeenAt, 'number');
    for (const forbidden of ['deviceToken', 'token', 'flows', 'catalog', 'variables', 'jobs']) {
      assert.equal(Object.hasOwn(device, forbidden), false);
    }
  }
});

test('device lists and cancels only its own queued metadata while preserving idempotency', async (t) => {
  const relay = await start();
  t.after(() => relay.shutdown());
  const first = await enrollAndSync(relay.baseUrl, 'phone-queue-first');
  const second = await enrollAndSync(relay.baseUrl, 'phone-queue-second');
  const firstInstruction = {
    flowId: 'send-money',
    variables: { phone: 'SENSITIVE_PHONE_FIRST', amount: 'SENSITIVE_AMOUNT_FIRST' },
    requestId: 'queue-cancel-command-01',
  };
  const firstCreated = await request(relay.baseUrl, '/api/devices/phone-queue-first/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: firstInstruction,
  });
  const secondCreated = await request(relay.baseUrl, '/api/devices/phone-queue-second/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money',
      variables: { phone: 'SENSITIVE_PHONE_SECOND', amount: 'SENSITIVE_AMOUNT_SECOND' },
      requestId: 'queue-other-device-01',
    },
  });
  assert.equal(firstCreated.response.status, 202);
  assert.equal(secondCreated.response.status, 202);

  const unauthenticated = await request(relay.baseUrl, '/api/device/jobs');
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.json.error.code, 'DEVICE_UNAUTHORIZED');

  const firstQueue = await request(relay.baseUrl, '/api/device/jobs', { auth: first.deviceAuth });
  assert.equal(firstQueue.response.status, 200);
  assert.equal(firstQueue.json.jobs.length, 1);
  assert.deepEqual(firstQueue.json.jobs[0], {
    id: firstCreated.json.run.id,
    flowId: 'send-money',
    flowName: 'Send money',
    status: 'queued',
    createdAt: firstCreated.json.run.createdAt,
    expiresAt: firstCreated.json.run.expiresAt,
  });
  const serializedQueue = JSON.stringify(firstQueue.json);
  for (const forbidden of [
    'variables', 'requestId', 'phone', 'amount',
    'SENSITIVE_PHONE_FIRST', 'SENSITIVE_AMOUNT_FIRST',
  ]) {
    assert.equal(serializedQueue.includes(forbidden), false);
  }

  const secondQueue = await request(relay.baseUrl, '/api/device/jobs', { auth: second.deviceAuth });
  assert.deepEqual(secondQueue.json.jobs.map((job) => job.id), [secondCreated.json.run.id]);

  const crossDeviceDelete = await request(
    relay.baseUrl,
    `/api/device/jobs/${secondCreated.json.run.id}`,
    { method: 'DELETE', auth: first.deviceAuth },
  );
  assert.equal(crossDeviceDelete.response.status, 404);
  assert.equal(crossDeviceDelete.json.error.code, 'RUN_NOT_FOUND');

  const cancelled = await request(
    relay.baseUrl,
    `/api/device/jobs/${firstCreated.json.run.id}`,
    { method: 'DELETE', auth: first.deviceAuth },
  );
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.json.job.status, 'cancelled');
  assert.equal(Object.hasOwn(cancelled.json.job, 'variables'), false);

  const repeatedDelete = await request(
    relay.baseUrl,
    `/api/device/jobs/${firstCreated.json.run.id}`,
    { method: 'DELETE', auth: first.deviceAuth },
  );
  assert.equal(repeatedDelete.response.status, 200);
  assert.equal(repeatedDelete.json.job.status, 'cancelled');

  const emptyQueue = await request(relay.baseUrl, '/api/device/jobs', { auth: first.deviceAuth });
  assert.deepEqual(emptyQueue.json.jobs, []);
  const noDelivery = await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: first.deviceAuth });
  assert.equal(noDelivery.response.status, 204);

  const duplicate = await request(relay.baseUrl, '/api/devices/phone-queue-first/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: firstInstruction,
  });
  assert.equal(duplicate.response.status, 202);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.run.id, firstCreated.json.run.id);
  assert.equal(duplicate.json.run.status, 'cancelled');

  const controlStatus = await request(
    relay.baseUrl,
    `/api/devices/phone-queue-first/runs/${firstCreated.json.run.id}`,
    { auth: `Bearer ${CONTROL_KEY}` },
  );
  assert.equal(controlStatus.json.run.status, 'cancelled');
});

test('queue inspection and cancellation do not make an inactive listener appear online', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-queue-liveness');
  const initialLastSeenAt = clock;
  const created = await request(relay.baseUrl, '/api/devices/phone-queue-liveness/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'queue-liveness-command-01',
    },
  });
  assert.equal(created.response.status, 202);

  clock += 61_000;
  const listed = await request(relay.baseUrl, '/api/device/jobs', { auth: deviceAuth });
  assert.deepEqual(listed.json.jobs.map((job) => job.id), [created.json.run.id]);
  const cancelled = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}`, {
    method: 'DELETE', auth: deviceAuth,
  });
  assert.equal(cancelled.response.status, 200);

  const devices = await request(relay.baseUrl, '/api/devices', { auth: `Bearer ${CONTROL_KEY}` });
  const summary = devices.json.devices.find((device) => device.id === 'phone-queue-liveness');
  assert.equal(summary.online, false);
  assert.equal(summary.lastSeenAt, initialLastSeenAt);

  const newInstruction = await request(relay.baseUrl, '/api/devices/phone-queue-liveness/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '11' },
      requestId: 'queue-liveness-command-02',
    },
  });
  assert.equal(newInstruction.response.status, 503);
  assert.equal(newInstruction.json.error.code, 'DEVICE_OFFLINE');
});

test('queued-run cap rejects new work without breaking exact retries and frees capacity on cancellation', async (t) => {
  const relay = await start({ config: { maxQueuedJobsPerDevice: 2 } });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-queue-cap');
  const makeInstruction = (requestId, amount) => ({
    flowId: 'send-money', variables: { phone: '0900000000', amount }, requestId,
  });
  const firstInstruction = makeInstruction('queue-cap-command-01', '10');
  const first = await request(relay.baseUrl, '/api/devices/phone-queue-cap/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: firstInstruction,
  });
  const second = await request(relay.baseUrl, '/api/devices/phone-queue-cap/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: makeInstruction('queue-cap-command-02', '20'),
  });
  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 202);

  const duplicateAtCapacity = await request(relay.baseUrl, '/api/devices/phone-queue-cap/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: firstInstruction,
  });
  assert.equal(duplicateAtCapacity.response.status, 202);
  assert.equal(duplicateAtCapacity.json.duplicate, true);
  assert.equal(duplicateAtCapacity.json.run.id, first.json.run.id);

  const thirdInstruction = makeInstruction('queue-cap-command-03', '30');
  const rejected = await request(relay.baseUrl, '/api/devices/phone-queue-cap/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: thirdInstruction,
  });
  assert.equal(rejected.response.status, 429);
  assert.equal(rejected.json.error.code, 'DEVICE_QUEUE_CAPACITY_REACHED');
  assert.deepEqual(rejected.json.error.details, { limit: 2 });

  await request(relay.baseUrl, `/api/device/jobs/${first.json.run.id}`, {
    method: 'DELETE', auth: deviceAuth,
  });
  const acceptedAfterCancellation = await request(relay.baseUrl, '/api/devices/phone-queue-cap/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: thirdInstruction,
  });
  assert.equal(acceptedAfterCancellation.response.status, 202);
  assert.equal(acceptedAfterCancellation.json.duplicate, false);

  const listed = await request(relay.baseUrl, '/api/device/jobs', { auth: deviceAuth });
  assert.equal(listed.json.jobs.length, 2);
  assert.deepEqual(new Set(listed.json.jobs.map((job) => job.id)), new Set([
    second.json.run.id, acceptedAfterCancellation.json.run.id,
  ]));
});

test('device cannot delete delivered, accepted, or running work', async (t) => {
  const relay = await start();
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-non-cancellable');
  const created = await request(relay.baseUrl, '/api/devices/phone-non-cancellable/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'non-cancellable-command-01',
    },
  });
  const jobId = created.json.run.id;
  await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });

  const deliveredDelete = await request(relay.baseUrl, `/api/device/jobs/${jobId}`, {
    method: 'DELETE', auth: deviceAuth,
  });
  assert.equal(deliveredDelete.response.status, 409);
  assert.equal(deliveredDelete.json.error.code, 'RUN_NOT_CANCELLABLE');
  assert.deepEqual(deliveredDelete.json.error.details, {
    currentStatus: 'delivery_uncertain', requestedAction: 'cancel_queued',
  });

  await request(relay.baseUrl, `/api/device/jobs/${jobId}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'accepted' },
  });
  const acceptedDelete = await request(relay.baseUrl, `/api/device/jobs/${jobId}`, {
    method: 'DELETE', auth: deviceAuth,
  });
  assert.equal(acceptedDelete.response.status, 409);
  assert.equal(acceptedDelete.json.error.details.currentStatus, 'accepted');

  await request(relay.baseUrl, `/api/device/jobs/${jobId}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'running', sessionId: 'live-session' },
  });
  const runningDelete = await request(relay.baseUrl, `/api/device/jobs/${jobId}`, {
    method: 'DELETE', auth: deviceAuth,
  });
  assert.equal(runningDelete.response.status, 409);
  assert.equal(runningDelete.json.error.details.currentStatus, 'running');
});

test('authenticated catalog, run delivery, idempotency, and status lifecycle', async (t) => {
  const relay = await start();
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl);

  const heartbeat = await request(relay.baseUrl, '/api/device/heartbeat', {
    method: 'POST', auth: deviceAuth,
    body: { state: 'busy', pendingJobId: 'local-pending-job' },
  });
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.json.device.state, 'busy');
  assert.equal(heartbeat.json.device.pendingJobId, 'local-pending-job');

  const unauthorized = await request(relay.baseUrl, '/api/devices/phone-alpha/flows', {
    auth: 'Bearer wrong-key',
  });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.json.error.code, 'UNAUTHORIZED');

  const catalog = await request(relay.baseUrl, '/api/devices/phone-alpha/flows', {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(catalog.response.status, 200);
  assert.deepEqual(catalog.json.flows, [{
    id: 'send-money',
    name: 'Send money',
    requiredVariables: ['phone', 'amount'],
    updatedAt: 1_723_500_000_000,
  }]);

  const badVariables = await request(relay.baseUrl, '/api/devices/phone-alpha/runs', {
    method: 'POST',
    auth: `Bearer ${CONTROL_KEY}`,
    body: { flowId: 'send-money', variables: { phone: '0911000000', note: 'do-not-accept' }, requestId: 'bad-variables-0001' },
  });
  assert.equal(badVariables.response.status, 400);
  assert.equal(badVariables.json.error.code, 'VARIABLE_MISMATCH');
  assert.deepEqual(badVariables.json.error.details, { missing: ['amount'], extra: ['note'] });

  const cancelValue = await request(relay.baseUrl, '/api/devices/phone-alpha/runs', {
    method: 'POST',
    auth: `Bearer ${CONTROL_KEY}`,
    body: { flowId: 'send-money', variables: { phone: '0911000000', amount: 'CANCEL' }, requestId: 'bad-cancel-value-01' },
  });
  assert.equal(cancelValue.response.status, 400);
  assert.equal(cancelValue.json.error.code, 'INVALID_VARIABLE_VALUE');

  const nestedPlaceholder = await request(relay.baseUrl, '/api/devices/phone-alpha/runs', {
    method: 'POST',
    auth: `Bearer ${CONTROL_KEY}`,
    body: { flowId: 'send-money', variables: { phone: '{{another}}', amount: '25' }, requestId: 'bad-placeholder-001' },
  });
  assert.equal(nestedPlaceholder.response.status, 400);
  assert.equal(nestedPlaceholder.json.error.code, 'INVALID_VARIABLE_VALUE');

  const instruction = {
    flowId: 'send-money',
    variables: { phone: '0911000000', amount: '25' },
    requestId: 'payment-2026-0001',
    expiresInSeconds: 60,
  };
  const created = await request(relay.baseUrl, '/api/devices/phone-alpha/runs', {
    method: 'POST',
    auth: `Bearer ${CONTROL_KEY}`,
    body: instruction,
  });
  assert.equal(created.response.status, 202);
  assert.equal(created.json.run.status, 'queued');
  assert.equal(created.json.duplicate, false);
  assert.equal(Object.hasOwn(created.json.run, 'variables'), false);

  const duplicate = await request(relay.baseUrl, '/api/devices/phone-alpha/runs', {
    method: 'POST',
    auth: `Bearer ${CONTROL_KEY}`,
    body: instruction,
  });
  assert.equal(duplicate.response.status, 202);
  assert.equal(duplicate.json.duplicate, true);
  assert.equal(duplicate.json.run.id, created.json.run.id);

  const conflicting = await request(relay.baseUrl, '/api/devices/phone-alpha/runs', {
    method: 'POST',
    auth: `Bearer ${CONTROL_KEY}`,
    body: { ...instruction, variables: { phone: '0911000000', amount: '50' } },
  });
  assert.equal(conflicting.response.status, 409);
  assert.equal(conflicting.json.error.code, 'REQUEST_ID_CONFLICT');

  const polled = await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  assert.equal(polled.response.status, 200);
  assert.deepEqual(polled.json.job.variables, { phone: '0911000000', amount: '25' });
  assert.equal(polled.json.job.flowUpdatedAt, 1_723_500_000_000);
  assert.ok(polled.json.job.expiresAt > polled.json.job.createdAt);

  const emptyPoll = await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  assert.equal(emptyPoll.response.status, 204);

  for (const update of [
    { status: 'accepted', message: 'Persisted; waiting for the phone to unlock' },
    { status: 'running', sessionId: 'session-123' },
    { status: 'succeeded', result: { sessionId: 'session-123', completedSteps: 2, totalSteps: 2 } },
  ]) {
    const result = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
      method: 'POST', auth: deviceAuth, body: update,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.json.run.status, update.status);
  }

  const final = await request(relay.baseUrl, `/api/devices/phone-alpha/runs/${created.json.run.id}`, {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(final.response.status, 200);
  assert.equal(final.json.run.status, 'succeeded');
  assert.deepEqual(final.json.run.result, { sessionId: 'session-123', completedSteps: 2, totalSteps: 2 });
  assert.equal(Object.hasOwn(final.json.run, 'variables'), false);

  const conflictingTerminal = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'failed' },
  });
  assert.equal(conflictingTerminal.response.status, 409);
  assert.equal(conflictingTerminal.json.error.code, 'RUN_ALREADY_FINISHED');
  assert.deepEqual(conflictingTerminal.json.error.details, {
    currentStatus: 'succeeded', requestedStatus: 'failed',
  });
});

test('terminal success reconciles when the intermediate running update was lost', async (t) => {
  const relay = await start();
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-lost-running');
  const created = await request(relay.baseUrl, '/api/devices/phone-lost-running/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'lost-running-update-01',
    },
  });
  await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  const accepted = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'accepted' },
  });
  assert.equal(accepted.response.status, 200);

  // Simulate the phone's POST running being lost in transit.
  const succeeded = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth,
    body: { status: 'succeeded', sessionId: 'local-session-after-lost-running' },
  });
  assert.equal(succeeded.response.status, 200);
  assert.equal(succeeded.json.run.status, 'succeeded');
  assert.equal(succeeded.json.run.result.sessionId, 'local-session-after-lost-running');
});

test('idempotent retry returns the original run after offline and catalog changes', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-idempotent');
  const instruction = {
    flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
    requestId: 'stable-retry-command-01', expiresInSeconds: 300,
  };
  const created = await request(relay.baseUrl, '/api/devices/phone-idempotent/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: instruction,
  });
  assert.equal(created.response.status, 202);

  clock += 61_000;
  const whileOffline = await request(relay.baseUrl, '/api/devices/phone-idempotent/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: instruction,
  });
  assert.equal(whileOffline.response.status, 202);
  assert.equal(whileOffline.json.duplicate, true);
  assert.equal(whileOffline.json.run.id, created.json.run.id);

  const clearedCatalog = await request(relay.baseUrl, '/api/device/catalog', {
    method: 'PUT', auth: deviceAuth, body: { flows: [] },
  });
  assert.equal(clearedCatalog.response.status, 200);
  const afterCatalogChange = await request(relay.baseUrl, '/api/devices/phone-idempotent/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`, body: instruction,
  });
  assert.equal(afterCatalogChange.response.status, 202);
  assert.equal(afterCatalogChange.json.duplicate, true);
  assert.equal(afterCatalogChange.json.run.id, created.json.run.id);
});

test('a dequeued job is never redelivered when acknowledgement is lost', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-uncertain');

  const created = await request(relay.baseUrl, '/api/devices/phone-uncertain/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' }, requestId: 'uncertain-command-01',
    },
  });
  await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  clock += 16_000;

  const status = await request(relay.baseUrl, `/api/devices/phone-uncertain/runs/${created.json.run.id}`, {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(status.json.run.status, 'delivery_uncertain');
  assert.match(status.json.run.message, /will not be retried/i);
  const secondPoll = await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  assert.equal(secondPoll.response.status, 204);
});

test('queued jobs expire and are not delivered', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-expiry');
  const created = await request(relay.baseUrl, '/api/devices/phone-expiry/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'expiring-command-01', expiresInSeconds: 30,
    },
  });
  clock += 31_000;
  const poll = await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  assert.equal(poll.response.status, 204);
  const status = await request(relay.baseUrl, `/api/devices/phone-expiry/runs/${created.json.run.id}`, {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(status.json.run.status, 'expired');
});

test('late device acceptance is rejected with a machine-readable expired state', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-late-accept');
  const created = await request(relay.baseUrl, '/api/devices/phone-late-accept/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'late-accept-command-01', expiresInSeconds: 30,
    },
  });
  await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  clock += 31_000;
  const accepted = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'accepted' },
  });
  assert.equal(accepted.response.status, 409);
  assert.equal(accepted.json.error.code, 'RUN_EXPIRED');
  assert.deepEqual(accepted.json.error.details, {
    currentStatus: 'expired', requestedStatus: 'accepted',
  });
});

test('device can reconcile a failed accepted job after its deadline', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-locked');
  const created = await request(relay.baseUrl, '/api/devices/phone-locked/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'locked-expiry-command', expiresInSeconds: 30,
    },
  });
  await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  const accepted = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'accepted', message: 'waiting_for_unlock' },
  });
  assert.equal(accepted.response.status, 200);
  clock += 31_000;
  const localExpiry = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth, body: { status: 'failed', message: 'job_expired' },
  });
  assert.equal(localExpiry.response.status, 200);
  assert.equal(localExpiry.json.run.status, 'failed');
});

test('accepted job becomes outcome_uncertain after TTL then running and success reconcile', async (t) => {
  let clock = 1_800_000_000_000;
  const relay = await start({ now: () => clock });
  t.after(() => relay.shutdown());
  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-late-success');
  const created = await request(relay.baseUrl, '/api/devices/phone-late-success/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: {
      flowId: 'send-money', variables: { phone: '0900000000', amount: '10' },
      requestId: 'late-success-command-01', expiresInSeconds: 30,
    },
  });
  await request(relay.baseUrl, '/api/device/jobs/next?wait=0', { auth: deviceAuth });
  const accepted = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth,
    body: { status: 'accepted', message: 'Persisted by phone' },
  });
  assert.equal(accepted.response.status, 200);

  clock += 31_000;
  // A heartbeat invokes the same expiry reconciliation as a control read.
  const heartbeat = await request(relay.baseUrl, '/api/device/heartbeat', {
    method: 'POST', auth: deviceAuth,
    body: { state: 'busy', pendingJobId: created.json.run.id },
  });
  assert.equal(heartbeat.response.status, 200);
  const uncertain = await request(relay.baseUrl, `/api/devices/phone-late-success/runs/${created.json.run.id}`, {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(uncertain.response.status, 200);
  assert.equal(uncertain.json.run.status, 'outcome_uncertain');
  assert.match(uncertain.json.run.message, /do not retry/i);
  assert.equal(uncertain.json.run.finishedAt, undefined);

  const uncertainDelete = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}`, {
    method: 'DELETE', auth: deviceAuth,
  });
  assert.equal(uncertainDelete.response.status, 409);
  assert.equal(uncertainDelete.json.error.code, 'RUN_NOT_CANCELLABLE');
  assert.deepEqual(uncertainDelete.json.error.details, {
    currentStatus: 'outcome_uncertain', requestedAction: 'cancel_queued',
  });

  // The phone durably retries its lost running update before the terminal one.
  const running = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth,
    body: { status: 'running', sessionId: 'late-success-session' },
  });
  assert.equal(running.response.status, 200);
  assert.equal(running.json.run.status, 'running');
  assert.equal(running.json.run.result.sessionId, 'late-success-session');
  assert.ok(running.json.run.startedAt > created.json.run.createdAt);

  // The authenticated phone remains authoritative for the real-world result.
  const succeeded = await request(relay.baseUrl, `/api/device/jobs/${created.json.run.id}/status`, {
    method: 'POST', auth: deviceAuth,
    body: { status: 'succeeded', sessionId: 'late-success-session' },
  });
  assert.equal(succeeded.response.status, 200);
  assert.equal(succeeded.json.run.status, 'succeeded');
  assert.equal(succeeded.json.run.result.sessionId, 'late-success-session');
  assert.ok(succeeded.json.run.finishedAt > created.json.run.createdAt);
});

test('signed device token survives relay restart while volatile catalog does not', async (t) => {
  const first = await start();
  const { deviceToken } = await enrollAndSync(first.baseUrl, 'phone-restart');
  await first.shutdown();

  const second = await start();
  t.after(() => second.shutdown());
  const heartbeat = await request(second.baseUrl, '/api/device/heartbeat', {
    method: 'POST', auth: `Device ${deviceToken}`, body: { appVersion: '1.1.0' },
  });
  assert.equal(heartbeat.response.status, 200);
  assert.equal(heartbeat.json.device.id, 'phone-restart');
  assert.equal(heartbeat.json.catalogRequired, true);

  const flows = await request(second.baseUrl, '/api/devices/phone-restart/flows', {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(flows.response.status, 200);
  assert.deepEqual(flows.json.flows, []);
});

test('catalog accepts up to twenty required variables and rejects twenty-one atomically', async (t) => {
  const relay = await start();
  t.after(() => relay.shutdown());
  const registered = await request(relay.baseUrl, '/api/device/register', {
    method: 'POST', auth: `Bearer ${ENROLLMENT_KEY}`,
    body: { deviceId: 'phone-many-variables', name: 'Many variables phone' },
  });
  const deviceAuth = `Device ${registered.json.deviceToken}`;
  const twenty = Array.from({ length: 20 }, (_, index) => `value_${index}`);
  const accepted = await request(relay.baseUrl, '/api/device/catalog', {
    method: 'PUT', auth: deviceAuth,
    body: { flows: [{ id: 'large-flow', name: 'Large flow', requiredVariables: twenty, updatedAt: 123 }] },
  });
  assert.equal(accepted.response.status, 200);

  const rejected = await request(relay.baseUrl, '/api/device/catalog', {
    method: 'PUT', auth: deviceAuth,
    body: {
      flows: [{
        id: 'too-large-flow', name: 'Too large flow',
        requiredVariables: [...twenty, 'value_20'], updatedAt: 124,
      }],
    },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.json.error.code, 'INVALID_VARIABLES');

  const catalog = await request(relay.baseUrl, '/api/devices/phone-many-variables/flows', {
    auth: `Bearer ${CONTROL_KEY}`,
  });
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.json.flows[0].id, 'large-flow');
  assert.equal(catalog.json.flows[0].requiredVariables.length, 20);
});

test('validation rejects unknown fields, malformed auth, and oversized bodies', async (t) => {
  const relay = await start({ config: { maxBodyBytes: 1_024 } });
  t.after(() => relay.shutdown());

  const malformed = await request(relay.baseUrl, '/api/device/register', {
    method: 'POST', auth: `Bearer ${ENROLLMENT_KEY}`,
    body: { deviceId: 'phone-one', name: 'Phone', secretExtra: 'not allowed' },
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.json.error.code, 'UNKNOWN_FIELD');

  const wrongType = await request(relay.baseUrl, '/api/device/register', {
    method: 'POST', auth: `Bearer ${ENROLLMENT_KEY}`,
    body: { deviceId: 'phone-one', name: 123 },
  });
  assert.equal(wrongType.response.status, 400);
  assert.equal(wrongType.json.error.code, 'INVALID_FIELD');

  const badScheme = await request(relay.baseUrl, '/api/device/register', {
    method: 'POST', auth: `Device ${ENROLLMENT_KEY}`,
    body: { deviceId: 'phone-one', name: 'Phone' },
  });
  assert.equal(badScheme.response.status, 401);

  const oversized = await request(relay.baseUrl, '/api/device/register', {
    method: 'POST', auth: `Bearer ${ENROLLMENT_KEY}`,
    body: JSON.stringify({ deviceId: 'phone-one', name: 'x'.repeat(2_000) }),
  });
  assert.equal(oversized.response.status, 413);

  const { deviceAuth } = await enrollAndSync(relay.baseUrl, 'phone-request-id');
  assert.ok(deviceAuth.startsWith('Device '));
  const missingRequestId = await request(relay.baseUrl, '/api/devices/phone-request-id/runs', {
    method: 'POST', auth: `Bearer ${CONTROL_KEY}`,
    body: { flowId: 'send-money', variables: { phone: '0900000000', amount: '10' } },
  });
  assert.equal(missingRequestId.response.status, 400);
  assert.equal(missingRequestId.json.error.code, 'MISSING_FIELD');
});

test('configuration binds locally and refuses accidental remote plain HTTP', () => {
  const secrets = {
    CONTROL_API_KEY: CONTROL_KEY,
    DEVICE_ENROLLMENT_KEY: ENROLLMENT_KEY,
    DEVICE_TOKEN_SECRET: TOKEN_SECRET,
  };
  const local = loadConfig(secrets);
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.maxQueuedJobsPerDevice, 200);
  assert.throws(() => loadConfig({ ...secrets, HOST: '0.0.0.0' }), /Refusing to expose plain HTTP/);
  assert.equal(loadConfig({ ...secrets, HOST: '0.0.0.0', ALLOW_INSECURE_REMOTE_HTTP: 'true' }).host, '0.0.0.0');
  assert.throws(
    () => loadConfig({ ...secrets, MAX_QUEUED_JOBS_PER_DEVICE: '257' }),
    /MAX_QUEUED_JOBS_PER_DEVICE must be between 1 and 256/,
  );
  assert.throws(() => loadConfig({}), /CONTROL_API_KEY/);
});
