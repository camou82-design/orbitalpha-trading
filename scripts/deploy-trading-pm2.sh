#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[deploy] git head"
git rev-parse HEAD

echo "[deploy] install dependencies"
npm install --include=dev

echo "[deploy] build shared"
npm run build -w @orbitalpha/shared

echo "[deploy] build server"
npm run build -w @orbitalpha/server

echo "[deploy] clean dashboard build artifacts"
rm -rf dashboard/.next

echo "[deploy] build dashboard"
npm run build -w @orbitalpha/dashboard

echo "[deploy] restart pm2 apps"
pm2 delete orbitalpha-trading || true
pm2 delete orbitalpha-trading-api || true
pm2 delete orbitalpha-trading-dashboard || true
pm2 start ecosystem.trading.config.cjs --env production --update-env
pm2 save

echo "[deploy] verify process and ports"
pm2 list
ss -ltnp | egrep ':8787|:3010'

echo "[deploy] wait for api health"
api_ok=0
for i in {1..30}; do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null; then
    api_ok=1
    break
  fi
  sleep 2
done
if [[ "$api_ok" -ne 1 ]]; then
  echo "[deploy] api health check failed after retries"
  exit 1
fi

echo "[deploy] wait for dashboard login"
dashboard_ok=0
for i in {1..30}; do
  if curl -fsSI --max-time 5 http://127.0.0.1:3010/login >/dev/null; then
    dashboard_ok=1
    break
  fi
  sleep 2
done
if [[ "$dashboard_ok" -ne 1 ]]; then
  echo "[deploy] dashboard login check failed after retries"
  exit 1
fi

echo "[deploy] verify session via dashboard proxy (expect 200 + authenticated field)"
session_ok=0
for i in {1..15}; do
  if body=$(curl -fsS --max-time 8 http://127.0.0.1:3010/api/v1/auth/session 2>/dev/null) && echo "$body" | grep -q '"authenticated"'; then
    session_ok=1
    break
  fi
  sleep 2
done
if [[ "$session_ok" -ne 1 ]]; then
  echo "[deploy] session proxy check failed (GET /api/v1/auth/session via 3010)"
  exit 1
fi

echo "[deploy] verify protected route (unauthenticated -> redirect to /login)"
protected_ok=0
for i in {1..15}; do
  hdrs=$(curl -sSI --max-time 8 http://127.0.0.1:3010/trading 2>/dev/null | tr -d '\r' || true)
  if echo "$hdrs" | grep -qiE '^HTTP/[0-9.]+ 30[0-9] ' && echo "$hdrs" | awk 'tolower($1)=="location:"{print tolower($0)}' | grep -q "login"; then
    protected_ok=1
    break
  fi
  sleep 2
done
if [[ "$protected_ok" -ne 1 ]]; then
  echo "[deploy] protected-route check failed (expected 3xx Location .../login for GET /trading without cookie)"
  exit 1
fi

echo "[deploy] done"
