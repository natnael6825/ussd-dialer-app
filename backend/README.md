# USSD Flow relay (prototype)

This service lets an authenticated system queue a saved flow on an Android phone without exposing an HTTP server on the phone. The phone makes outbound heartbeat, catalog-sync, and long-poll requests to this relay.

The prototype has no database. Device catalogs, queued runs, results, and idempotency records are held in memory and are lost whenever the process restarts. Signed device tokens remain valid across restarts, so the phone can reconnect and upload its catalog again without enrolling again.

## Safety model

- A control client can select only a saved flow ID and provide its declared variables. It cannot upload USSD codes or arbitrary reply steps.
- Variable names are lowercase identifiers such as `phone` or `amount`. `pin`, `password`, `passcode`, `otp`, and `secret` are prohibited. A variable value equal to `CANCEL` (case-insensitive) is also prohibited.
- Variables must exactly match the selected flow: missing and additional variables are rejected.
- Every instruction expires after 120 seconds by default. A caller can choose 30-300 seconds.
- Each phone can have at most 200 waiting runs by default. `MAX_QUEUED_JOBS_PER_DEVICE` can be set from 1 to 256; excess new runs fail with `429 DEVICE_QUEUE_CAPACITY_REACHED`. Exact retries with an existing `requestId` still return their original run.
- Delivery is at-most-once. After a job is returned to a phone it is never automatically delivered again, even if the connection breaks. Its state becomes `delivery_uncertain` until the phone confirms acceptance. This deliberately favors avoiding duplicate money transfers over automatic retry.
- When an accepted job passes its deadline, the relay reports `outcome_uncertain` because a lost `running` update means it cannot prove whether USSD started. Callers must not retry it; only the authenticated phone can reconcile it to `running` or a terminal result. A known-running job does not automatically retry or expire server-side.
- The external result contains status and step counts, not input variables or full carrier responses. Detailed USSD history remains on the phone.
- Request logs contain route names, status codes, timing, and request IDs—never authorization headers, request bodies, variables, or carrier responses.

This is still a prototype, not a complete payment system. Add durable storage, device revocation, user/role authorization, auditing, rate limits, monitoring, and a threat review before production use.

## Requirements and setup

- Node.js 20.19 or newer
- An HTTPS URL that the phone can reach

```sh
cd backend
cp .env.example .env
```

Generate three independent secrets and place them in `.env`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then start the relay:

```sh
npm start
```

It binds to `127.0.0.1:8787` by default. For a real phone, use an HTTPS reverse proxy or secure tunnel to this loopback listener. Never send control, enrollment, or device credentials over plain internet HTTP.

The server refuses a non-loopback `HOST` unless `ALLOW_INSECURE_REMOTE_HTTP=true` is explicitly set. That override is only for a temporary, trusted-LAN test; it does not make HTTP secure. A host firewall and an isolated network are still required.

The `CONTROL_API_KEY` belongs only in the system calling the control endpoints. The phone uses `DEVICE_ENROLLMENT_KEY` once to receive its own signed `deviceToken`, then stores that device token in Android secure storage.

Treat `CONTROL_API_KEY` as transaction authority, not as a general client key. It can trigger every flow in a phone's published catalog, including a flow containing secret literal steps that never leave that phone. API variable values pass through this process's memory while queued, but are excluded from request logs and public status responses.

## Response and error format

Timestamps are Unix milliseconds. Successful responses include `serverTime`. Failures use:

```json
{
  "error": {
    "code": "VARIABLE_MISMATCH",
    "message": "Variables must exactly match the saved flow requirements",
    "requestId": "d8bdf45a-...",
    "details": { "missing": ["amount"], "extra": [] }
  }
}
```

Clients may send a safe 8-128 character `X-Request-Id`; otherwise the relay creates one. Error codes, rather than message text, should drive client behavior.

## Device API

### Enroll a phone

`POST /api/device/register`

```sh
curl -X POST https://relay.example/api/device/register \
  -H "Authorization: Bearer $DEVICE_ENROLLMENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"samsung-m12-01","name":"Counter phone"}'
```

Response:

