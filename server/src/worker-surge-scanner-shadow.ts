import { DEFAULT_TRADING_COMPANY_ID, DEFAULT_TRADING_SERVICE_ID } from "@orbitalpha/shared";
import { startEngine2SurgeScannerWorker } from "./engine-v2/surge-scanner/worker.js";
import { runtimeRoot, surgeCandidatesRuntimePath } from "./runtime-paths.js";

type SurgeShadowWorkerEnv = {
  companyId: string;
  serviceId: string;
  intervalMs: number;
  staleSeconds: number;
  maxItems: number;
  topM: number;
  candleMaxPerTick: number;
  candleBatchSize: number;
  candleBatchDelayMs: number;
};

function loadSurgeShadowWorkerEnv(): SurgeShadowWorkerEnv {
  const companyId = String(process.env.ORBITALPHA_TRADING_COMPANY_ID ?? DEFAULT_TRADING_COMPANY_ID).trim() || DEFAULT_TRADING_COMPANY_ID;
  const serviceId = String(process.env.ORBITALPHA_TRADING_SERVICE_ID ?? DEFAULT_TRADING_SERVICE_ID).trim() || DEFAULT_TRADING_SERVICE_ID;
  return {
    companyId,
    serviceId,
    intervalMs: Math.max(5000, Number(process.env.SURGE_SCANNER_WORKER_INTERVAL_MS ?? 10_000)),
    staleSeconds: Math.max(60, Number(process.env.SURGE_SCANNER_WORKER_STALE_SECONDS ?? 300)),
    maxItems: Math.max(20, Number(process.env.SURGE_SCANNER_WORKER_MAX_ITEMS ?? 60)),
    topM: Math.max(10, Number(process.env.ENGINE2_SURGE_TOP_M ?? 50)),
    candleMaxPerTick: Math.max(5, Number(process.env.ENGINE2_SURGE_CANDLE_MAX_PER_TICK ?? 18)),
    candleBatchSize: Math.max(1, Number(process.env.ENGINE2_SURGE_CANDLE_BATCH_SIZE ?? 3)),
    candleBatchDelayMs: Math.max(0, Number(process.env.ENGINE2_SURGE_CANDLE_BATCH_DELAY_MS ?? 1200)),
  };
}

async function main() {
  const env = loadSurgeShadowWorkerEnv();
  const outPath = surgeCandidatesRuntimePath();
  const runtimeRootPath = runtimeRoot();
  console.info(
    JSON.stringify({
      tag: "SURGE_SCANNER_WORKER_SHADOW_READY",
      worker: "engine2_surge_scanner",
      mode: "shadow_only",
      order_authority: "none",
      path: outPath.replace(/\\/g, "/"),
      runtime_root: runtimeRootPath.replace(/\\/g, "/"),
      company_id: env.companyId,
      service_id: env.serviceId,
    }),
  );
  const worker = startEngine2SurgeScannerWorker({
    intervalMs: env.intervalMs,
    staleSeconds: env.staleSeconds,
    maxItems: env.maxItems,
    topM: env.topM,
    candleMaxPerTick: env.candleMaxPerTick,
    candleBatchSize: env.candleBatchSize,
    candleBatchDelayMs: env.candleBatchDelayMs,
    log: (row) => console.info(JSON.stringify(row)),
  });

  const close = async () => {
    worker.stop();
  };
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

