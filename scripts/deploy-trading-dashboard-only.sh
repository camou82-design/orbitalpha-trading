#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[deploy-dashboard-only] git head"
git rev-parse HEAD

echo "[deploy-dashboard-only] install dependencies"
npm install --include=dev

echo "[deploy-dashboard-only] clean dashboard build artifacts"
rm -rf dashboard/.next

echo "[deploy-dashboard-only] build dashboard"
npm run build -w @orbitalpha/dashboard

echo "[deploy-dashboard-only] restart dashboard pm2 app"
pm2 delete orbitalpha-trading-dashboard || true
pm2 start /home/admin/orbitalpha-trading/node_modules/.bin/next --name orbitalpha-trading-dashboard --cwd /home/admin/orbitalpha-trading/dashboard -- start -p 3010
pm2 save

echo "[deploy-dashboard-only] verify dashboard process and port"
pm2 list
ss -ltnp | egrep ':3010'

echo "[deploy-dashboard-only] wait for dashboard login"
dashboard_ok=0
for i in {1..30}; do
  if curl -fsSI --max-time 5 http://127.0.0.1:3010/login >/dev/null; then
    dashboard_ok=1
    break
  fi
  sleep 2
done
if [[ "$dashboard_ok" -ne 1 ]]; then
  echo "[deploy-dashboard-only] dashboard login check failed after retries"
  exit 1
fi

echo "[deploy-dashboard-only] done"