```json
{
  "deviceId": "samsung-m12-01",
  "device": {
    "id": "samsung-m12-01",
    "name": "Counter phone",
    "online": true,
    "lastSeenAt": 1786620000000
  },
  "deviceToken": "d1.eyJ2Ijo...",
  "tokenExpiresAt": 1789212000000,
  "serverTime": 1786620000000
}
```

All remaining device calls use `Authorization: Device <deviceToken>`.

### Heartbeat

`POST /api/device/heartbeat`

```json
{
  "state": "busy",
  "pendingJobId": "8b90e4d3-..."
}
```

All fields are optional, but the body must be a JSON object. The device may additionally report `name`, `appVersion`, and `androidVersion`. `catalogRequired: true` means the relay restarted or has no current catalog, so the phone must sync it.

### Replace the saved-flow catalog

`PUT /api/device/catalog`

```json
{
  "flows": [
    {
      "id": "send-money",
      "name": "Send money",
      "requiredVariables": ["phone", "amount"],
      "updatedAt": 1786620000000
    }
  ]
}
```

`updatedAt` is part of the execution safety check. The phone must refuse a queued job when its `flowUpdatedAt` no longer matches the locally saved flow.
Each flow may declare up to 20 required variables.

### Inspect queued remote runs

`GET /api/device/jobs`

```sh
curl https://relay.example/api/device/jobs \
  -H "Authorization: Device $DEVICE_TOKEN"
```

Response:

```json
{
  "jobs": [
    {
      "id": "8b90e4d3-...",
      "flowId": "send-money",
      "flowName": "Send money",
      "status": "queued",
      "createdAt": 1786620010000,
      "expiresAt": 1786620130000
    }
  ],
  "serverTime": 1786620011000
}
```

This device-only endpoint returns queued runs belonging to the authenticated phone. It deliberately omits variables, request IDs, USSD codes, literal replies, tokens, results, and carrier responses. Inspecting the queue does not count as listener activity and therefore does not make an offline phone appear available for new control runs.

### Cancel a run before delivery

`DELETE /api/device/jobs/:jobId`

```sh
curl -X DELETE https://relay.example/api/device/jobs/8b90e4d3-... \
  -H "Authorization: Device $DEVICE_TOKEN"
```

A successful response is `200` with `{ "job": { ...safeMetadata, "status": "cancelled" } }`. This is a cancellation state transition, not a hard deletion: the run and its idempotency record remain reserved. Retrying the original control request with the same `requestId` therefore returns the same cancelled run instead of creating another transfer.

Only `queued` runs can be cancelled here. Once a long poll has delivered a run, its outcome may already be in progress or unknown; `delivery_uncertain`, `accepted`, `running`, `outcome_uncertain`, and terminal runs return `409 RUN_NOT_CANCELLABLE` with `details.currentStatus`. A token for another phone receives `404 RUN_NOT_FOUND`. Repeating DELETE for a run already cancelled through this pre-delivery endpoint is idempotent and returns `200`. Cancelling from the queue UI also does not refresh listener liveness; heartbeats, catalog sync, job polling, and job status updates do.

### Poll for one job

`GET /api/device/jobs/next?wait=25`

`wait` can be 0-25 seconds. The endpoint returns `204 No Content` when no job is available, otherwise:

```json
{
  "job": {
    "id": "8b90e4d3-...",
    "flowId": "send-money",
    "flowUpdatedAt": 1786620000000,
    "variables": { "phone": "0911000000", "amount": "25" },
    "createdAt": 1786620010000,
    "expiresAt": 1786620130000
  },
  "serverTime": 1786620011000
}
```

Only one long poll may be active per device. Before replying `accepted`, the app should durably save the job ID and instruction. If the device is locked and execution must wait, it can acknowledge with a message such as `Persisted; waiting for unlock`, but it must fail or discard the job when `expiresAt` is reached. It must never redial a job merely because a status request failed. If the relay sees an accepted job pass that deadline, it cannot prove whether the phone was waiting or a `running` update was lost, so it exposes the non-retryable `outcome_uncertain` state until the phone reports `running`, `succeeded`, `failed`, or `cancelled`.

### Update run status/result

`POST /api/device/jobs/:jobId/status`

Allowed progression is:

```text
delivery_uncertain -> accepted -> running -> succeeded
                              \-> failed | cancelled
                     \-> outcome_uncertain -> running -> succeeded | failed | cancelled
                                           \-> succeeded | failed | cancelled
```

