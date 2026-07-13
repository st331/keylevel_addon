#!/usr/bin/env bash
# Runs every automated check: addon Lua tests (under the WoW mock) and
# companion Node tests (with a fake WCL server + real-Lua roundtrip).
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

echo "==> companion tests (node --test)"
(cd companion && node --test 'test/*.test.mjs')

echo "==> all checks passed"
