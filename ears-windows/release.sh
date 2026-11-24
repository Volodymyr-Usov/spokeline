#!/bin/bash
# Publishes the Windows helper that build.sh made as a download on the project's GitHub releases page,
# and writes its version and SHA-256 fingerprint into the plugin (hooks/register.js, the WIN_EARS line).
# The plugin downloads it from there the first time it starts on Windows and checks the fingerprint.
# Raise <Version> in SpokelineEars.csproj before each new build. Needs the GitHub command line tool (gh).
# Run: ./ears-windows/build.sh && ./ears-windows/release.sh   then commit and push hooks/register.js.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="Volodymyr-Usov/spokeline"
EXE="$ROOT/plugins/spokeline/bin/windows/SpokelineEars.exe"
JS="$ROOT/plugins/spokeline/hooks/register.js"
VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$HERE/SpokelineEars.csproj" | head -1)"
TAG="ears-windows-$VERSION"

[ -f "$EXE" ] || { echo "No Windows helper found. Build it first: ./ears-windows/build.sh"; exit 1; }
[ -n "$VERSION" ] || { echo "No <Version> found in SpokelineEars.csproj"; exit 1; }
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "Version $VERSION is already published. Raise <Version> in ears-windows/SpokelineEars.csproj, build again, then run this."
  exit 1
fi

if command -v shasum >/dev/null; then SHA="$(shasum -a 256 "$EXE" | cut -d' ' -f1)"; else SHA="$(sha256sum "$EXE" | cut -d' ' -f1)"; fi

perl -pi -e "s|^const WIN_EARS = .*|const WIN_EARS = { version: '$VERSION', sha256: '$SHA' }|" "$JS"
grep -q "sha256: '$SHA'" "$JS" || { echo "Could not write the fingerprint into $JS"; exit 1; }

gh release create "$TAG" "$EXE" -R "$REPO" --target main \
  --title "Spokeline Ears for Windows $VERSION" \
  --notes "The Windows helper of Spokeline: it listens to the microphone and speaks the answers.
You do not need to download it by hand: the Spokeline plugin fetches it by itself the first time it starts on Windows.

SHA-256: $SHA"

echo "Published $TAG ($SHA)."
echo "Now commit and push plugins/spokeline/hooks/register.js, so the plugin downloads this version."
