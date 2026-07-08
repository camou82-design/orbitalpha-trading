import type { SignalLogEntry } from "@orbitalpha/shared";
import { mvpSignalPayloadV2Schema, ORDER_LIMITS, runEntryScoreGate, signalStrengthScore, type MarketState } from "@orbitalpha/shared";
import { appendLog } from "./log-store.js";
import { fetchMinuteCandles } from "./upbit-public.js";

export type { MarketState };
export type EntryPolicy = "적극 진입" | "선별 진입" | "축소 진입";

export type MarketStateSnapshot = {
  timestamp: string;
  market_state: MarketState;
  entry_policy: EntryPolicy;
  market_bonus: number;
  min_entry_score: number;
  /** risk_off가 아닐 때만 신규·추가 매수 게이트(점수) 평가 진행. */
  regime_allows_new_and_additional_buys: boolean;
  order_limits: typeof ORDER_LIMITS;
  btc_5m_trend: "up" | "down" | "flat";
  btc_15m_trend: "up" | "down" | "flat";
  breadth_ratio: number;
  recent_close_bias: "up" | "down" | "flat";
  /** BTC 약세 구간 보수 모드 여부 */
  conservative_mode: boolean;
  /** risk_off에서도 강한 대표 코인에 한해 신규 진입 예외 허용 */
  exception_entry_allowed: boolean;
  /** BTC RSI 14일 연산값 */
  btc_rsi?: number;
};

