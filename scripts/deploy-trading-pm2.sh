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

echo "[deploy] build dashboard"
npm run build -w @orbitalpha/dashboard

echo "[deploy] restart pm2 apps"
pm2 delete orbitalpha-trading || true
pm2 delete orbitalpha-trading-api || true
pm2 delete orbitalpha-trading-dashboard || true
pm2 start ecosystem.trading.config.cjs --env production
pm2 save

echo "[deploy] verify process and ports"
pm2 list
ss -ltnp | egrep ':8787|:3010'
curl -fsS http://127.0.0.1:8787/health
curl -I --max-time 5 http://127.0.0.1:3010/login

echo "[deploy] done"
