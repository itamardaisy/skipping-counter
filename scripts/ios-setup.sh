#!/bin/bash
# One-time native setup after `npx cap add ios` (run via `npm run ios:setup`).
# Safe to run again: every step checks before it changes anything.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=ios/App/App
PLIST="$APP/Info.plist"
PB=/usr/libexec/PlistBuddy
[ -f "$PLIST" ] || { echo "No $PLIST — run 'npx cap add ios' first."; exit 1; }

set_key() { # key type value
  $PB -c "Delete :$1" "$PLIST" 2>/dev/null || true
  $PB -c "Add :$1 $2 $3" "$PLIST"
}

# Camera prompt text. Apple rejects apps whose purpose string is vague.
set_key NSCameraUsageDescription string \
  "Skipping Counter watches you through the camera to count your jumps. The video is processed on your iPhone and never leaves it."
# No encryption beyond HTTPS: skips the export-compliance question on every upload.
set_key ITSAppUsesNonExemptEncryption bool false
set_key UIRequiresFullScreen bool true
set_key UIStatusBarStyle string UIStatusBarStyleLightContent

# Portrait only — the layout and the skeleton overlay assume it.
for k in UISupportedInterfaceOrientations "UISupportedInterfaceOrientations~ipad"; do
  $PB -c "Delete :$k" "$PLIST" 2>/dev/null || true
done
$PB -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
$PB -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"

# iPhone only: no iPad layout to review or screenshot.
sed -i '' 's/TARGETED_DEVICE_FAMILY = "1,2";/TARGETED_DEVICE_FAMILY = 1;/g' ios/App/App.xcodeproj/project.pbxproj

# Keep the screen on while the app is open: a set runs for minutes with
# nobody touching the phone, and iOS would otherwise lock mid-set.
if ! grep -q isIdleTimerDisabled "$APP/AppDelegate.swift"; then
  perl -0pi -e 's/(didFinishLaunchingWithOptions[^{]*\{\n)/$1        UIApplication.shared.isIdleTimerDisabled = true\n/' "$APP/AppDelegate.swift"
fi
grep -q isIdleTimerDisabled "$APP/AppDelegate.swift" || echo "warning: could not patch AppDelegate.swift"

# App icon and launch screen.
ICONSET="$APP/Assets.xcassets/AppIcon.appiconset"
for f in "$ICONSET"/*.png; do [ -e "$f" ] && cp resources/icon-1024.png "$f"; done
for f in "$APP"/Assets.xcassets/Splash.imageset/*.png; do [ -e "$f" ] && cp resources/splash-2732.png "$f"; done

echo "iOS project ready. Next: npm run ios"
