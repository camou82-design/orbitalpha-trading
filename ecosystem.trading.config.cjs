/**
 * PM2 split: API (8787) + dashboard (3010). 레거시 단일 앱 `orbitalpha-trading` 는 사용하지 않는다.
 * Start: pm2 start ecosystem.trading.config.cjs --env production
 */
module.exports = {
    apps: [
        {
            name: "orbitalpha-trading-api",
            cwd: "/home/admin/orbitalpha-trading",
            script: "node",
            args: "server/dist/index.js",
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            max_memory_restart: "350M",
            env: {
                NODE_ENV: "production",
                ORBITALPHA_TRADING_PORT: "8787",
                PORT: 8787,
                ORBITALPHA_TRADING_MODE: "live",
                ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM: process.env.ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM || "false"
            },
            env_production: {
                NODE_ENV: "production",
                // Secrets should be in local .env or injected
            }
        },
        {
            name: "orbitalpha-trading-dashboard",
            cwd: "/home/admin/orbitalpha-trading",
            script: "npm",
            args: "run start -w @orbitalpha/dashboard -- -p 3010",
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            max_memory_restart: "400M",
            env: {
                NODE_ENV: "production",
                PORT: 3010,
                ORBITALPHA_TRADING_API_ORIGIN: "http://127.0.0.1:8787"
            },
            env_production: {
                NODE_ENV: "production"
            }
        }
    ]
};
