import { readRecentLogs } from "../log-store.js";
import { atomicWriteJson } from "../runtime-file-io.js";
import { surgeCandidatesRuntimePath } from "../runtime-paths.js";

type SurgeCandidateItem = {
  market: string;
  scanner_score: number;
  volume_multiple: number;
  breakout: boolean;
  close_upper_hold: boolean;
  rise_3m_pct: number;
  signal_ts: string;
  updated_at: string;
  source_kind: "surge_scanner_worker";
};

type SurgeCandidatesFile = {
  kind: "surge_candidates_shadow";
  updated_at: string;
  items: SurgeCandidateItem[];
};

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function clampNumber(x: unknown, fallback = 0): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Shadow worker: creates candidates file only.
 * CRITICAL: Must never import or call any order / trade-control modules.
 */
export function startSurgeScannerShadowWorker(params: {
  companyId: string;
  serviceId: string;
  intervalMs?: number;
  maxItems?: number;
  staleSeconds?: number;
  log?: (row: Record<string, unknown>) => void;
}): { stop: () => void } {
  const intervalMs = Math.max(3000, params.intervalMs ?? 10_000);
  const maxItems = Math.max(10, Math.min(200, params.maxItems ?? 60));
  const staleSeconds = Math.max(30, Math.min(3600, params.staleSeconds ?? 300));
  const outPath = surgeCandidatesRuntimePath();

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  const log = (row: Record<string, unknown>) => params.log?.(row);

  const tick = async () => {
    if (stopped) return;
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = await readRecentLogs(params.companyId, params.serviceId, 220);
      const nowMs = Date.now();
      const byMarket = new Map<string, SurgeCandidateItem>();
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const r = row as { kind?: string; ts?: string; payload?: unknown };
        if (r.kind !== "signal") continue;
        const ts = typeof r.ts === "string" ? r.ts : null;
        if (!ts || Number.isNaN(Date.parse(ts))) continue;
        const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(ts)) / 1000));
        if (ageSeconds > staleSeconds) continue;

        const p = asRecord(r.payload);
        const market = typeof p.market === "string" ? p.market : "";
        if (!market.startsWith("KRW-")) continue;

        // Keep the freshest per market.
        const existing = byMarket.get(market);
        if (existing && Date.parse(existing.signal_ts) >= Date.parse(ts)) continue;

        const item: SurgeCandidateItem = {
          market,
          scanner_score: clampNumber(p.scanner_score ?? p.signal_score, 0),
          volume_multiple: clampNumber(p.volume_ratio, 0),
          breakout: Boolean(p.breakout),
          close_upper_hold: Boolean(p.close_upper_hold),
          rise_3m_pct: clampNumber(p.rise_3m_pct ?? p.momentum_3m_pct ?? p.price_change_3m_pct, 0),
          signal_ts: ts,
          updated_at: new Date().toISOString(),
          source_kind: "surge_scanner_worker",
        };
        byMarket.set(market, item);
      }

      const items = Array.from(byMarket.values())
        .sort((a, b) => Date.parse(b.signal_ts) - Date.parse(a.signal_ts) || b.scanner_score - a.scanner_score)
        .slice(0, maxItems);

      const payload: SurgeCandidatesFile = {
        kind: "surge_candidates_shadow",
        updated_at: new Date().toISOString(),
        items,
      };
      atomicWriteJson(outPath, payload);
      log?.({
        tag: "SURGE_SCANNER_WORKER_SHADOW_TICK",
        ts: payload.updated_at,
        items: items.length,
        path: outPath.replace(/\\/g, "/"),
        stale_seconds: staleSeconds,
      });
    } catch (e) {
      log?.({ tag: "SURGE_SCANNER_WORKER_SHADOW_FAILED", err: String(e).slice(0, 300) });
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

