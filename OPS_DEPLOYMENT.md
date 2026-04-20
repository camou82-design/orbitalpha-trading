# Orbitalpha Trading Ops Notes

- Lightsail PM2 runtime apps are only `orbitalpha-trading-api` and `orbitalpha-trading-dashboard`.
- Do not run PM2 root app `orbitalpha-trading`.
- If any build step fails, do not run `pm2 start` or `pm2 restart`.
- Deploy only with `./scripts/deploy-trading-pm2.sh`.
