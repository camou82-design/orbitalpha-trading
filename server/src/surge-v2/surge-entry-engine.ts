import { SurgeEntryDecision } from "./surge-types.js";
import { UpbitCandle } from "../upbit-public.js";

function num(x: unknown): number {
  return typeof x === "number" ? x : Number(x);
}

const SURGE_MIN_SCANNER_SCORE = Math.max(40, Math.min(85, Number(process.env.LIVE_SURGE_MIN_SCANNER_SCORE ?? 52)));
const SURGE_CRASH_UPPER_WICK_MAX = Math.max(0.35, Math.min(0.85, Number(process.env.LIVE_SURGE_CRASH_UPPER_WICK_MAX ?? 0.58)));
const SURGE_CRASH_3BAR_5M_RETURN_MAX_PCT = Math.max(8, Math.min(35, Number(process.env.LIVE_SURGE_CRASH_3BAR_5M_RETURN_MAX_PCT ?? 16)));

export type EntryPipelineMarketState = {
  market_state: string;
  btc_5m_trend: "up" | "down" | "flat";
  btc_15m_trend: "up" | "down" | "flat";
  btc_change_24h: number;
};

/**
 * 급등 스캐너 후보 전용 진입 판단 엔진 (v2)
 * 기존 live-entry-pipeline.ts의 evaluateSurgeEntryPipeline() 로직을 계승한다.
 * 수치 변경은 일체 금지됨.
 */
export function evaluateSurgeEntryPipeline(input: Readonly<{
  market: string;
  payload: unknown;
  candles5: UpbitCandle[];
  marketState: EntryPipelineMarketState;
  volumeRatio: number;
  bridgePass: boolean;
  staleOk: boolean;
  ageSeconds: number | null;
}>): SurgeEntryDecision {
  const p = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Record<string, unknown>;
  const sourceKind = String(p.source_kind ?? "");
  const filterPass = Boolean(p.filter_pass);
  const scannerScore = num(p.scanner_score ?? p.signal_score ?? 0);
  const breakout = Boolean(p.breakout);
  const closeUpperHold = Boolean(p.close_upper_hold);
  const rise3mPct = num(p.rise_3m_pct ?? p.momentum_3m_pct ?? p.price_change_3m_pct ?? 0);

  // Market crash guards (moved from live-strategy.ts)
  const btcChange = input.marketState.btc_change_24h;
  const btcCrashGuard = btcChange <= -0.025;
  const marketPanicGuard =
    btcChange <= -0.015 &&
    (input.marketState.btc_5m_trend === "down" || input.marketState.btc_15m_trend === "down");
  
  if (btcCrashGuard || marketPanicGuard) {
    return {
      action: "reject",
      reason: btcCrashGuard ? "surge_market_crash_guard" : "surge_market_panic_guard",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, btc_change: btcChange, btc_5m_trend: input.marketState.btc_5m_trend },
    };
  }

  if (!input.bridgePass) {
    return {
      action: "reject",
      reason: "blocked_surge_bridge",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, sub: "bridge_pass_false", source_kind: sourceKind },
    };
  }
  if (!filterPass) {
    return {
      action: "reject",
      reason: "blocked_surge_filter",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, sub: "filter_pass_false", source_kind: sourceKind },
    };
  }
  if (!input.staleOk) {
    return {
      action: "reject",
      reason: "blocked_surge_stale",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, age_seconds: input.ageSeconds, sub: "signal_stale" },
    };
  }
  if (!(input.volumeRatio >= 1.2)) {
    return {
      action: "reject",
      reason: "blocked_surge_volume",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, volume_multiple: input.volumeRatio, required_min: 1.2 },
    };
  }
  if (!(breakout || closeUpperHold)) {
    return {
      action: "reject",
      reason: "blocked_surge_structure",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, breakout, close_upper_hold: closeUpperHold, sub: "need_breakout_or_upper_hold" },
    };
  }
  const momentumOk = rise3mPct > 0 || scannerScore >= SURGE_MIN_SCANNER_SCORE;
  if (!momentumOk) {
    return {
      action: "reject",
      reason: "blocked_surge_momentum",
      authoritySource: "surge-v2",
      detail: {
        symbol: input.market,
        rise_3m_pct: rise3mPct,
        scanner_score: scannerScore,
        required_rise_or_score: `rise_3m_pct>0 or scanner_score>=${SURGE_MIN_SCANNER_SCORE}`,
      },
    };
  }

  const c = input.candles5;
  if (c.length < 4) {
    return {
      action: "reject",
      reason: "blocked_surge_candles",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, sub: "insufficient_candles", len: c.length },
    };
  }
  const completed = c.slice(0, -1);
  const last = completed[completed.length - 1]!;
  const high = num(last.high_price);
  const low = num(last.low_price);
  const close = num(last.trade_price);
  const open = num(last.opening_price);
  const range = Math.max(1e-9, high - low);
  const upperWickRatio = (high - close) / range;
  if (upperWickRatio > SURGE_CRASH_UPPER_WICK_MAX) {
    return {
      action: "reject",
      reason: "blocked_surge_crash_upper_wick",
      authoritySource: "surge-v2",
      detail: {
        symbol: input.market,
        upper_wick_ratio: Number(upperWickRatio.toFixed(4)),
        max: SURGE_CRASH_UPPER_WICK_MAX,
      },
    };
  }

  if (completed.length >= 4) {
    const tail = completed.slice(-3);
    const o0 = num(tail[0]!.opening_price);
    const cLast = num(tail[tail.length - 1]!.trade_price);
    if (o0 > 0) {
      const ret3barPct = ((cLast / o0) - 1) * 100;
      if (ret3barPct > SURGE_CRASH_3BAR_5M_RETURN_MAX_PCT) {
        return {
          action: "reject",
          reason: "blocked_surge_crash_vertical",
          authoritySource: "surge-v2",
          detail: {
            symbol: input.market,
            three_bar_return_pct: Number(ret3barPct.toFixed(2)),
            max_pct: SURGE_CRASH_3BAR_5M_RETURN_MAX_PCT,
          },
        };
      }
    }
  }

  const bearishReject = open > 0 && close < open * 0.985 && (high - low) / open > 0.04;
  if (bearishReject) {
    return {
      action: "reject",
      reason: "blocked_surge_crash_reject",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, sub: "strong_bearish_last_bar", open, close, range_pct: ((high - low) / open) * 100 },
    };
  }

  return {
    action: "enter",
    reason: "surge_entry_approved",
    authoritySource: "surge-v2",
    detail: {
      symbol: input.market,
      pipeline: "surge",
      source_kind: sourceKind,
      scanner_score: scannerScore,
      volume_multiple: input.volumeRatio,
      breakout,
      close_upper_hold: closeUpperHold,
      rise_3m_pct: rise3mPct,
      bridge_pass: input.bridgePass,
      filter_pass: filterPass,
      stale_ok: input.staleOk,
      age_seconds: input.ageSeconds,
      upper_wick_ratio: Number(upperWickRatio.toFixed(4)),
      market_state: input.marketState.market_state,
    },
  };
}
