#!/bin/bash
# Everything needed on a fresh Mac, in order. Safe to run again.
#   bash scripts/first-run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1;32m▶ %s\033[0m\n' "$1"; }

step "Checking Node (needs 22+)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Node 22+ is required. Install it from https://nodejs.org (LTS) and run this again."; exit 1
fi
node -v

step "Pointing the command-line tools at Xcode (asks for your Mac password)"
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch

step "Pushing to GitHub"
git push || echo "push failed — continuing; push later with: git push"

step "Installing packages"
npm install --no-audit --no-fund

step "Running tests"
npm test

step "Publishing the website + privacy/support pages to Firebase"
command -v firebase >/dev/null || npm install -g firebase-tools
echo "Sign in with the Google account that owns the GCP project skipping-counter-app."
firebase login
firebase projects:addfirebase skipping-counter-app 2>/dev/null || true   # no-op if already added
npm run deploy:web || echo "Firebase deploy failed — continuing with iOS; send the error above to Claude."

step "Creating the iOS project"
if [ -d ios ]; then npm run build && npx cap sync ios && bash scripts/ios-setup.sh
else npm run ios:setup; fi

step "Opening Xcode"
npx cap open ios
cat <<'EOF'

Last two clicks, in Xcode:
  1. Left sidebar: click "App" (blue icon) → tab "Signing & Capabilities" → Team: pick your Apple ID.
  2. Connect the iPhone with a cable, choose it at the top, press ▶.
EOF
