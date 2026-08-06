#!/usr/bin/env bash
# Run what CI runs, in CI order, locally.
#
# Written after a PR failed on `npm run lint` for a dead variable, because I had
# only ever run typecheck, test and build by hand. CI runs FIVE gates and I was
# running three. The two I skipped are exactly the two that failed.
#
# Mirrors .github/workflows/ci.yml. If a step is added there, add it here.
#   ./ci-local.sh          full run, including playwright
#   ./ci-local.sh --quick  skip e2e (slow); use only for an early signal
set -uo pipefail
cd /home/jlian/wingdex || exit 1

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

FAILED=""
UNVERIFIED=""
run_step() {
  name="$1"; shift
  echo ""
  echo "=== $name ==="
  if "$@" > /tmp/ci_step.log 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    tail -25 /tmp/ci_step.log
    FAILED="$FAILED $name"
  fi
}

# Order matters: it matches CI, so the first local failure is the first CI failure.
run_step "Lint"      npm run lint
run_step "Typecheck" npm run typecheck
run_step "Unit"      npm test
run_step "Build"     npm run build

if [ "$QUICK" = "0" ]; then
  # CI applies migrations to a LOCAL D1 before playwright, and writes .dev.vars.
  # Reproduce both or e2e fails for reasons unrelated to the change.
  if [ ! -f .dev.vars ]; then
    echo "BETTER_AUTH_SECRET=local-ci-mirror-secret" > .dev.vars
    echo "note: wrote a placeholder .dev.vars"
  fi
  run_step "Migrate local D1" bash -c "printf 'y\n' | npx wrangler d1 migrations apply wingdex-db --local"
  # CI=true matters: playwright.config.ts branches on it, using `wrangler dev`
  # with a 45s budget in CI and scripts/dev-full.sh with 20s locally. Without it
  # the mirror tests a different server than CI does, which is not a mirror.
  #
  # Both paths boot wrangler, which needs Cloudflare credentials. CI injects them
  # as secrets. Locally, report that plainly instead of a red FAIL that means
  # "no token", because a misleading pass/fail is worse than a stated gap.
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -f ~/.wrangler/config/default.toml ]; then
    echo ""
    echo "=== E2E ==="
    echo "SKIP  E2E: no CLOUDFLARE_API_TOKEN and no wrangler login."
    echo "      The webServer cannot boot, so this gate is UNVERIFIED locally."
    echo "      Export CLOUDFLARE_API_TOKEN to close this gap."
    UNVERIFIED="E2E"
  else
    run_step "E2E" env CI=true npx playwright test --grep-invert @live
  fi
else
  echo ""
  echo "SKIPPED e2e (--quick). Not a full CI signal."
fi

echo ""
if [ -n "$FAILED" ]; then
  echo "CI MIRROR FAILED:$FAILED"
  exit 1
fi
if [ -n "$UNVERIFIED" ]; then
  echo "CI MIRROR PASSED, but UNVERIFIED:$UNVERIFIED"
  echo "That is not a full CI signal. CI can still fail on the skipped gate."
  exit 0
fi
echo "CI MIRROR PASSED (all gates)"
