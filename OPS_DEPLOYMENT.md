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

## Optional: register surge shadow worker in PM2 (no order authority)

This worker is **shadow-only**: it writes `data/runtime/surge-candidates.json` and **must not** place orders.
It is **not** part of `ecosystem.trading.config.cjs` by default and **must not be started automatically**.

### Build first

Run build (or your usual deploy build step) so `dist/worker-surge-scanner-shadow.js` exists.

### Register / start (manual, optional)

From repo root:

```bash
pm2 start server/dist/worker-surge-scanner-shadow.js --name orbitalpha-trading-surge-shadow
```

If you need to pass env vars explicitly:

```bash
pm2 start server/dist/worker-surge-scanner-shadow.js --name orbitalpha-trading-surge-shadow --update-env
```

### Important: API env and worker env are separate

`orbitalpha-trading-api` and `orbitalpha-trading-surge-shadow` do not share PM2 env automatically.
Set scanner runtime mode on the API process explicitly, then restart API:

```bash
export LIVE_SCANNER_RUNTIME_MODE=shadow
pm2 restart orbitalpha-trading-api --update-env
```

Worker can keep its own env (interval/stale/topM settings) and should be restarted separately:

```bash
pm2 restart orbitalpha-trading-surge-shadow --update-env
```

To force API and worker to read/write the same runtime JSON path, set:

```bash
export ORBITALPHA_TRADING_RUNTIME_ROOT=/home/admin/orbitalpha-trading/server/data/runtime
```

Then restart both target processes with `--update-env`.

### Stop / remove

```bash
pm2 stop orbitalpha-trading-surge-shadow
pm2 delete orbitalpha-trading-surge-shadow
```
