# Orbitalpha Trading - Railway 1st Test Deploy

## Railway Variables

- `UPBIT_ACCESS_KEY`
- `UPBIT_SECRET_KEY`
- `TRADING_LOGIN_ID=admin`
- `TRADING_LOGIN_PASSWORD=955104`
- `LIVE_ORDER_CONFIRM=true`
- `TRADING_MODE=live` (recommended for current real-trade test mode)

## Build / Start

- Build: `npm run build`
- Start: `npm run start`

## Notes

- Single Railway public URL serves dashboard (`/login`, `/trading`).
- Dashboard proxies `/api/*` to internal Fastify server (`127.0.0.1:8787`) using Next rewrites.
- Server data persists only if Railway volume is attached (`/data/orbitalpha-trading` path usage).
