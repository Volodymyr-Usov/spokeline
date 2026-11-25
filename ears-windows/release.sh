#!/bin/bash
# Publishes a new Windows helper. GitHub builds it on its own Windows computers from the code on GitHub main
# (.github/workflows/windows-helper.yml), runs its tests and puts it on the project's releases page. This script
# starts that build, waits for it, downloads the result, and writes its version and SHA-256 fingerprint into the
# plugin (hooks/register.js, the WIN_EARS line). The plugin downloads the helper from the releases page the first
# time it starts on Windows, and checks the fingerprint.
# Before: raise <Version> in ears-windows/SpokelineEars.csproj and push it to GitHub main.
# After: raise "version" in plugins/spokeline/.claude-plugin/plugin.json, then commit and push both files.
# Needs the GitHub command line tool (gh), signed in. Run: ./ears-windows/release.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="Volodymyr-Usov/spokeline"
WORKFLOW="windows-helper.yml"
JS="$ROOT/plugins/spokeline/hooks/register.js"
version_in() { sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' | head -1; }
VERSION="$(version_in < "$HERE/SpokelineEars.csproj")"
TAG="ears-windows-$VERSION"

[ -n "$VERSION" ] || { echo "No <Version> found in SpokelineEars.csproj"; exit 1; }
ON_GITHUB="$(gh api "repos/$REPO/contents/ears-windows/SpokelineEars.csproj?ref=main" -H 'Accept: application/vnd.github.raw' | version_in)"
[ "$ON_GITHUB" = "$VERSION" ] || { echo "GitHub main has version $ON_GITHUB, this folder has $VERSION. Push SpokelineEars.csproj first."; exit 1; }
if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  echo "Version $VERSION is already published. Raise <Version> in ears-windows/SpokelineEars.csproj, push it, then run this."
  exit 1
fi

last_run() { gh run list -R "$REPO" -w "$WORKFLOW" -L 1 --json databaseId --jq '.[0].databaseId // 0'; }
BEFORE="$(last_run)"
gh workflow run "$WORKFLOW" -R "$REPO" --ref main
RUN="$BEFORE"
for _ in $(seq 1 30); do
  sleep 2
  RUN="$(last_run)"
  [ "$RUN" != "$BEFORE" ] && break
done
[ "$RUN" != "$BEFORE" ] || { echo "The build on GitHub did not start."; exit 1; }
echo "GitHub is building the Windows helper $VERSION (about 5 minutes): https://github.com/$REPO/actions/runs/$RUN"
gh run watch "$RUN" -R "$REPO" --exit-status >/dev/null || { echo "The build failed. See the link above."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh release download "$TAG" -R "$REPO" -p SpokelineEars.exe -D "$TMP"
if command -v shasum >/dev/null; then SHA="$(shasum -a 256 "$TMP/SpokelineEars.exe" | cut -d' ' -f1)"; else SHA="$(sha256sum "$TMP/SpokelineEars.exe" | cut -d' ' -f1)"; fi
gh release view "$TAG" -R "$REPO" --json body --jq .body | grep -q "$SHA" || { echo "The downloaded file does not match the fingerprint on the releases page."; exit 1; }

perl -pi -e "s|^const WIN_EARS = .*|const WIN_EARS = { version: '$VERSION', sha256: '$SHA' }|" "$JS"
grep -q "sha256: '$SHA'" "$JS" || { echo "Could not write the fingerprint into $JS"; exit 1; }

echo "Published $TAG: $(wc -c < "$TMP/SpokelineEars.exe" | tr -d ' ') bytes, SHA-256 $SHA."
echo "Now raise \"version\" in plugins/spokeline/.claude-plugin/plugin.json, then commit and push it with hooks/register.js."
