import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";

type ReplayEventRow = {
  timestamp: string;
  event_type: string;
  market?: string | null;
  [k: string]: unknown;
};

type ReplaySnapshotRow = {
  timestamp: string;
  [k: string]: unknown;
};

function dayKey(ts: string) {
  return ts.slice(0, 10);
}

function dateRangeDays(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const s = new Date(`${dayKey(startIso)}T00:00:00.000Z`).getTime();
  const e = new Date(`${dayKey(endIso)}T00:00:00.000Z`).getTime();
  for (let t = s; t <= e; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function readJsonlFile<T>(file: string): Promise<T[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((v): v is T => Boolean(v));
  } catch {
    return [];
  }
}

export async function readReplayRange(args: {
  startTs: string;
  endTs: string;
  market?: string;
}) {
  const base = path.join(tradingDataRoot(), "logs");
  const days = dateRangeDays(args.startTs, args.endTs);
  const startMs = Date.parse(args.startTs);
  const endMs = Date.parse(args.endTs);
  const market = args.market && args.market !== "ALL" ? args.market : null;

  const events: ReplayEventRow[] = [];
  const snapshots: ReplaySnapshotRow[] = [];
  for (const d of days) {
    const ev = await readJsonlFile<ReplayEventRow>(path.join(base, `events_${d}.jsonl`));
    const sn = await readJsonlFile<ReplaySnapshotRow>(path.join(base, `snapshots_${d}.jsonl`));
    events.push(...ev);
    snapshots.push(...sn);
  }

  const filteredEvents = events
    .filter((e) => {
      const ts = Date.parse(String(e.timestamp ?? ""));
      if (Number.isNaN(ts) || ts < startMs || ts > endMs) return false;
      if (!market) return true;
      const m = typeof e.market === "string" ? e.market : null;
      return m === market;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const filteredSnapshots = snapshots
    .filter((s) => {
      const ts = Date.parse(String(s.timestamp ?? ""));
      return !Number.isNaN(ts) && ts >= startMs && ts <= endMs;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return {
    events: filteredEvents,
    snapshots: filteredSnapshots,
  };
}

