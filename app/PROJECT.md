# USSD Flow API dialer

This branch adds an authenticated Node.js relay to the Android USSD Flow app. A controller can discover locally saved flow templates and request one by ID with exact variable values. The phone makes outbound requests to the relay; it does not expose an HTTP server.

```text
controller -> ../backend relay <- outbound foreground listener <- this Android app
```

## Repository

- This directory — Expo/React Native Android app and native Kotlin services.
- `../backend/` — dependency-free Node.js 20 relay, API documentation, and tests.

## Start the prototype backend

```sh
cd ../backend
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm test
npm start
```

Generate a different value for each of `CONTROL_API_KEY`, `DEVICE_ENROLLMENT_KEY`, and `DEVICE_TOKEN_SECRET`. The relay binds to `127.0.0.1:8787` by default. Use HTTPS for a real phone; a USB debug build can reach the loopback server with `adb reverse tcp:8787 tcp:8787`.

On first launch, the app asks for the backend URL, a device name, and the one-time enrollment key. After enrollment it opens the normal dialer interface and publishes only safe flow metadata.

## Control API

Use `Authorization: Bearer <CONTROL_API_KEY>`:

- `GET /api/devices` lists enrolled phones and their connection state.
- `GET /api/devices/:deviceId/flows` lists `{id, name, requiredVariables, updatedAt}`.
- `POST /api/devices/:deviceId/runs` accepts `{flowId, variables, requestId, expiresInSeconds}` and returns `202`.
- `GET /api/devices/:deviceId/runs/:runId` returns execution state.

See [../backend/README.md](../backend/README.md) for the full device contract and curl examples.

## Safety limits

- The API cannot provide an arbitrary USSD code or reply list; it can run only a locally saved flow ID.
- Treat `CONTROL_API_KEY` as transaction authority: it can trigger every cataloged flow, including flows whose secret literal steps remain stored only on the phone.
- Placeholders must occupy a whole reply, for example `{{phone}}` or `{{amount}}`. Secret placeholders such as PIN, password, passcode, OTP, and secret are rejected.
- Requests are short-lived, one run executes at a time, the saved SIM must still exist, and uncertain execution is never automatically retried.
- A secure Android lock screen cannot be bypassed. Locked requests wait until unlock or expire.
- This no-database backend intentionally loses catalogs, jobs, results, and idempotency state when restarted. It is suitable for integration testing, not production money movement. Durable storage, authorization, audit, revocation, rate limiting, and operational monitoring are required before production use.
