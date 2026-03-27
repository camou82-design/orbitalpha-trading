#!/usr/bin/env bash
# Run on the Lightsail repo root (e.g. /home/admin/orbitalpha-trading).
# Prints evidence A–D in order; exits non-zero if any step fails.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== A: ls -l shared/dist/index.js ==="
ls -l shared/dist/index.js

echo "=== B: ls -l shared/dist/index.d.ts ==="
ls -l shared/dist/index.d.ts

echo "=== C: npm run build -w @orbitalpha/server ==="
npm run build -w @orbitalpha/server

echo "=== D: npm run build (root) ==="
npm run build
