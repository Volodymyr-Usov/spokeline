#!/bin/bash
# Builds Spokeline Ears for Windows (x64) into the plugin's bin/windows folder. That folder is not saved in
# git: ./ears-windows/release.sh publishes the build as a download the plugin fetches on Windows.
# Works on macOS, Linux or Windows with the .NET SDK (10 or later). Run: ./ears-windows/build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DOTNET="${DOTNET:-$(command -v dotnet || echo "$HOME/.dotnet/dotnet")}"
OUT="$ROOT/plugins/spokeline/bin/windows"
rm -rf "$OUT"
"$DOTNET" publish "$HERE/SpokelineEars.csproj" -c Release -o "$OUT" -nologo -v quiet
rm -f "$OUT"/*.pdb
echo "Built $OUT ($(du -sh "$OUT" | cut -f1)):"
ls -la "$OUT"
