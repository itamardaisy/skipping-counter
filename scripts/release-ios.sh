#!/bin/bash
# Build a signed release and upload it to App Store Connect, without opening
# Xcode's UI. Uses the Apple account already signed in to Xcode.
#   bash scripts/release-ios.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID="${TEAM_ID:-38L2KDLYD8}"   # Itamar Daisy — Apple Developer Program (Individual)
BUILD="$(date +%Y%m%d%H%M)"        # build numbers must only ever increase
OUT=build/ios

echo "▶ Building web app and syncing into the iOS project"
npm run build
npx cap sync ios

rm -rf "$OUT" && mkdir -p "$OUT"
cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

echo "▶ Archiving (build ${BUILD})"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/App.xcarchive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD" \
  archive | grep -E '^(\*\*|error:|warning: .*sign)|ARCHIVE' || true
[ -d "$OUT/App.xcarchive" ] || { echo "Archive failed — run again without the grep to see the full log."; exit 1; }

echo "▶ Uploading to App Store Connect"
xcodebuild -exportArchive -archivePath "$OUT/App.xcarchive" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" \
  -allowProvisioningUpdates

echo
echo "✔ Uploaded build ${BUILD}. It appears in App Store Connect → TestFlight after Apple processes it (5–30 min)."
