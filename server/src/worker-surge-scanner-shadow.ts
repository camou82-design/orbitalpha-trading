import Fastify from "fastify";
import { loadEnv } from "./env.js";
import { startEngine2SurgeScannerWorker } from "./engine-v2/surge-scanner/worker.js";

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: true, trustProxy: env.trustProxy });
  app.log.info(
    { tag: "SURGE_SCANNER_WORKER_SHADOW_READY", worker: "engine2_surge_scanner", mode: "shadow_only" },
    "SURGE_SCANNER_WORKER_SHADOW_READY",
  );
  const worker = startEngine2SurgeScannerWorker({
    intervalMs: Math.max(5000, Number(process.env.SURGE_SCANNER_WORKER_INTERVAL_MS ?? 10_000)),
    staleSeconds: Math.max(60, Number(process.env.SURGE_SCANNER_WORKER_STALE_SECONDS ?? 300)),
    maxItems: Math.max(20, Number(process.env.SURGE_SCANNER_WORKER_MAX_ITEMS ?? 60)),
    topM: Math.max(10, Number(process.env.ENGINE2_SURGE_TOP_M ?? 50)),
    candleMaxPerTick: Math.max(5, Number(process.env.ENGINE2_SURGE_CANDLE_MAX_PER_TICK ?? 18)),
    candleBatchSize: Math.max(1, Number(process.env.ENGINE2_SURGE_CANDLE_BATCH_SIZE ?? 3)),
    candleBatchDelayMs: Math.max(0, Number(process.env.ENGINE2_SURGE_CANDLE_BATCH_DELAY_MS ?? 1200)),
    log: (row) => app.log.info(row, row.tag ? String(row.tag) : "engine2_surge_scanner"),
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

