import { ApiError, assert } from './errors.js';

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const RESERVED_VARIABLES = new Set(['pin', 'password', 'passcode', 'otp', 'secret']);

function validateVariableName(value, message = 'Invalid variable name') {
  assert(
    typeof value === 'string' && VARIABLE_NAME.test(value) && !RESERVED_VARIABLES.has(value),
    400,
    'INVALID_VARIABLE_NAME',
    message,
  );
  return value;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value, allowed, required = allowed) {
  assert(isObject(value), 400, 'INVALID_BODY', 'Request body must be a JSON object');
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.includes(key));
  assert(unknown.length === 0, 400, 'UNKNOWN_FIELD', `Unknown field: ${unknown[0]}`);
  for (const key of required) {
    assert(Object.hasOwn(value, key), 400, 'MISSING_FIELD', `Missing field: ${key}`);
  }
}

function boundedString(value, field, min, max) {
  assert(typeof value === 'string', 400, 'INVALID_FIELD', `${field} must be a string`);
  assert(value.length >= min && value.length <= max, 400, 'INVALID_FIELD', `${field} must contain ${min}-${max} characters`);
  assert(!/[\u0000-\u001f\u007f]/.test(value), 400, 'INVALID_FIELD', `${field} contains unsupported control characters`);
  return value;
}

function trimmedBoundedString(value, field, min, max) {
  assert(typeof value === 'string', 400, 'INVALID_FIELD', `${field} must be a string`);
  return boundedString(value.trim(), field, min, max);
}

export function validateDeviceId(value) {
  assert(typeof value === 'string' && DEVICE_ID.test(value), 400, 'INVALID_DEVICE_ID', 'deviceId must contain 3-80 safe identifier characters');
  return value;
}

export function validateFlowId(value) {
  assert(typeof value === 'string' && FLOW_ID.test(value), 400, 'INVALID_FLOW_ID', 'flowId is invalid');
  return value;
}

export function validateRequestId(value) {
  assert(typeof value === 'string' && REQUEST_ID.test(value), 400, 'INVALID_REQUEST_ID', 'requestId must contain 8-128 safe identifier characters');
  return value;
}

export function validateRegistration(body) {
  exactKeys(body, ['deviceId', 'name'], ['deviceId', 'name']);
  return {
    deviceId: validateDeviceId(body.deviceId),
    name: trimmedBoundedString(body.name, 'name', 1, 80),
  };
}

export function validateHeartbeat(body) {
  exactKeys(body, ['name', 'appVersion', 'androidVersion', 'state', 'pendingJobId'], []);
  assert(
    body.state === undefined || body.state === 'ready' || body.state === 'busy',
    400,
    'INVALID_DEVICE_STATE',
    'state must be ready or busy',
  );
  const pendingJobId = body.pendingJobId === undefined
    ? undefined
    : boundedString(body.pendingJobId, 'pendingJobId', 1, 128);
  assert(
    pendingJobId === undefined || /^[A-Za-z0-9._-]+$/.test(pendingJobId),
    400,
    'INVALID_RUN_ID',
    'pendingJobId is invalid',
  );
  return {
    name: body.name === undefined ? undefined : trimmedBoundedString(body.name, 'name', 1, 80),
    appVersion: body.appVersion === undefined ? undefined : boundedString(body.appVersion, 'appVersion', 1, 30),
    androidVersion: body.androidVersion === undefined ? undefined : boundedString(body.androidVersion, 'androidVersion', 1, 30),
    state: body.state,
    pendingJobId,
  };
}

export function validateCatalog(body, maxFlows) {
  exactKeys(body, ['flows'], ['flows']);
  assert(Array.isArray(body.flows), 400, 'INVALID_CATALOG', 'flows must be an array');
  assert(body.flows.length <= maxFlows, 400, 'CATALOG_TOO_LARGE', `flows cannot contain more than ${maxFlows} entries`);
  const seenIds = new Set();
  return body.flows.map((flow, index) => {
    exactKeys(flow, ['id', 'name', 'requiredVariables', 'updatedAt'], ['id', 'name', 'requiredVariables', 'updatedAt']);
    const id = validateFlowId(flow.id);
    assert(!seenIds.has(id), 400, 'DUPLICATE_FLOW', `Duplicate flow id at flows[${index}]`);
    seenIds.add(id);
    const name = trimmedBoundedString(flow.name, `flows[${index}].name`, 1, 80);
    assert(Array.isArray(flow.requiredVariables) && flow.requiredVariables.length <= 20, 400, 'INVALID_VARIABLES', `flows[${index}].requiredVariables must contain at most 20 names`);
    const requiredVariables = [];
    const seenVariables = new Set();
    for (const variable of flow.requiredVariables) {
      validateVariableName(variable, `Invalid or reserved variable name in flows[${index}]`);
      assert(!seenVariables.has(variable), 400, 'DUPLICATE_VARIABLE', `Duplicate variable ${variable} in flows[${index}]`);
      seenVariables.add(variable);
      requiredVariables.push(variable);
    }
    assert(Number.isSafeInteger(flow.updatedAt) && flow.updatedAt > 0, 400, 'INVALID_UPDATED_AT', `flows[${index}].updatedAt must be a positive integer timestamp`);
    return { id, name, requiredVariables, updatedAt: flow.updatedAt };
  });
}

