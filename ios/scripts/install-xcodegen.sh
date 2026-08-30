#!/bin/bash

set -euo pipefail

VERSION="2.46.0"
SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"
INSTALL_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/wingdex/xcodegen-${VERSION}"
ARCHIVE="${INSTALL_ROOT}.zip"
BIN="$INSTALL_ROOT/install/bin/xcodegen"
MARKER="$INSTALL_ROOT/.archive-sha256"

if [[ -x "$BIN" && -f "$MARKER" && "$(cat "$MARKER")" == "$SHA256" ]]; then
  echo "$INSTALL_ROOT/install/bin" >> "${GITHUB_PATH:-/dev/null}"
  "$BIN" --version
  exit 0
fi

rm -rf "$INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT"

if [[ ! -f "$ARCHIVE" ]] || ! echo "${SHA256}  ${ARCHIVE}" | shasum --algorithm 256 --check --status; then
  rm -f "$ARCHIVE"
  curl --fail --silent --show-error --location --retry 3 \
    --output "$ARCHIVE" \
    "https://github.com/yonaskolb/XcodeGen/releases/download/${VERSION}/xcodegen.zip"
fi
echo "${SHA256}  ${ARCHIVE}" | shasum --algorithm 256 --check
unzip -q "$ARCHIVE" -d "$INSTALL_ROOT"

mkdir -p "$INSTALL_ROOT/install"
PREFIX="$INSTALL_ROOT/install" bash "$INSTALL_ROOT/xcodegen/install.sh"
echo "$SHA256" > "$MARKER"
echo "$INSTALL_ROOT/install/bin" >> "${GITHUB_PATH:-/dev/null}"
"$BIN" --version
