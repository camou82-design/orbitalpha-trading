import { mvpSignalPayloadV2Schema, signalStrengthScore } from "@orbitalpha/shared";
import { LIVE_ENTRY_PIPELINE } from "./strategy-risk-config.js";
import type { UpbitCandle } from "./upbit-public.js";

/** 하위 호환 export — 실제 값은 LIVE_ENTRY_PIPELINE.min_signal_strength_score */
export const ENTRY_PIPELINE_MID_SCORE_FLOOR = LIVE_ENTRY_PIPELINE.min_signal_strength_score;

export type EntryPipelineMarketState = {
  market_state: string;
  btc_5m_trend: "up" | "down" | "flat";
  btc_15m_trend: "up" | "down" | "flat";
};

function num(x: unknown): number {
  return typeof x === "number" ? x : Number(x);
}

function emaLast(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes[0]!;
  for (let i = 1; i < closes.length; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

/**
 * 스팟 롱 전용 — 후보(신호 로그)와 체결 직전 4단계 분리.
 * 캔들은 signal-engine과 동일하게 “마지막 봉은 미완성” 가정 → 완성봉만 `slice(0, -1)`.
 */
export function evaluateSpotLongEntryPipeline(input: Readonly<{
  market: string;
  payload: unknown;
  candles5: UpbitCandle[];
  marketState: EntryPipelineMarketState;
  volumeRatio: number;
}>):
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; message: string; detail: Record<string, unknown> } {
  const score = signalStrengthScore(input.payload);
  if (score < LIVE_ENTRY_PIPELINE.min_signal_strength_score) {
    return {
      ok: false,
      message: "blocked_low_signal",
      detail: {
        symbol: input.market,
        signal_strength_score: score,
        floor: LIVE_ENTRY_PIPELINE.min_signal_strength_score,
        note: "pipeline_min_signal_strength",
      },
    };
  }

  const volMin =
    input.marketState.market_state === "risk_on"
      ? LIVE_ENTRY_PIPELINE.min_volume_ratio_risk_on
      : LIVE_ENTRY_PIPELINE.min_volume_ratio_neutral;
  if (input.volumeRatio < volMin) {
    return {
      ok: false,
      message: "blocked_low_volume_for_market_mode",
      detail: {
        symbol: input.market,
        volume_ratio: input.volumeRatio,
        required_min: volMin,
        market_state: input.marketState.market_state,
      },
    };
  }

  const parsed = mvpSignalPayloadV2Schema.safeParse(input.payload);
  const filterPass = parsed.success && parsed.data.filter_pass;
  const relaxedPass =
    parsed.success &&
    (Boolean(parsed.data.would_pass_with_pullback_relaxed) ||
      Boolean(parsed.data.would_pass_with_vol_close_relaxed_a) ||
      Boolean(parsed.data.would_pass_with_breakout_relaxed_a) ||
      Boolean(parsed.data.pair_pass_breakout_b_and_pullback_relaxed) ||
      Boolean(parsed.data.pair_pass_breakout_b_and_vol_close_a));
  if (!filterPass && !relaxedPass) {
    return {
      ok: false,
      message: "blocked_trend_filter",
      detail: {
        symbol: input.market,
        sub: "mvp_filter_pass_false",
        signal_strength_score: score,
        note: "filter_pass=false and no relaxed pass flags",
      },
    };
  }

  const c = input.candles5;
  if (c.length < 38) {
    return {
      ok: false,
      message: "blocked_trend_filter",
      detail: { symbol: input.market, sub: "insufficient_candles", len: c.length },
    };
  }

  const completed = c.slice(0, -1);
  const closes = completed.map((x) => num(x.trade_price));
  const e5 = emaLast(closes, 5);
  const e13 = emaLast(closes, 13);
  const e34 = emaLast(closes, 34);
  if (e5 === null || e13 === null || e34 === null) {
    return {
      ok: false,
      message: "blocked_trend_filter",
      detail: { symbol: input.market, sub: "ema_not_ready" },
    };
  }

  const lastClose = closes[closes.length - 1]!;
  const stacked = e5 > e13 * 1.0005 && e13 > e34 * 1.0005;
  const looseTrend = e13 > e34 * 1.0003 && lastClose > e5;
  const emaGap5_13_pct = e13 > 0 ? ((e5 / e13) - 1) * 100 : 0;
  const emaGap13_34_pct = e34 > 0 ? ((e13 / e34) - 1) * 100 : 0;
  if (!stacked && !looseTrend) {
    return {
      ok: false,
      message: "blocked_trend_filter",
      detail: {
        symbol: input.market,
        sub: "ema_stack_fail",
        e5,
        e13,
        e34,
        last_close: lastClose,
        ema_gap_5_13_pct: Number(emaGap5_13_pct.toFixed(4)),
        ema_gap_13_34_pct: Number(emaGap13_34_pct.toFixed(4)),
      },
    };
  }

  const sidewaysStrict =
    input.marketState.market_state === "neutral" &&
    input.marketState.btc_5m_trend === "flat" &&
    input.marketState.btc_15m_trend === "flat";
  if (sidewaysStrict) {
    if (!stacked) {
      return {
        ok: false,
        message: "entry_skipped_sideways",
        detail: { symbol: input.market, sub: "need_full_ema_stack_when_btc_flat" },
      };
    }
    if (input.volumeRatio < LIVE_ENTRY_PIPELINE.sideways_strict_min_volume_ratio) {
      return {
        ok: false,
        message: "entry_skipped_sideways",
        detail: {
          symbol: input.market,
          sub: "low_volume_in_sideways",
          volume_ratio: input.volumeRatio,
          required_min: LIVE_ENTRY_PIPELINE.sideways_strict_min_volume_ratio,
        },
      };
    }
  }

  const tail = completed.slice(-8);
  if (tail.length < 5) {
    return { ok: false, message: "blocked_no_pullback", detail: { symbol: input.market, sub: "tail_short" } };
  }
  const recentLow = Math.min(...tail.map((b) => num(b.low_price)));
  const touchNearShort = recentLow <= e5 * 1.004;
  const reclaimed = lastClose >= e5 * 0.999;
  if (!touchNearShort || !reclaimed) {
    return {
      ok: false,
      message: "blocked_no_pullback",
      detail: {
        symbol: input.market,
        recent_low: recentLow,
        ema5: e5,
        last_close: lastClose,
        touch_near_short: touchNearShort,
        reclaimed,
      },
    };
  }

  if (input.volumeRatio > LIVE_ENTRY_PIPELINE.overheated_volume_max) {
    return {
      ok: false,
      message: "blocked_no_pullback",
      detail: {
        symbol: input.market,
        sub: "volume_overheated",
        volume_ratio: input.volumeRatio,
        max_allowed: LIVE_ENTRY_PIPELINE.overheated_volume_max,
      },
    };
  }

  const swingBars = completed.slice(-12, -2);
  if (swingBars.length < 4) {
    return {
      ok: false,
      message: "blocked_rebreak_not_confirmed",
      detail: { symbol: input.market, sub: "swing_window_short" },
    };
  }
  const swingHigh = Math.max(...swingBars.map((b) => num(b.high_price)));
  const lastBar = completed[completed.length - 1]!;
  const lastHigh = num(lastBar.high_price);
  const broke = lastHigh >= swingHigh * 0.9995 || lastClose >= swingHigh * 0.9993;
  if (!broke) {
    return {
      ok: false,
      message: "blocked_rebreak_not_confirmed",
      detail: { symbol: input.market, swing_high: swingHigh, last_high: lastHigh, last_close: lastClose },
    };
  }
  if (input.volumeRatio < LIVE_ENTRY_PIPELINE.rebreak_min_volume_ratio) {
    return {
      ok: false,
      message: "blocked_rebreak_not_confirmed",
      detail: {
        symbol: input.market,
        sub: "volume_fade_after_rebreak",
        volume_ratio: input.volumeRatio,
        required_min: LIVE_ENTRY_PIPELINE.rebreak_min_volume_ratio,
      },
    };
  }

  return {
    ok: true,
    detail: {
      symbol: input.market,
      signal_strength_score: score,
      e5,
      e13,
      e34,
      last_close: lastClose,
      swing_high: swingHigh,
      volume_ratio: input.volumeRatio,
      sideways_strict: sidewaysStrict,
    },
  };
}

const SURGE_MIN_SCANNER_SCORE = Math.max(40, Math.min(85, Number(process.env.LIVE_SURGE_MIN_SCANNER_SCORE ?? 52)));
const SURGE_CRASH_UPPER_WICK_MAX = Math.max(0.35, Math.min(0.85, Number(process.env.LIVE_SURGE_CRASH_UPPER_WICK_MAX ?? 0.58)));
const SURGE_CRASH_3BAR_5M_RETURN_MAX_PCT = Math.max(8, Math.min(35, Number(process.env.LIVE_SURGE_CRASH_3BAR_5M_RETURN_MAX_PCT ?? 16)));

/**
 * 급등 스캐너 후보 전용 — 스팟 롱 눌림목(`evaluateSpotLongEntryPipeline`)과 분리.
 * 높은 `volume_multiple` 자체는 차단 사유가 아니며, 윗꼬리·단기 수직 급등 등 crash guard만 적용한다.
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
}>):
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; message: string; detail: Record<string, unknown> } {
  const p = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Record<string, unknown>;
  const sourceKind = String(p.source_kind ?? "");
  const filterPass = Boolean(p.filter_pass);
  const scannerScore = num(p.scanner_score ?? p.signal_score ?? 0);
  const breakout = Boolean(p.breakout);
  const closeUpperHold = Boolean(p.close_upper_hold);
  const rise3mPct = num(p.rise_3m_pct ?? p.momentum_3m_pct ?? p.price_change_3m_pct ?? 0);

  if (!input.bridgePass) {
    return {
      ok: false,
      message: "blocked_surge_bridge",
      detail: { symbol: input.market, sub: "bridge_pass_false", source_kind: sourceKind },
    };
  }
  if (!filterPass) {
    return {
      ok: false,
      message: "blocked_surge_filter",
      detail: { symbol: input.market, sub: "filter_pass_false", source_kind: sourceKind },
    };
  }
  if (!input.staleOk) {
    return {
      ok: false,
      message: "blocked_surge_stale",
      detail: { symbol: input.market, age_seconds: input.ageSeconds, sub: "signal_stale" },
    };
  }
  if (!(input.volumeRatio >= 1.2)) {
    return {
      ok: false,
      message: "blocked_surge_volume",
      detail: { symbol: input.market, volume_multiple: input.volumeRatio, required_min: 1.2 },
    };
  }
  if (!(breakout || closeUpperHold)) {
    return {
      ok: false,
      message: "blocked_surge_structure",
      detail: { symbol: input.market, breakout, close_upper_hold: closeUpperHold, sub: "need_breakout_or_upper_hold" },
    };
  }
  const momentumOk = rise3mPct > 0 || scannerScore >= SURGE_MIN_SCANNER_SCORE;
  if (!momentumOk) {
    return {
      ok: false,
      message: "blocked_surge_momentum",
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
      ok: false,
      message: "blocked_surge_candles",
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
      ok: false,
      message: "blocked_surge_crash_upper_wick",
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
          ok: false,
          message: "blocked_surge_crash_vertical",
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
      ok: false,
      message: "blocked_surge_crash_reject",
      detail: { symbol: input.market, sub: "strong_bearish_last_bar", open, close, range_pct: ((high - low) / open) * 100 },
    };
  }

  return {
    ok: true,
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
