#!/usr/bin/env bash
# Builds the Android app (APK) from the web app in the repo root. Needs Node, JDK 17 and the Android SDK
# (the GitHub Actions runner has them). Output: android-app/practice-log.apk
set -euo pipefail
cd "$(dirname "$0")"
rm -rf www && mkdir -p www
cp -r ../index.html ../manifest.webmanifest ../sw.js ../icons ../camera www/
rm -f www/camera/index.html
npm install --no-audit --no-fund
[ -d android ] || npx cap add android
npx cap sync android
# camera access for the web view, and keep the screen on is handled by the page's wake lock
M=android/app/src/main/AndroidManifest.xml
grep -q android.permission.CAMERA "$M" || sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#&\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />#' "$M"
# app icon from the web app's icon
for d in mipmap-mdpi mipmap-hdpi mipmap-xhdpi mipmap-xxhdpi mipmap-xxxhdpi; do
  for f in ic_launcher.png ic_launcher_round.png ic_launcher_foreground.png; do
    [ -f "android/app/src/main/res/$d/$f" ] && cp ../icons/icon-192.png "android/app/src/main/res/$d/$f"
  done
done
rm -f android/app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml
# version from the commit count, so each build installs over the last one
VC=$(git rev-list --count HEAD 2>/dev/null || echo 1)
sed -i "s/versionCode [0-9]*/versionCode $VC/; s/versionName \"[^\"]*\"/versionName \"1.$VC\"/" android/app/build.gradle
# Signing: with a key in ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD (repository secrets) every build
# is signed the same way, so updates install over the old app and keep its data. Without them the APK is
# signed with a throwaway debug key, and a new one has to replace the old app (Backup first).
if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > practice-log.keystore
  cat >> android/app/build.gradle <<'GRADLE'
android {
    signingConfigs {
        practice {
            storeFile file("../../practice-log.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "practicelog"
            keyPassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
        }
    }
    buildTypes { release { signingConfig signingConfigs.practice; minifyEnabled false } }
}
GRADLE
else
  cat >> android/app/build.gradle <<'GRADLE'
android { buildTypes { release { signingConfig signingConfigs.debug; minifyEnabled false } } }
GRADLE
fi
(cd android && chmod +x gradlew && ./gradlew --no-daemon assembleRelease)
cp android/app/build/outputs/apk/release/app-release.apk practice-log.apk
ls -la practice-log.apk
