import Fastify from "fastify";
import { loadEnv } from "./env.js";
import { startSurgeScannerShadowWorker } from "./workers/surge-scanner-shadow-worker.js";

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: true, trustProxy: env.trustProxy });
  app.log.info({ tag: "SURGE_SCANNER_WORKER_SHADOW_READY", mode: "shadow_only" }, "SURGE_SCANNER_WORKER_SHADOW_READY");
  const worker = startSurgeScannerShadowWorker({
    companyId: env.companyId,
    serviceId: env.serviceId,
    intervalMs: Math.max(5000, Number(process.env.SURGE_SCANNER_WORKER_INTERVAL_MS ?? 10_000)),
    staleSeconds: Math.max(60, Number(process.env.SURGE_SCANNER_WORKER_STALE_SECONDS ?? 300)),
    maxItems: Math.max(20, Number(process.env.SURGE_SCANNER_WORKER_MAX_ITEMS ?? 60)),
    log: (row) => app.log.info(row, row.tag ? String(row.tag) : "surge_scanner_shadow_tick"),
  });

  const close = async () => {
    worker.stop();
    await app.close();
  };
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

