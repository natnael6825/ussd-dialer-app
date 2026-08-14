import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { ApiError } from './errors.js';

function constantTimeTextEqual(actual, expected) {
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function credential(header, scheme) {
  if (typeof header !== 'string') return '';
  const prefix = `${scheme} `;
  if (!header.startsWith(prefix)) return '';
  return header.slice(prefix.length);
}

export function requireSharedKey(header, scheme, expected, code = 'UNAUTHORIZED') {
  const supplied = credential(header, scheme);
  if (!constantTimeTextEqual(supplied, expected)) {
    throw new ApiError(401, code, 'Authentication failed');
  }
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

export function issueDeviceToken(deviceId, secret, ttlSeconds, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    d: deviceId,
    i: issuedAt,
    e: issuedAt + ttlSeconds,
    n: randomBytes(8).toString('base64url'),
  })).toString('base64url');
  return `d1.${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function verifyDeviceToken(header, secret, now = Date.now()) {
  const token = credential(header, 'Device');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'd1') {
    throw new ApiError(401, 'DEVICE_UNAUTHORIZED', 'Device authentication failed');
  }

  const [, encodedPayload, encodedSignature] = parts;
  let suppliedSignature;
  let payload;
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(401, 'DEVICE_UNAUTHORIZED', 'Device authentication failed');
  }
  const expectedSignature = signature(encodedPayload, secret);
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new ApiError(401, 'DEVICE_UNAUTHORIZED', 'Device authentication failed');
  }
  if (
    payload?.v !== 1
    || typeof payload.d !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(payload.d)
    || !Number.isSafeInteger(payload.i)
    || !Number.isSafeInteger(payload.e)
    || payload.e <= Math.floor(now / 1000)
  ) {
    throw new ApiError(401, 'DEVICE_TOKEN_EXPIRED', 'Device token is invalid or expired; register the device again');
  }
  return { deviceId: payload.d, issuedAt: payload.i * 1000, expiresAt: payload.e * 1000 };
}
