import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { issueDeviceToken, requireSharedKey, verifyDeviceToken } from './auth.js';
import { validateRuntimeConfig } from './config.js';
import { ApiError } from './errors.js';
import { RelayStore } from './relay.js';
import {
  validateCatalog,
  validateDeviceId,
  validateHeartbeat,
  validateJobUpdate,
  validateRegistration,
  validateRun,
  validateWait,
} from './validation.js';

function defaultLogger(event) {
  const output = JSON.stringify(event);
  if (event.level === 'error') console.error(output);
  else console.log(output);
}

function requestId(req) {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied)
    ? supplied
    : randomUUID();
}

function setHeaders(res, id) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-request-id', id);
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function sendEmpty(res, status) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.removeHeader('content-type');
  res.end();
}

async function readJson(req, maximumBytes) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ApiError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ApiError(413, 'BODY_TOO_LARGE', `Request body cannot exceed ${maximumBytes} bytes`);
  }

  const chunks = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) throw new ApiError(413, 'BODY_TOO_LARGE', `Request body cannot exceed ${maximumBytes} bytes`);
  if (size === 0) throw new ApiError(400, 'INVALID_JSON', 'A JSON request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function decodePathPart(value, validator) {
  try {
    return validator(decodeURIComponent(value));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_PATH', 'Path contains invalid encoding');
  }
}

