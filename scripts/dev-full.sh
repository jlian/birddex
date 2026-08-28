#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-5000}"
BASE="http://localhost:${PORT}"
FORCE_RESTART="${FORCE_RESTART:-false}"

is_port_listening() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

running_full_app() {
  curl -fsS "${BASE}/" >/dev/null 2>&1 && curl -fsS "${BASE}/api/health" >/dev/null 2>&1
}

if [[ "${FORCE_RESTART}" == "true" ]]; then
  if is_port_listening; then
    echo "[start] Port ${PORT} is in use. Force-restarting listener(s)..."
    PIDS="$(lsof -t -nP -iTCP:"${PORT}" -sTCP:LISTEN | tr '\n' ' ')"
    if [[ -n "${PIDS// }" ]]; then
      kill ${PIDS} >/dev/null 2>&1 || true
      sleep 1
    fi

    if is_port_listening; then
      echo "[start] Failed to free port ${PORT}."
      exit 1
    fi
  fi
else
  if running_full_app; then
    echo "[start] App already running at ${BASE}. Reusing existing server."
    exit 0
  fi

  if is_port_listening; then
    echo "[start] Port ${PORT} is already in use by another process."
    echo "[start] To force-restart, run: FORCE_RESTART=true npm start"
    exit 1
  fi
fi

echo "[start] Applying local D1 migrations..."
printf 'y\n' | npx wrangler d1 migrations apply wingdex-db --local --persist-to "$HOME/.cache/wingdex/wrangler-state"

echo "[start] Building app..."
npm run build

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "[start] Not logged into Cloudflare. The remote PLACES archive will not work."
  echo "[start] Run 'npx wrangler login', or start Wrangler with --local for local R2."
fi

echo "[start] Starting full local app at ${BASE}..."
WRANGLER_ARGS=(
  dev
  --port "${PORT}"
  --persist-to "$HOME/.cache/wingdex/wrangler-state"
  --show-interactive-dev-session=false
)
if [[ "${WRANGLER_LOCAL_ONLY:-false}" == "true" ]]; then
  WRANGLER_ARGS+=(--local)
fi
exec npx wrangler "${WRANGLER_ARGS[@]}"