/** 주문 직전 게이트용 — UI `market-state` 와 동일 스냅샷 기준. */
export type OrderBuyGateResult =
  | {
      ok: true;
      market_state: MarketState;
      entry_policy: EntryPolicy;
      new_entry_blocked: false;
      add_entry_blocked: false;
      blocked_reason: null;
      size_scale: number;
    }
  | {
      ok: false;
      market_state: MarketState;
      entry_policy: EntryPolicy;
      new_entry_blocked: boolean;
      add_entry_blocked: boolean;
      blocked_reason: string;
      size_scale: number;
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
    type?: string;
    final_close?: boolean;
    partial_exit?: boolean;
    stage?: string;
  }) => Promise<void>;
}) {
  const state: { latest: MarketStateSnapshot | null } = { latest: null };

  const evaluate = async () => {
    const t0 = Date.now();

    const wrap = async <T>(name: string, p: Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        const res = await p;
        const end = Date.now();
        console.info(
          JSON.stringify({
            tag: "MARKET_STATE_EVALUATE_PHASE_PROOF",
            ts: new Date().toISOString(),
            phase: name,
            elapsed_ms: end - start,
            outcome: "ok",
          }),
        );
        return res;
      } catch (e) {
        console.error(
          JSON.stringify({
            tag: "MARKET_STATE_EVALUATE_PHASE_PROOF",
            ts: new Date().toISOString(),
            phase: name,
            elapsed_ms: Date.now() - start,
            outcome: "error",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        throw e;
      }
    };

    const [c5, c15, logs] = await Promise.all([
      wrap("btc_5m", fetchMinuteCandles("KRW-BTC", 5, 50)),
      wrap("btc_15m", fetchMinuteCandles("KRW-BTC", 15, 50)),
      wrap("read_logs", args.readLogs(150)),
    ]);

    const t1 = Date.now();
    if (t1 - t0 > 15000) {
      console.warn(
        JSON.stringify({
          tag: "MARKET_STATE_EVALUATE_TIMEOUT_CAUSE_PROOF",
          ts: new Date().toISOString(),
          elapsed_ms: t1 - t0,
          reason: "slow_io_parallel_total_exceeded_15s",
        }),
      );
    }

    const closes5 = c5.map((c) => c.trade_price);
    const closes15 = c15.map((c) => c.trade_price);
    
    // 14일 RSI 연산 (5분봉 14개 기준의 RSI 계산 헬퍼)
    const btcRsi = (() => {
      if (closes5.length < 15) return undefined;
      let gains = 0;
      let losses = 0;
      for (let i = 1; i <= 14; i++) {
        const diff = Number(closes5[closes5.length - 15 + i]) - Number(closes5[closes5.length - 15 + i - 1]);
        if (diff > 0) gains += diff;
        else losses -= diff;
      }
      let avgGain = gains / 14;
      let avgLoss = losses / 14;
      if (avgLoss === 0) return 100;
      let rs = avgGain / avgLoss;
      let rsi = 100 - 100 / (1 + rs);
      
      // 와일더(Wilder) 스무딩 적용 (나머지 캔들 대상)
      const remainingStart = closes5.length - 14;
      for (let i = remainingStart; i < closes5.length; i++) {
        const diff = Number(closes5[i]) - Number(closes5[i - 1]);
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
      }
      if (avgLoss === 0) return 100;
      rs = avgGain / avgLoss;
      return 100 - 100 / (1 + rs);
    })();

    const btc5 = trendByEma(closes5, 5, 13);
    const btc15 = trendByEma(closes15, 4, 10);
    const r5 = closes5.length > 6 ? (closes5[closes5.length - 1]! / closes5[closes5.length - 6]! - 1) * 100 : 0;
    const r15 = closes15.length > 2 ? (closes15[closes15.length - 1]! / closes15[closes15.length - 2]! - 1) * 100 : 0;
    const recent3 = closes5.slice(-3);
    const flowUp = recent3.length === 3 && recent3[2]! >= recent3[1]! && recent3[1]! >= recent3[0]!;
    const flowDown = recent3.length === 3 && recent3[2]! <= recent3[1]! && recent3[1]! <= recent3[0]!;
    const sharpDrop = r5 <= -1.4 || r15 <= -2.2;

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

    const conservativeMode = marketState === "risk_off";
    const snap: MarketStateSnapshot = {
      timestamp: new Date().toISOString(),
      market_state: marketState,
      // 분화 장세: risk_off도 차단이 아닌 축소 진입 모드로 운영.
      entry_policy: marketState === "risk_on" ? "적극 진입" : marketState === "neutral" ? "선별 진입" : "축소 진입",
      market_bonus: marketState === "risk_on" ? 18 : marketState === "neutral" ? 0 : -10,
      // 과거 neutral=90 컷은 신규진입·추가매수(대시보드 표기 포함)를 과도하게 보수적으로 만들었음.
      min_entry_score: marketState === "risk_on" ? 72 : marketState === "neutral" ? 76 : 88,
      regime_allows_new_and_additional_buys: true,
      order_limits: { ...ORDER_LIMITS },
      btc_5m_trend: btc5,
      btc_15m_trend: btc15,
      breadth_ratio: Number(breadth.toFixed(3)),
      recent_close_bias: flowUp ? "up" : flowDown ? "down" : "flat",
      conservative_mode: conservativeMode,
      exception_entry_allowed: conservativeMode,
      btc_rsi: btcRsi,
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
  ) => runEntryScoreGate(s.market_state, s.min_entry_score, s.market_bonus, payload);

  return {
    evaluate,
    status: () => state.latest,
    entryGate,
  };
}

/**
 * 신규 진입·추가매수 공통 게이트.
 * - 신규: 장세(risk_off 차단) + entry score(min_entry_score) 반드시 통과.
 * - 추가매수: risk_off 전면 차단(물타기/추가 진입 없음).
 */
export function assertOrderBuyAllowed(
  snap: MarketStateSnapshot,
  args: {
    kind: "new_entry" | "add_to_position";
    signalPayload: unknown | undefined;
    strategyType?: string;
    market?: string;
    entrySignalType?: string;
  },
): OrderBuyGateResult {
  const { market_state, entry_policy } = snap;
  const size_scale = market_state === "risk_on" ? 1 : market_state === "neutral" ? 0.72 : 0.45;

  const deny = (
    blocked_reason: string,
    new_entry_blocked: boolean,
    add_entry_blocked: boolean,
  ): OrderBuyGateResult => ({
    ok: false,
    market_state,
    entry_policy,
    new_entry_blocked,
    add_entry_blocked,
    blocked_reason,
    size_scale: 0,
  });

  const strategyType = args.strategyType || "";
  const entrySignalType = args.entrySignalType || "";

  const isAggressiveSurgeStrategy =
    strategyType === "momentum" ||
    strategyType === "surge_breakout" ||
    strategyType === "surge_chase";

  const isReclaimStrategy =
    strategyType === "reclaim" ||
    strategyType === "surge_reclaim" ||
    entrySignalType === "reclaim";

  if (args.kind === "new_entry") {
    if (market_state === "risk_off") {
      return deny("risk_off: 신규 진입 금지", true, false);
    }
    // neutral_market_surge_blocked: aggressive surge(momentum/surge_breakout/surge_chase)에만 적용
    if (isAggressiveSurgeStrategy) {
      if (market_state === "neutral") {
        return deny("neutral_market_surge_blocked: 중립 장세에서는 surge 진입 차단", true, false);
      }
    }
    // BTC RSI < 50 차단: aggressive surge + reclaim 계열 모두에 적용 (기존 안전장치 유지)
    if (isAggressiveSurgeStrategy || isReclaimStrategy) {
      if (snap.btc_rsi !== undefined && snap.btc_rsi < 50) {
        return deny(`btc_rsi_low_surge_blocked: BTC RSI가 50 미만이라 진입 차단 (${snap.btc_rsi.toFixed(1)})`, true, false);
      }
    }
    const g = runEntryScoreGate(market_state, snap.min_entry_score, snap.market_bonus, args.signalPayload);
    if (!g.ok) {
      return deny(g.reason, true, false);
    }
    return {
      ok: true,
      market_state,
      entry_policy,
      new_entry_blocked: false,
      add_entry_blocked: false,
      blocked_reason: null,
      size_scale,
    };
  }

  if (market_state === "risk_off") {
    return deny("risk_off: 추가 매수·DCA 금지", false, true);
  }

  return {
    ok: true,
    market_state,
    entry_policy,
    new_entry_blocked: false,
    add_entry_blocked: false,
    blocked_reason: null,
    size_scale,
  };
}

