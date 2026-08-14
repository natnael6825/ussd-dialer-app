# USSD Flow Android app

This Expo/React Native app creates, records, saves, and replays interactive USSD routes. It includes a native Kotlin module, an accessibility service, and an authenticated foreground listener for the relay in `../backend`.

## Remote flow templates

A saved reply can be a literal value such as `1`, the `CANCEL` command, or a whole-step placeholder such as `{{phone}}` or `{{amount}}`. Placeholders are resolved only when the relay requests that saved flow. They cannot be embedded inside another reply, used in the starting USSD code, nested, or used for `pin`, `password`, `passcode`, `otp`, or `secret`.

Only the flow ID, name, required variable names, and revision time are published in the catalog. Saved codes, literal replies, carrier responses, and history stay on the phone. API variable values necessarily pass through relay memory on their way to the phone, but are omitted from relay logs and status responses.

## Recording and queue controls

Recording stores only replies confirmed by a Send tap in a validated USSD dialog. Replayed Android accessibility callbacks are ignored, an unsent draft is discarded when Cancel is tapped, and `CANCEL` is saved as the final step. If Android provides no safe signal between two identical carrier menus, the recorder deliberately skips the ambiguous step instead of guessing and creating a duplicate; always review the captured path before saving it.

The Queue tab shows safe metadata for remote runs that have not yet been delivered to the phone. A queued run can be cancelled there after confirmation. Once delivery has begun, the app refuses deletion because its outcome may already be in progress or unknown. Queue inspection does not make a paused background listener appear online.

`Clear path` removes only the reply steps in the current editor draft. It does not remove the starting code, selected SIM, saved flows, session history, or backend configuration.

## Background behavior

The listener is a user-started Android foreground service with a persistent Stop notification. It reconnects with backoff after ordinary network or process interruptions and keeps accepted instructions in encrypted local storage.

Android does not allow the app to unlock a secure phone. A request received while locked waits only until its short expiry and runs after the user unlocks. Doze, force-stop, OEM battery restrictions, loss of signal, revoked permissions, or a disabled accessibility service can still prevent background work. An uncertain transaction is never dialed again automatically.

## Development

The app does not run in Expo Go. Use a physical Android phone with an active SIM:

```sh
cd app
npm install
npx expo prebuild --platform android
npm run android
```

For a USB-connected debug phone, expose the local relay with:

```sh
adb reverse tcp:8787 tcp:8787
```

Then enter `http://127.0.0.1:8787` on the first setup screen. Plain HTTP localhost is accepted only in debug builds; release builds require HTTPS.

After enrollment, the backend card shows a selectable device ID. The same ID is returned by the relay's authenticated `GET /api/devices` endpoint.

On Android 13, a sideloaded build may require **Allow restricted settings** from the app's system information screen before its accessibility service can be enabled.

## Compatibility and privacy

- Minimum Android version: Android 7.0 / API 24.
- Direct `sendUssdRequest` response capture needs Android 8.0+, while saved accessibility flows retain the Android 7 path.
- Local strings, including flows, history, backend credentials, and pending instructions, are protected with Android Keystore AES-GCM storage.
- Screen capture is disabled for the app window and Android backup is disabled.
