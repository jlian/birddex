#!/usr/bin/env bash
set -euo pipefail

VITE_PORT="${VITE_PORT:-5000}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pkill -f "${ROOT_DIR}/node_modules/@cloudflare/workerd-.*/bin/workerd serve" >/dev/null 2>&1 || true
pkill -f "${ROOT_DIR}/node_modules/.*/@esbuild/.*/bin/esbuild --service" >/dev/null 2>&1 || true
pkill -f "${ROOT_DIR}/node_modules/.bin/vite --port ${VITE_PORT} --strictPort" >/dev/null 2>&1 || true

PIDS="$(lsof -t -nP -iTCP:"${VITE_PORT}" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' || true)"
if [[ -n "${PIDS// }" ]]; then
  kill ${PIDS} >/dev/null 2>&1 || true
fi
