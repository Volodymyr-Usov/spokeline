#!/bin/bash
# Builds "Spokeline Ears" as a universal (Apple Silicon + Intel) Mac app into the plugin's bin folder.
# Needs only the Xcode command line tools (swiftc). Run: ./ears/build.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/plugins/spokeline/bin/SpokelineEars.app"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/plugins/spokeline/.claude-plugin/plugin.json" | head -1)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

SOURCES=("$HERE"/Sources/*.swift)
FLAGS=(-O -swift-version 5 -framework AppKit -framework AVFoundation -framework Speech -framework Carbon)

for ARCH in arm64 x86_64; do
  echo "Compiling for ${ARCH}..."
  swiftc "${FLAGS[@]}" -target "$ARCH-apple-macos13.0" -o "$BUILD/ears-$ARCH" "${SOURCES[@]}"
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create -output "$APP/Contents/MacOS/SpokelineEars" "$BUILD/ears-arm64" "$BUILD/ears-x86_64"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.spokeline.ears</string>
  <key>CFBundleName</key><string>Spokeline Ears</string>
  <key>CFBundleDisplayName</key><string>Spokeline Ears</string>
  <key>CFBundleExecutable</key><string>SpokelineEars</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Spokeline listens while you hold the push-to-talk key, or for the wake phrase in hands-free mode, so you can talk to Claude Code. Audio never leaves this Mac.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Spokeline turns what you say into text on this Mac (on-device recognition only) and sends it to your Claude Code chat.</string>
</dict>
</plist>
PLIST

# Ad-hoc signature for local use. Public releases are signed and notarized separately (see docs/plan.md, phase 5).
codesign --force --sign - --timestamp=none "$APP" >/dev/null
echo "Built $APP ($(du -sh "$APP" | cut -f1))"
