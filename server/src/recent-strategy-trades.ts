import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";

/** `live_strategy_trades.json`에 쌓이는 주기적 스냅샷 — 거래 내역 목록에서 제외 */
const NOISE_REASON_EXITS = new Set(["highest_price_update", "breakeven_armed"]);

function isSignificantTradeRow(t: unknown): boolean {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  if (o.action !== "buy" && o.action !== "sell") return false;
  const rex = String(o.reason_exit ?? "");
  if (NOISE_REASON_EXITS.has(rex)) return false;
  /** 주문 실패/미체결 스냅샷은 recent trades에서 제외 (전략 평가 로그와 구분) */
  if (o.action === "buy" && Number(o.filled_qty ?? 0) === 0) return false;
  return true;
}

export async function readLiveStrategyTradesRecent(opts: {
  companyId: string;
  serviceId: string;
  limit: number;
}): Promise<{ relativePath: string; items: unknown[]; total_rows_in_file: number }> {
  const rel = path.join("data", "orbitalpha-trading", "strategy", opts.companyId, opts.serviceId, "live_strategy_trades.json");
  const file = path.join(tradingDataRoot(), "strategy", opts.companyId, opts.serviceId, "live_strategy_trades.json");
  let raw: unknown[] = [];
  try {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text) as unknown;
    raw = Array.isArray(parsed) ? parsed : [];
  } catch {
    raw = [];
  }
  const significant = raw.filter(isSignificantTradeRow);
  const lim = Math.max(1, Math.min(50, opts.limit));
  const items = significant.slice(-lim).reverse();
  return { relativePath: rel, items, total_rows_in_file: raw.length };
}
