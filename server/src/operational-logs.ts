import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tradingDataRoot } from "./paths.js";

type EventRow = {
  timestamp: string;
  event_type: string;
  market: string | null;
  strategy_type: string | null;
  market_state: string | null;
  side: string | null;
  reason: string | null;
  balance_krw: number | null;
  position_qty: number | null;
  avg_buy_price: number | null;
  current_price: number | null;
  pnl_net: number | null;
  pnl_net_pct: number | null;
  note: string | null;
};

type SnapshotRow = {
  timestamp: string;
  market_state: string | null;
  auto_trade_enabled: boolean;
  safety_guard_state: string;
  total_asset_krw: number;
  balance_krw: number;
  available_krw_for_strategy: number;
  invested_krw_for_strategy: number;
  daily_pnl_net: number;
  open_positions_count: number;
  open_markets: string[];
  signal_count_last_min: number;
  order_fail_count_today: number;
  consecutive_losses: number;
  top_signal_markets: string[];
  api_connected: boolean;
};

function dayStr(ts: string) {
  return ts.slice(0, 10);
}

async function appendJsonl(file: string, row: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
}

async function cleanupFiles(dir: string, prefix: string, keepDays: number) {
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith(".jsonl")).sort();
    const cut = names.slice(0, Math.max(0, names.length - keepDays));
    await Promise.all(cut.map((n) => fs.rm(path.join(dir, n), { force: true })));
  } catch {}
}

export function createOperationalLogger(args: { debugEnabled: boolean }) {
  const dir = path.join(tradingDataRoot(), "logs");
  let lastEventHash = "";
  let lastEventAt = 0;
  let lastDebugHash = "";
  let lastDebugAt = 0;

  const eventFile = (ts: string) => path.join(dir, `events_${dayStr(ts)}.jsonl`);
  const snapshotFile = (ts: string) => path.join(dir, `snapshots_${dayStr(ts)}.jsonl`);
  const debugFile = (ts: string) => path.join(dir, `debug_${dayStr(ts)}.jsonl`);

  return {
    async event(row: EventRow) {
      const hash = crypto.createHash("sha1").update(JSON.stringify(row)).digest("hex");
      const now = Date.now();
      if (hash === lastEventHash && now - lastEventAt < 5000) return;
      lastEventHash = hash;
      lastEventAt = now;
      await appendJsonl(eventFile(row.timestamp), row);
    },
    async snapshot(row: SnapshotRow) {
      await appendJsonl(snapshotFile(row.timestamp), row);
    },
    async debug(row: Record<string, unknown>) {
      if (!args.debugEnabled) return;
      const hash = crypto.createHash("sha1").update(JSON.stringify(row)).digest("hex");
      const now = Date.now();
      if (hash === lastDebugHash && now - lastDebugAt < 3000) return;
      lastDebugHash = hash;
      lastDebugAt = now;
      await appendJsonl(debugFile(new Date().toISOString()), row);
    },
    async maintainRetention() {
      await cleanupFiles(dir, "events_", 30);
      await cleanupFiles(dir, "snapshots_", 30);
      await cleanupFiles(dir, "debug_", 7);
    },
    files: {
      events: path.join(dir, "events_YYYY-MM-DD.jsonl"),
      snapshots: path.join(dir, "snapshots_YYYY-MM-DD.jsonl"),
      debug: path.join(dir, "debug_YYYY-MM-DD.jsonl"),
    },
  };
}