The relay also accepts a terminal status directly from `accepted`. This reconciles a completed device execution when its intermediate `running` update was lost; it does not redeliver or rerun the instruction. A `409` status conflict includes `error.code` plus `details.currentStatus` and `details.requestedStatus` for deterministic device recovery.

`failed` or `cancelled` can also be reported immediately after delivery. Example:

```json
{
  "status": "succeeded",
  "message": "USSD flow completed",
  "sessionId": "local-session-123",
  "result": {
    "completedSteps": 3,
    "totalSteps": 3
  }
}
```

Do not put variable values, PINs, full carrier responses, or other sensitive information in `message` or `result`.

## Control API

All control calls use `Authorization: Bearer <CONTROL_API_KEY>`.

### Discover registered phones

`GET /api/devices`

```sh
curl https://relay.example/api/devices \
  -H "Authorization: Bearer $CONTROL_API_KEY"
```

Response:

```json
{
  "devices": [
    {
      "id": "samsung-m12-01",
      "name": "Counter phone",
      "online": true,
      "lastSeenAt": 1786620011000,
      "appVersion": "1.1.0",
      "androidVersion": "13",
      "state": "ready"
    }
  ],
  "serverTime": 1786620012000
}
```

This discovery response contains safe device status metadata only. It never includes device credentials, flow catalogs, variables, job instructions, or USSD responses. A busy device may include its non-secret `pendingJobId`.

### List a phone's saved flows

`GET /api/devices/:deviceId/flows`

```sh
curl https://relay.example/api/devices/samsung-m12-01/flows \
  -H "Authorization: Bearer $CONTROL_API_KEY"
```

Response includes connection state and the last in-memory catalog:

```json
{
  "device": {
    "id": "samsung-m12-01",
    "name": "Counter phone",
    "online": true,
    "lastSeenAt": 1786620011000
  },
  "catalogUpdatedAt": 1786620000000,
  "flows": [
    {
      "id": "send-money",
      "name": "Send money",
      "requiredVariables": ["phone", "amount"],
      "updatedAt": 1786620000000
    }
  ],
  "serverTime": 1786620012000
}
```

### Queue a saved flow

`POST /api/devices/:deviceId/runs`

```sh
curl -X POST https://relay.example/api/devices/samsung-m12-01/runs \
  -H "Authorization: Bearer $CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "flowId":"send-money",
    "variables":{"phone":"0911000000","amount":"25"},
    "requestId":"transfer-20260813-0001",
    "expiresInSeconds":120
  }'
```

The response is `202 Accepted` with `{ "run": {...}, "duplicate": false }`. `requestId` is required: supply a globally unique value for every intended action. Repeating exactly the same request returns the original run with `duplicate: true`, even if the device later goes offline or changes its flow catalog. Reusing its ID for different variables or expiry returns `409 REQUEST_ID_CONFLICT`.

The relay rejects the request with `503 DEVICE_OFFLINE` rather than allowing a financial instruction to wait indefinitely. It also never returns input variables through the control status endpoints.

### Read run status

`GET /api/devices/:deviceId/runs/:runId`

Statuses are `queued`, `delivery_uncertain`, `accepted`, `running`, `outcome_uncertain`, `succeeded`, `failed`, `cancelled`, or `expired`.

`delivery_uncertain` means the relay sent the instruction but did not receive durable acceptance. Never submit it automatically again: first reconcile with the phone and the underlying account/network.

`outcome_uncertain` means the phone durably accepted the instruction but its deadline passed without a known execution state. It is not a retryable expiry. Only the authenticated phone may move it to `running` or a terminal result. Wait for device reconciliation and verify the underlying account/network before taking any new action.

### Health check

`GET /health` is unauthenticated and reveals only service health, server time, and the fact that storage is in memory.

## Tests

```sh
npm test
```

The built-in Node test suite covers authentication, catalog and variable validation, idempotency, at-most-once delivery, state transitions, expiry, request-size limits, local-only defaults, and signed-token reconnect after restart.

The process handles `SIGINT` and `SIGTERM`, ends outstanding long polls, stops accepting new runs, and closes connections gracefully.
