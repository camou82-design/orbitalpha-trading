# Orbitalpha Trading Ops Notes

- Lightsail PM2 runtime apps are only `orbitalpha-trading-api` and `orbitalpha-trading-dashboard`.
- Do not run PM2 root app `orbitalpha-trading`.
- If any build step fails, do not run `pm2 start` or `pm2 restart`.
- Use full deploy `./scripts/deploy-trading-pm2.sh` only when dashboard changes are included.
- Use server-only deploy `./scripts/deploy-trading-api-only.sh` for server-only changes.
- Use dashboard-only deploy `./scripts/deploy-trading-dashboard-only.sh` for dashboard-only changes.
- Do not judge deployment health with immediate curl right after `pm2 start`.
- Decide health/login readiness only with wait/retry checks.
