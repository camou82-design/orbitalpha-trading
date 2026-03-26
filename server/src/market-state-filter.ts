import type { SignalLogEntry } from "@orbitalpha/shared";
import { mvpSignalPayloadV2Schema } from "@orbitalpha/shared";
import { appendLog } from "./log-store.js";
import { fetchMinuteCandles } from "./upbit-public.js";

export type MarketState = "risk_on" | "neutral" | "risk_off";
export type EntryPolicy = "적극 진입" | "선별 진입" | "신규 진입 차단";

type StateSnapshot = {
  timestamp: string;
  market_state: MarketState;
  entry_policy: EntryPolicy;
  market_bonus: number;
  min_entry_score: number;
  btc_5m_trend: "up" | "down" | "flat";
  btc_15m_trend: "up" | "down" | "flat";
  breadth_ratio: number;
  recent_close_bias: "up" | "down" | "flat";
};

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let out = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) out = values[i]! * k + out * (1 - k);
  return out;
}

function trendByEma(closes: number[], shortP: number, longP: number): "up" | "down" | "flat" {
  const s = ema(closes, shortP);
  const l = ema(closes, longP);
  if (s > l * 1.001) return "up";
  if (s < l * 0.999) return "down";
  return "flat";
}

function signalStrengthScore(payload: unknown) {
  const p = mvpSignalPayloadV2Schema.safeParse(payload);
  if (!p.success) return 0;
  let score = 0;
  if (p.data.filter_pass) score += 45;
  const vol = p.data.filters.find((f) => f.id === "volume_increase");
  const box = p.data.filters.find((f) => f.id === "box_breakout");
  const close = p.data.filters.find((f) => f.id === "volume_spike_close_fail");
  if (vol?.passed) score += 20;
  if (box?.passed) score += 15;
  if (close?.passed) score += 10;
  const sigType = (p.data.signal_type ?? "").toUpperCase();
  if (sigType === "HIGH") score += 10;
  if (sigType === "MID") score += 6;
  const vr = Number(p.data.volume_ratio ?? 0);
  if (vr >= 1.2) score += 10;
  return Math.min(100, score);
}

export function createMarketStateFilter(args: {
  companyId: string;
  serviceId: string;
  readLogs: (limit: number) => Promise<SignalLogEntry[]>;
  onEvent?: (row: {
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
  }) => Promise<void>;
}) {
  const state: { latest: StateSnapshot | null } = { latest: null };

  const evaluate = async () => {
    const c5 = await fetchMinuteCandles("KRW-BTC", 5, 50);
    const c15 = await fetchMinuteCandles("KRW-BTC", 15, 50);
    const closes5 = c5.map((c) => c.trade_price);
    const closes15 = c15.map((c) => c.trade_price);
    const btc5 = trendByEma(closes5, 5, 13);
    const btc15 = trendByEma(closes15, 4, 10);
    const r5 = closes5.length > 6 ? ((closes5[closes5.length - 1]! / closes5[closes5.length - 6]!) - 1) * 100 : 0;
    const r15 = closes15.length > 2 ? ((closes15[closes15.length - 1]! / closes15[closes15.length - 2]!) - 1) * 100 : 0;
    const recent3 = closes5.slice(-3);
    const flowUp = recent3.length === 3 && recent3[2]! >= recent3[1]! && recent3[1]! >= recent3[0]!;
    const flowDown = recent3.length === 3 && recent3[2]! <= recent3[1]! && recent3[1]! <= recent3[0]!;
    const sharpDrop = r5 <= -1.4 || r15 <= -2.2;

    const logs = await args.readLogs(150);
    const latestBy = new Map<string, unknown>();
    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!p.success) continue;
      if (!latestBy.has(p.data.market)) latestBy.set(p.data.market, row.payload);
    }
    const arr = [...latestBy.values()];
    const strong = arr.filter((p) => signalStrengthScore(p) >= 70).length;
    const weak = arr.filter((p) => signalStrengthScore(p) < 55).length;
    const breadth = arr.length > 0 ? strong / arr.length : 0;

    const breadthBad = weak >= Math.max(2, strong + 1);
    const riskOffScore =
      (btc5 === "down" ? 1 : 0) +
      (btc15 === "down" ? 1 : 0) +
      (flowDown ? 1 : 0) +
      (r5 <= -0.8 ? 1 : 0) +
      (breadthBad ? 1 : 0) +
      (sharpDrop ? 1 : 0);
    let marketState: MarketState = "neutral";
    if (riskOffScore >= 2) marketState = "risk_off";
    else if (btc5 === "up" && btc15 === "up" && flowUp && r5 > -0.2 && r15 > -0.2 && !sharpDrop) marketState = "risk_on";

    const snap: StateSnapshot = {
      timestamp: new Date().toISOString(),
      market_state: marketState,
      entry_policy: marketState === "risk_on" ? "적극 진입" : marketState === "neutral" ? "선별 진입" : "신규 진입 차단",
      market_bonus: marketState === "risk_on" ? 18 : marketState === "neutral" ? 0 : -100,
      min_entry_score: marketState === "risk_on" ? 70 : marketState === "neutral" ? 82 : 999,
      btc_5m_trend: btc5,
      btc_15m_trend: btc15,
      breadth_ratio: Number(breadth.toFixed(3)),
      recent_close_bias: flowUp ? "up" : flowDown ? "down" : "flat",
    };

    if (!state.latest || state.latest.market_state !== snap.market_state) {
      await appendLog({
        company_id: args.companyId as any,
        service_id: args.serviceId as any,
        ts: snap.timestamp,
        kind: "system",
        message: "market_state_changed",
        payload: snap,
      });
      if (args.onEvent) {
        await args.onEvent({
          timestamp: snap.timestamp,
          event_type: "market_state_changed",
          market: null,
          strategy_type: null,
          market_state: snap.market_state,
          side: null,
          reason: snap.entry_policy,
          balance_krw: null,
          position_qty: null,
          avg_buy_price: null,
          current_price: null,
          pnl_net: null,
          pnl_net_pct: null,
          note: `btc5=${snap.btc_5m_trend}, btc15=${snap.btc_15m_trend}, breadth=${snap.breadth_ratio}, close_bias=${snap.recent_close_bias}`,
        });
      }
    }
    state.latest = snap;
    return snap;
  };

  const entryGate = (
    payload: unknown,
    s: { market_state: "risk_on" | "neutral" | "risk_off"; min_entry_score: number; market_bonus: number },
  ) => {
    const score = signalStrengthScore(payload) + s.market_bonus;
    if (s.market_state === "risk_off") return { ok: false, reason: "market_state risk_off: 신규 진입 차단", score };
    if (score < s.min_entry_score) return { ok: false, reason: `entry score ${score} < ${s.min_entry_score}`, score };
    return { ok: true, score };
  };

  return {
    evaluate,
    status: () => state.latest,
    entryGate,
  };
}

