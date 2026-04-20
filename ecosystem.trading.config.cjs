/**
 * PM2 Unified Trading Ecosystem (Standardized)
 * Start: pm2 start ecosystem.trading.config.cjs --env production
 */
module.exports = {
    apps: [
        {
            name: "orbitalpha-trading-api",
            cwd: "/home/admin/orbitalpha-trading/server",
            script: "node",
            args: "dist/index.js",
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            max_memory_restart: "350M",
            env: {
                NODE_ENV: "production",
                ORBITALPHA_TRADING_PORT: "8787",
                PORT: 8787,
                ORBITALPHA_TRADING_MODE: "live",
                ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM: "false"
            },
            env_production: {
                NODE_ENV: "production",
                // Secrets should be in local .env or injected
            }
        },
        {
            name: "orbitalpha-trading-dashboard",
            cwd: "/home/admin/orbitalpha-trading/dashboard",
            script: "npm",
            args: "start -- -p 3010",
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            max_memory_restart: "400M",
            env: {
                NODE_ENV: "production",
                PORT: 3010
            },
            env_production: {
                NODE_ENV: "production"
            }
        }
    ]
};
