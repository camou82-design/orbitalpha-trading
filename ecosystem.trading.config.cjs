/**
 * PM2 Unified Trading Ecosystem (Standardized)
 * Start: pm2 start ecosystem.trading.config.cjs --env production
 */
const path = require("path");

module.exports = {
    apps: [
        {
            name: "orbitalpha-trading-api",
            cwd: path.resolve(__dirname, "server"),
            script: "npm",
            args: "start",
            instances: 1,
            autorestart: true,
            max_memory_restart: "350M",
            env: {
                NODE_ENV: "production",
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
            cwd: path.resolve(__dirname, "dashboard"),
            script: "npm",
            args: "start -- -p 3010",
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