export function validateRun(body) {
  exactKeys(body, ['flowId', 'variables', 'requestId', 'expiresInSeconds'], ['flowId', 'variables', 'requestId']);
  const flowId = validateFlowId(body.flowId);
  assert(isObject(body.variables), 400, 'INVALID_VARIABLES', 'variables must be a JSON object');
  const variables = Object.create(null);
  for (const [name, value] of Object.entries(body.variables)) {
    validateVariableName(name, `Invalid or reserved variable name: ${name}`);
    boundedString(value, `variables.${name}`, 1, 160);
    assert(value.trim().toLowerCase() !== 'cancel', 400, 'INVALID_VARIABLE_VALUE', `variables.${name} cannot be the CANCEL control command`);
    assert(
      !value.includes('{{') && !value.includes('}}'),
      400,
      'INVALID_VARIABLE_VALUE',
      `variables.${name} cannot contain a nested placeholder`,
    );
    variables[name] = value;
  }
  const requestId = validateRequestId(body.requestId);
  assert(
    body.expiresInSeconds === undefined || (Number.isSafeInteger(body.expiresInSeconds) && body.expiresInSeconds >= 30 && body.expiresInSeconds <= 300),
    400,
    'INVALID_EXPIRY',
    'expiresInSeconds must be an integer between 30 and 300',
  );
  return { flowId, variables, requestId, expiresInSeconds: body.expiresInSeconds };
}

export const JOB_STATUSES = new Set(['accepted', 'running', 'succeeded', 'failed', 'cancelled']);

export function validateJobUpdate(body) {
  exactKeys(body, ['status', 'message', 'sessionId', 'result'], ['status']);
  assert(typeof body.status === 'string' && JOB_STATUSES.has(body.status), 400, 'INVALID_STATUS', 'Unsupported job status');
  const message = body.message === undefined ? undefined : boundedString(body.message, 'message', 1, 200);
  const sessionId = body.sessionId === undefined ? undefined : boundedString(body.sessionId, 'sessionId', 1, 128);
  let result;
  if (body.result !== undefined) {
    exactKeys(body.result, ['sessionId', 'completedSteps', 'totalSteps'], []);
    result = {};
    if (body.result.sessionId !== undefined) result.sessionId = boundedString(body.result.sessionId, 'result.sessionId', 1, 128);
    for (const field of ['completedSteps', 'totalSteps']) {
      if (body.result[field] !== undefined) {
        assert(Number.isSafeInteger(body.result[field]) && body.result[field] >= 0 && body.result[field] <= 1_000, 400, 'INVALID_RESULT', `${field} must be an integer between 0 and 1000`);
        result[field] = body.result[field];
      }
    }
    if (result.completedSteps !== undefined && result.totalSteps !== undefined) {
      assert(result.completedSteps <= result.totalSteps, 400, 'INVALID_RESULT', 'completedSteps cannot exceed totalSteps');
    }
  }
  if (sessionId !== undefined) {
    assert(
      result?.sessionId === undefined || result.sessionId === sessionId,
      400,
      'INVALID_RESULT',
      'sessionId fields must match',
    );
    result = { ...(result || {}), sessionId };
  }
  return { status: body.status, message, result };
}

export function validateWait(value) {
  if (value === null) return 25;
  assert(/^\d+$/.test(value), 400, 'INVALID_WAIT', 'wait must be an integer between 0 and 25');
  const wait = Number(value);
  assert(wait >= 0 && wait <= 25, 400, 'INVALID_WAIT', 'wait must be an integer between 0 and 25');
  return wait;
}
