#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[deploy-api-only] git head"
git rev-parse HEAD

echo "[deploy-api-only] install dependencies"
npm install --include=dev

echo "[deploy-api-only] build shared"
npm run build -w @orbitalpha/shared

echo "[deploy-api-only] build server"
npm run build -w @orbitalpha/server

echo "[deploy-api-only] restart api pm2 app"
pm2 delete orbitalpha-trading || true
pm2 delete orbitalpha-trading-api || true
ORBITALPHA_TRADING_PORT=8787 pm2 start /usr/bin/node --name orbitalpha-trading-api --cwd /home/admin/orbitalpha-trading/server -- dist/index.js
pm2 save

echo "[deploy-api-only] verify api process and port"
pm2 list
ss -ltnp | egrep ':8787'

echo "[deploy-api-only] wait for api health"
api_ok=0
for i in {1..30}; do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null; then
    api_ok=1
    break
  fi
  sleep 2
done
if [[ "$api_ok" -ne 1 ]]; then
  echo "[deploy-api-only] api health check failed after retries"
  exit 1
fi

echo "[deploy-api-only] done"
