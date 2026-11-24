#!/bin/bash
# Runs the Windows helper's logic tests (works on macOS too).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DOTNET="${DOTNET:-$HOME/.dotnet/dotnet}"
command -v "$DOTNET" >/dev/null 2>&1 || DOTNET=dotnet
"$DOTNET" run --project "$HERE/EarsTests.csproj"
