#!/usr/bin/env bash
# Runs every automated check:
#   1. addon Lua tests (real addon code under a simulated WoW client, Lua 5.1)
#   2. website unit tests (node --test over docs/js modules)
#   3. website end-to-end test (real Chromium + fake Warcraft Logs server)
set -euo pipefail
cd "$(dirname "$0")/.."

LUA_BIN="${LUA_BIN:-lua5.1}"
if ! command -v "$LUA_BIN" >/dev/null 2>&1; then
  if command -v lua >/dev/null 2>&1; then LUA_BIN=lua; else
    echo "error: no lua interpreter found (need lua5.1; on debian/ubuntu: apt-get install lua5.1)" >&2
    exit 1
  fi
fi

echo "==> addon tests ($LUA_BIN)"
"$LUA_BIN" tests/run_tests.lua

echo "==> site unit tests (node --test)"
node --test 'site-tests/*.test.mjs'

echo "==> site e2e (real browser + fake WCL server)"
if node -e "require.resolve('playwright')" 2>/dev/null; then
  # prefer a preinstalled chromium if the playwright-managed one is absent
  if [ -z "${PLAYWRIGHT_CHROMIUM:-}" ] && [ -d /opt/pw-browsers ]; then
    PLAYWRIGHT_CHROMIUM=$(find /opt/pw-browsers -name chrome -type f 2>/dev/null | head -1 || true)
    export PLAYWRIGHT_CHROMIUM
  fi
  node site-tests/e2e.mjs
else
  # never report success while silently skipping a whole test tier
  echo "ERROR: playwright not installed — e2e tests NOT run" >&2
  echo "       (fix: npm install && npx playwright install chromium)" >&2
  echo "==> checks INCOMPLETE (e2e skipped)"
  exit 1
fi

echo "==> all checks passed"