export function createRelayServer({ config, logger = defaultLogger, now = () => Date.now() }) {
  validateRuntimeConfig(config);
  const store = new RelayStore(config, { now });
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const id = requestId(req);
    const startedAt = Date.now();
    let route = 'unmatched';
    setHeaders(res, id);
    res.on('finish', () => {
      logger({
        level: 'info',
        event: 'http_request',
        requestId: id,
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    try {
      if (!req.url || req.url.length > 2_048) throw new ApiError(414, 'URI_TOO_LONG', 'Request URI is too long');
      const url = new URL(req.url, 'http://relay.invalid');
      const path = url.pathname;
      if (path !== '/api/device/jobs/next' && url.search !== '') {
        throw new ApiError(400, 'UNKNOWN_QUERY', 'This endpoint does not accept query parameters');
      }

      if (req.method === 'GET' && path === '/health') {
        route = 'health';
        sendJson(res, 200, { status: 'ok', storage: 'memory', serverTime: now() });
        return;
      }

      if (req.method === 'GET' && path === '/api/devices') {
        route = 'control.devices.list';
        requireSharedKey(req.headers.authorization, 'Bearer', config.controlApiKey);
        sendJson(res, 200, { devices: store.listDevices(), serverTime: now() });
        return;
      }

      if (req.method === 'POST' && path === '/api/device/register') {
        route = 'device.register';
        requireSharedKey(req.headers.authorization, 'Bearer', config.deviceEnrollmentKey, 'ENROLLMENT_UNAUTHORIZED');
        const registration = validateRegistration(await readJson(req, config.maxBodyBytes));
        const device = store.register(registration.deviceId, registration.name);
        const token = issueDeviceToken(registration.deviceId, config.deviceTokenSecret, config.deviceTokenTtlSeconds, now());
        const claims = verifyDeviceToken(`Device ${token}`, config.deviceTokenSecret, now());
        sendJson(res, 201, {
          deviceId: registration.deviceId,
          device,
          deviceToken: token,
          tokenExpiresAt: claims.expiresAt,
          serverTime: now(),
        });
        return;
      }

      const isDeviceRoute = path.startsWith('/api/device/');
      let authenticatedDevice;
      if (isDeviceRoute) {
        const claims = verifyDeviceToken(req.headers.authorization, config.deviceTokenSecret, now());
        authenticatedDevice = store.authenticateDevice(claims);
      }

      if (req.method === 'POST' && path === '/api/device/heartbeat') {
        route = 'device.heartbeat';
        const heartbeat = validateHeartbeat(await readJson(req, config.maxBodyBytes));
        sendJson(res, 200, { ...store.heartbeat(authenticatedDevice, heartbeat), serverTime: now() });
        return;
      }

      if (req.method === 'PUT' && path === '/api/device/catalog') {
        route = 'device.catalog.replace';
        const flows = validateCatalog(await readJson(req, config.maxBodyBytes), config.maxFlowsPerDevice);
        sendJson(res, 200, { ...store.replaceCatalog(authenticatedDevice, flows), serverTime: now() });
        return;
      }

      if (req.method === 'GET' && path === '/api/device/jobs') {
        route = 'device.jobs.list';
        sendJson(res, 200, { jobs: store.listQueuedJobs(authenticatedDevice), serverTime: now() });
        return;
      }

      if (req.method === 'GET' && path === '/api/device/jobs/next') {
        route = 'device.jobs.next';
        const wait = validateWait(url.searchParams.get('wait'));
        if ([...url.searchParams.keys()].some((key) => key !== 'wait') || url.searchParams.getAll('wait').length > 1) {
          throw new ApiError(400, 'UNKNOWN_QUERY', 'Only the wait query parameter is supported');
        }
        const abortController = new AbortController();
        req.once('aborted', () => abortController.abort());
        res.once('close', () => abortController.abort());
        const job = await store.waitForJob(authenticatedDevice, wait, abortController.signal);
        if (!job) sendEmpty(res, 204);
        else sendJson(res, 200, { job, serverTime: now() });
        return;
      }

      const cancelJobMatch = path.match(/^\/api\/device\/jobs\/([^/]+)$/);
      if (req.method === 'DELETE' && cancelJobMatch) {
        route = 'device.jobs.cancel';
        const jobId = decodePathPart(cancelJobMatch[1], (value) => {
          if (!/^[0-9a-f-]{36}$/i.test(value)) throw new ApiError(400, 'INVALID_RUN_ID', 'Run id is invalid');
          return value;
        });
        sendJson(res, 200, { job: store.cancelQueuedJob(authenticatedDevice, jobId), serverTime: now() });
        return;
      }

      const statusMatch = path.match(/^\/api\/device\/jobs\/([^/]+)\/status$/);
      if (req.method === 'POST' && statusMatch) {
        route = 'device.jobs.status';
        const jobId = decodePathPart(statusMatch[1], (value) => {
          if (!/^[0-9a-f-]{36}$/i.test(value)) throw new ApiError(400, 'INVALID_RUN_ID', 'Run id is invalid');
          return value;
        });
        const update = validateJobUpdate(await readJson(req, config.maxBodyBytes));
        sendJson(res, 200, { run: store.updateJob(authenticatedDevice, jobId, update), serverTime: now() });
        return;
      }

      const flowMatch = path.match(/^\/api\/devices\/([^/]+)\/flows$/);
      if (req.method === 'GET' && flowMatch) {
        route = 'control.flows.list';
        requireSharedKey(req.headers.authorization, 'Bearer', config.controlApiKey);
        const deviceId = decodePathPart(flowMatch[1], validateDeviceId);
        sendJson(res, 200, { ...store.getCatalog(deviceId), serverTime: now() });
        return;
      }

      const runsMatch = path.match(/^\/api\/devices\/([^/]+)\/runs$/);
      if (req.method === 'POST' && runsMatch) {
        route = 'control.runs.create';
        requireSharedKey(req.headers.authorization, 'Bearer', config.controlApiKey);
        const deviceId = decodePathPart(runsMatch[1], validateDeviceId);
        const run = validateRun(await readJson(req, config.maxBodyBytes));
        const created = store.createJob(deviceId, run);
        sendJson(res, 202, { ...created, serverTime: now() });
        return;
      }

      const runMatch = path.match(/^\/api\/devices\/([^/]+)\/runs\/([^/]+)$/);
      if (req.method === 'GET' && runMatch) {
        route = 'control.runs.get';
        requireSharedKey(req.headers.authorization, 'Bearer', config.controlApiKey);
        const deviceId = decodePathPart(runMatch[1], validateDeviceId);
        const jobId = decodePathPart(runMatch[2], (value) => {
          if (!/^[0-9a-f-]{36}$/i.test(value)) throw new ApiError(400, 'INVALID_RUN_ID', 'Run id is invalid');
          return value;
        });
        sendJson(res, 200, { run: store.getJob(deviceId, jobId), serverTime: now() });
        return;
      }

      throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred');
      if (!(error instanceof ApiError)) {
        logger({ level: 'error', event: 'internal_error', requestId: id, route, errorName: error?.name || 'Error' });
      }
      sendJson(res, apiError.status, {
        error: {
          code: apiError.code,
          message: apiError.message,
          requestId: id,
          ...(apiError.details === undefined ? {} : { details: apiError.details }),
        },
      });
    }
  });

  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxRequestsPerSocket = 1_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  async function shutdown(graceMilliseconds = 5_000) {
    store.shutdown();
    if (!server.listening) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        resolve();
      }, graceMilliseconds);
      timer.unref?.();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      server.closeIdleConnections?.();
    });
  }

  return { server, store, shutdown };
}
