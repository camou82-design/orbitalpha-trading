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
  if (!filterPass) {
    return {
      ok: false,
      message: "blocked_trend_filter",
      detail: {
        symbol: input.market,
        sub: "mvp_filter_pass_false",
        signal_strength_score: score,
        note: "MID+ 후보라도 6필터 완전 통과 전에는 진입하지 않음",
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
