import { createPumpScanner } from "./pump-scanner.js";
import { buildSurgeV2ShadowJudgment } from "./surge-v2/index.js";
import { surgeCandidatesRuntimePath } from "./runtime-paths.js";
import { atomicWriteJson } from "./runtime-file-io.js";

/**
 * [OPERATIONAL WARNING]
 * This worker performs active scanning by calling createPumpScanner().tick(),
 * which triggers Upbit public API fetches (tickers, candles).
 * 
 * - Running this worker alongside the main API (PM2 11) will effectively DOUBLE the Upbit API fetch load.
 * - Long-term operation requires disabling the scanner in API 11 or switching to an external data source.
 * - For initial shadow validation, run with a long interval (e.g., 60s+).
 */
const WORKER_TICK_INTERVAL_MS = Math.max(30000, Number(process.env.SURGE_V2_WORKER_INTERVAL_MS ?? 60000));
const MAX_ITEMS = 50;

async function main() {
  console.info(JSON.stringify({
    tag: "SURGE_V2_WORKER_BOOT_PROOF",
    ts: new Date().toISOString(),
    worker: "surge-v2-worker",
    interval_ms: WORKER_TICK_INTERVAL_MS,
    out_path: surgeCandidatesRuntimePath().replace(/\\/g, "/"),
    order_authority: "none",
    shadow_mode: true,
    scanner_tick_uses_upbit: true,
    safe_to_run_with_engine1_scanner: false // CAUTION: Double fetch load if both are active
  }));

  // Instantiate scanner. 
  // Note: We provide an empty getHeldMarkets because this worker doesn't manage positions.
  const scanner = createPumpScanner(() => [], {
    onEvent: async (ev) => {
      // Optional: Log scanner events if needed
    }
  });

  const tick = async () => {
    const t0 = Date.now();
    let lastError: string | null = null;
    let itemsCount = 0;
    
    try {
      // 1) Run scanner tick (this performs Upbit fetches)
      await scanner.tick();
      
      // 2) Get signal feed
      const signals = scanner.signalFeed();
      
      // 3) Map to Surge V2 shadow judgments
      const judgments = signals.map(sig => {
        const indicators = {
          price: sig.price ?? 0,
          volume_ratio: sig.volume_multiple ?? 0,
          volume_ratio_proxy: sig.volume_multiple ?? 0,
          volume_sustain: (sig.volume_multiple ?? 0) >= 1.5 ? 0.7 : 0.5,
          price_hold: 0.5,
          pullback_quality: 0.5,
          change_rate: sig.rise_3m_pct ?? 0,
          score: sig.scanner_score ?? 0,
          breakout: sig.breakout ?? false,
          box_breakout: sig.reason?.includes("box") ?? false,
          upper_wick: sig.exclude_reasons?.includes("윗꼬리 과다"),
          volume_spike_close_fail: sig.exclude_reasons?.includes("volume_spike_close_fail") ?? false,
          late_chase_risk: sig.reason?.includes("chase") || sig.exclude_reasons?.includes("과열 (추격주의)"),
          fake_pump_risk: sig.exclude_reasons?.includes("윗꼬리 과다") ? 0.8 : 0.3,
          candidate_missing: false,
          stale_data: false, // Worker just generated this
          unrealized_pnl_pct: 0, // No positions in worker
          hold_ms: 0,
        };
        
        return buildSurgeV2ShadowJudgment(sig.market, indicators);
      });

      // 4) Limit items and sort by score (using surgeValidationScore as quality proxy)
      const topItems = judgments
        .sort((a, b) => b.surgeValidationScore - a.surgeValidationScore)
        .slice(0, MAX_ITEMS);
      
      itemsCount = topItems.length;

      // 5) Prepare snapshot
      const nowIso = new Date().toISOString();
      const payload = {
        kind: "surge_candidates_shadow",
        version: 1,
        updated_at: nowIso,
        source: "surge_v2_worker",
        order_authority: "none",
        shadow_mode: true,
        items: topItems,
        diagnostics: {
          item_count: itemsCount,
          scanner_rows_count: signals.length,
          scanner_tick_uses_upbit: true,
          direct_api_call_added_count: 0,
          api_load_note: "scanner.tick uses existing pump-scanner fetch paths when worker is running",
          last_error: null
        }
      };

      // 6) Atomic write to disk
      atomicWriteJson(surgeCandidatesRuntimePath(), payload);

      console.info(JSON.stringify({
        tag: "SURGE_V2_WORKER_WRITE_PROOF",
        ts: nowIso,
        items_count: itemsCount,
        duration_ms: Date.now() - t0
      }));

    } catch (e) {
      lastError = String(e);
      console.error(JSON.stringify({
        tag: "SURGE_V2_WORKER_ERROR_PROOF",
        ts: new Date().toISOString(),
        error: lastError
      }));
    }

    console.info(JSON.stringify({
      tag: "SURGE_V2_WORKER_TICK_PROOF",
      ts: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      items_count: itemsCount,
      has_error: lastError !== null
    }));
  };

  // Start loop
  const interval = setInterval(tick, WORKER_TICK_INTERVAL_MS);
  void tick();

  // Graceful shutdown
  const shutdown = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(err => {
  console.error("SURGE_V2_WORKER_FATAL_ERROR", err);
  process.exit(1);
});
