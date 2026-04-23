# Orbitalpha Trading Ops Notes

- PM2 source of truth is `ecosystem.trading.config.cjs` only. Full deploy starts both apps with `pm2 start ecosystem.trading.config.cjs --env production` (after deleting legacy names if present).
- Lightsail PM2 runtime apps are only `orbitalpha-trading-api` and `orbitalpha-trading-dashboard`.
- Do not run PM2 root app `orbitalpha-trading`.
- If any build step fails, do not run `pm2 start` or `pm2 restart`.
- Use full deploy `./scripts/deploy-trading-pm2.sh` only when dashboard changes are included.
- Use server-only deploy `./scripts/deploy-trading-api-only.sh` for server-only changes (restarts `--only orbitalpha-trading-api` from the same ecosystem file).
- Use dashboard-only deploy `./scripts/deploy-trading-dashboard-only.sh` for dashboard-only changes (restarts `--only orbitalpha-trading-dashboard` from the same ecosystem file).
- Do not judge deployment health with immediate curl right after `pm2 start`.
- Decide health/login readiness only with wait/retry checks: API health is `GET /api/health` on port 8787; dashboard readiness uses `GET /login` on port 3010.
