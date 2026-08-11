#!/bin/bash

set -euo pipefail

VERSION="2.46.0"
SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"
INSTALL_ROOT="${RUNNER_TEMP:-/tmp}/xcodegen-${VERSION}"
ARCHIVE="${INSTALL_ROOT}.zip"

rm -rf "$INSTALL_ROOT" "$ARCHIVE"
mkdir -p "$INSTALL_ROOT"

curl --fail --silent --show-error --location --retry 3 \
  --output "$ARCHIVE" \
  "https://github.com/yonaskolb/XcodeGen/releases/download/${VERSION}/xcodegen.zip"
echo "${SHA256}  ${ARCHIVE}" | shasum --algorithm 256 --check
unzip -q "$ARCHIVE" -d "$INSTALL_ROOT"

mkdir -p "$INSTALL_ROOT/install"
PREFIX="$INSTALL_ROOT/install" bash "$INSTALL_ROOT/xcodegen/install.sh"
echo "$INSTALL_ROOT/install/bin" >> "${GITHUB_PATH:?}"
"$INSTALL_ROOT/install/bin/xcodegen" --version
