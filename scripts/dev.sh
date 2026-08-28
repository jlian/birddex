#!/usr/bin/env bash
set -euo pipefail

API_PORT="${API_PORT:-8787}"
VITE_PORT="${VITE_PORT:-5000}"

running_full_app() {
  curl -fsS "http://localhost:${VITE_PORT}/" >/dev/null 2>&1 \
    && curl -fsS "http://localhost:${VITE_PORT}/api/health" >/dev/null 2>&1
}

pick_available_api_port() {
  local port="${API_PORT}"
  while lsof -t -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; do
    port="$((port + 1))"
  done

  if [[ "${port}" != "${API_PORT}" ]]; then
    echo "[dev] API port ${API_PORT} is in use. Falling back to :${port}."
  fi

  API_PORT="${port}"
  export API_PORT
}

ensure_vite_port_available() {
  if running_full_app; then
    echo "[dev] App already healthy on :${VITE_PORT}. Reusing existing server."
    exit 0
  fi

  local pids
  pids="$(lsof -t -nP -iTCP:"${VITE_PORT}" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true)"
  if [[ -z "${pids// }" ]]; then
    return
  fi

  for pid in ${pids}; do
    local cmd
    cmd="$(ps -p "${pid}" -o comm= | xargs)"
    if [[ "${cmd}" == "workerd" ]]; then
      echo "[dev] Port ${VITE_PORT} is occupied by workerd (likely wrangler dev). Stopping it for Vite HMR..."
      kill "${pid}" >/dev/null 2>&1 || true
    else
      echo "[dev] Port ${VITE_PORT} is already in use by PID ${pid} (${cmd})."
      echo "[dev] Stop that process, or free port ${VITE_PORT}, then retry npm run dev."
      exit 1
    fi
  done

  sleep 1
  if lsof -t -nP -iTCP:"${VITE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev] Failed to free port ${VITE_PORT}."
    exit 1
  fi
}

cleanup() {
  if [[ -n "${CF_PID:-}" ]]; then
    kill "${CF_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if [[ ! -d "node_modules" ]]; then
  echo "[dev] node_modules not found. Run 'npm install' first."
  exit 1
fi

if [[ ! -f ".dev.vars" ]]; then
  echo "[dev] Creating .dev.vars from .dev.vars.example..."
  cp .dev.vars.example .dev.vars
fi

ensure_vite_port_available
pick_available_api_port

echo "[dev] Building worker bundle..."
npx wrangler pages functions build --outdir=./dist/worker/

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "[dev] Not logged into Cloudflare. The remote PLACES archive will not work."
  echo "[dev] Run 'npx wrangler login' to read the private PLACES archive."
fi

echo "[dev] Starting Cloudflare Functions on :${API_PORT}..."
npx wrangler dev --persist-to "$HOME/.cache/wingdex/wrangler-state" --show-interactive-dev-session=false --port "${API_PORT}" &
CF_PID=$!

sleep 1

echo "[dev] Starting Vite with HMR..."
exec npx vite --port "${VITE_PORT}" --strictPort
