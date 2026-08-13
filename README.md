# USSD Dialer App

USSD Flow is an Android-first Expo application for creating, recording, saving, and replaying interactive USSD menu routes.

## Features

- Select an active SIM before dialing on dual-SIM phones.
- Send one reply only after the carrier returns the next USSD menu.
- Add `CANCEL` as a flow step to end a session.
- Record replies from a manually completed USSD session.
- Save reusable flows locally on the device.
- Store carrier responses as session-based history.
- Inspect history in an expandable table with a detailed response timeline.
- Support Android 7.0 and newer, with direct-response testing on Android 8.0+.

## Development

The project contains a local Kotlin module and Android accessibility service, so it requires a native development build and does not run in Expo Go.

```sh
npm install
npx expo prebuild --platform android
npm run android
```

Connect a physical Android phone with an active SIM and USB debugging enabled. Carrier USSD services generally cannot be tested using an emulator.

## Privacy

Saved flows and session history remain in local Android app storage. The accessibility service responds only while a flow or recording is active.
