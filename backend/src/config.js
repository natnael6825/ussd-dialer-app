import { isIP } from 'node:net';

import { ApiError } from './errors.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function integer(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function secret(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error(`${name} is required and must contain at least 32 characters`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export function isLoopbackHost(host) {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const allowInsecureRemoteHttp = boolean(env, 'ALLOW_INSECURE_REMOTE_HTTP', false);
  if (!isLoopbackHost(host) && !allowInsecureRemoteHttp) {
    throw new Error(
      'Refusing to expose plain HTTP on a non-loopback HOST. Use an HTTPS reverse proxy/tunnel, or explicitly set ALLOW_INSECURE_REMOTE_HTTP=true for a trusted-LAN test.',
    );
  }

  return Object.freeze({
    host,
    port: integer(env, 'PORT', 8787, 0, 65535),
    controlApiKey: secret(env, 'CONTROL_API_KEY'),
    deviceEnrollmentKey: secret(env, 'DEVICE_ENROLLMENT_KEY'),
    deviceTokenSecret: secret(env, 'DEVICE_TOKEN_SECRET'),
    deviceTokenTtlSeconds: integer(env, 'DEVICE_TOKEN_TTL_SECONDS', 2_592_000, 300, 31_536_000),
    deviceOnlineSeconds: integer(env, 'DEVICE_ONLINE_SECONDS', 60, 15, 600),
    jobDefaultTtlSeconds: integer(env, 'JOB_DEFAULT_TTL_SECONDS', 120, 30, 300),
    jobAckTimeoutSeconds: integer(env, 'JOB_ACK_TIMEOUT_SECONDS', 15, 5, 60),
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 65_536, 1_024, 1_048_576),
    maxDevices: integer(env, 'MAX_DEVICES', 1_000, 1, 100_000),
    maxFlowsPerDevice: integer(env, 'MAX_FLOWS_PER_DEVICE', 500, 1, 5_000),
    maxQueuedJobsPerDevice: integer(env, 'MAX_QUEUED_JOBS_PER_DEVICE', 200, 1, 256),
    maxJobsPerDevice: integer(env, 'MAX_JOBS_PER_DEVICE', 1_000, 10, 20_000),
  });
}

export function validateRuntimeConfig(config) {
  for (const key of ['controlApiKey', 'deviceEnrollmentKey', 'deviceTokenSecret']) {
    if (typeof config[key] !== 'string' || config[key].length < 32) {
      throw new ApiError(500, 'SERVER_CONFIGURATION_ERROR', `${key} must contain at least 32 characters`);
    }
  }
  if (!Number.isInteger(config.maxQueuedJobsPerDevice)
    || config.maxQueuedJobsPerDevice < 1
    || config.maxQueuedJobsPerDevice > 256) {
    throw new ApiError(
      500,
      'SERVER_CONFIGURATION_ERROR',
      'maxQueuedJobsPerDevice must be an integer between 1 and 256',
    );
  }
}
