const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');

const releaseManifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
  xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" tools:node="remove" />
  <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" tools:node="remove" />
  <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" tools:node="remove" />
  <uses-permission android:name="android.permission.VIBRATE" tools:node="remove" />
</manifest>
`;

module.exports = function withAndroidReleaseHardening(config) {
  config = withAppBuildGradle(config, (modConfig) => {
    const buildDirectoryOverride = `def ussdFlowAndroidBuildDir = System.getenv("USSD_FLOW_ANDROID_BUILD_DIR")
if (ussdFlowAndroidBuildDir) {
    layout.buildDirectory.set(file(ussdFlowAndroidBuildDir))
}

`;

    if (!modConfig.modResults.contents.includes('def ussdFlowAndroidBuildDir =')) {
      const androidBlockStart = modConfig.modResults.contents.indexOf('android {');
      if (androidBlockStart < 0) {
        throw new Error('Could not configure the external Android release build directory.');
      }
      modConfig.modResults.contents =
        modConfig.modResults.contents.slice(0, androidBlockStart) +
        buildDirectoryOverride +
        modConfig.modResults.contents.slice(androidBlockStart);
    }

    const buildTypesStart = modConfig.modResults.contents.indexOf('buildTypes {');
    const releaseStart = modConfig.modResults.contents.indexOf('release {', buildTypesStart);

    if (buildTypesStart < 0 || releaseStart < 0) {
      throw new Error('Could not find the generated Android release build type.');
    }

    const beforeRelease = modConfig.modResults.contents.slice(0, releaseStart);
    let releaseAndAfter = modConfig.modResults.contents.slice(releaseStart);
    const releaseDebugSigning = /^\s*signingConfig signingConfigs\.debug\s*$/m;

    if (!releaseDebugSigning.test(releaseAndAfter)) {
      throw new Error('Could not remove the generated debug signing config from the release build.');
    }

    releaseAndAfter = releaseAndAfter.replace(
      releaseDebugSigning,
      '            // Sign the optimized APK separately with the private release key.',
    );
    modConfig.modResults.contents = beforeRelease + releaseAndAfter;
    return modConfig;
  });

  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const releaseDirectory = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'release',
      );
      fs.mkdirSync(releaseDirectory, { recursive: true });
      fs.writeFileSync(path.join(releaseDirectory, 'AndroidManifest.xml'), releaseManifest);
      return modConfig;
    },
  ]);
};
