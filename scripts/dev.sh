#!/usr/bin/env bash
set -euo pipefail

VITE_PORT="${VITE_PORT:-5000}"

if [[ ! -d "node_modules" ]]; then
  echo "[dev] node_modules not found. Run 'npm install' first."
  exit 1
fi

if [[ ! -f ".dev.vars" ]]; then
  echo "[dev] Creating .dev.vars from .dev.vars.example..."
  cp .dev.vars.example .dev.vars
fi

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "[dev] Not logged into Cloudflare. The remote PLACES archive will not work."
  echo "[dev] Run 'npx wrangler login' to read the private PLACES archive."
fi

echo "[dev] Starting Vite and the Cloudflare Worker on :${VITE_PORT}..."
exec npx vite --port "${VITE_PORT}" --strictPort
