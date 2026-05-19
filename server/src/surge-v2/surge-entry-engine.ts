import { SurgeEntryDecision } from "./surge-types.js";
import { UpbitCandle } from "../upbit-public.js";

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
  surgeSetupPass?: boolean;
  surgeSetupScore?: number;
  surgeSetupGrade?: string;
  failedSurgeConditions?: string[];
  capturePromoted?: boolean;
  captureScore?: number;
  captureConfirmCount?: number;
  captureVolumeAccel1m?: number;
  captureNearHighPct?: number;
}>): SurgeEntryDecision {
  const p = (input.payload && typeof input.payload === "object" ? input.payload : {}) as Record<string, unknown>;
  const sourceKind = String(p.source_kind ?? "");
  const filterPass = Boolean(p.filter_pass);
  const scannerScore = num(p.scanner_score ?? p.signal_score ?? 0);
  const breakout = Boolean(p.breakout);
  const closeUpperHold = Boolean(p.close_upper_hold);
  const rise3mPct = num(p.rise_3m_pct ?? p.momentum_3m_pct ?? p.price_change_3m_pct ?? 0);
  const surgeSetupContext = {
    surge_setup_pass: input.surgeSetupPass ?? null,
    surge_setup_score: input.surgeSetupScore ?? null,
    surge_setup_grade: input.surgeSetupGrade ?? null,
    failed_surge_conditions: input.failedSurgeConditions ?? [],
  };

  // Market crash guards (moved from live-strategy.ts)
  const btcChange = input.marketState.btc_change_24h;
  const btcCrashGuard = btcChange <= -0.025;
  const marketPanicGuard =
    btcChange <= -0.015 &&
    (input.marketState.btc_5m_trend === "down" || input.marketState.btc_15m_trend === "down");
  
  if (btcCrashGuard || marketPanicGuard) {
    const reason = btcCrashGuard ? "surge_market_crash_guard" : "surge_market_panic_guard";
    console.info(JSON.stringify({
      tag: "SURGE_ENTRY_REJECTED_PROOF",
      ts: new Date().toISOString(),
      market: input.market,
      reject_reasons: [reason],
      price: 0, volume_ratio: input.volumeRatio, relative_strength: 0, breakout, pullback_rebound: false, overextended: false, spread_ok: true
    }));
    return {
      action: "reject",
      reason,
      authoritySource: "surge-v2",
      detail: { symbol: input.market, btc_change: btcChange, btc_5m_trend: input.marketState.btc_5m_trend, ...surgeSetupContext },
    };
  }

  let capturePromotionPassed = false;

  if (input.capturePromoted) {
    const minScore = Number(process.env.LIVE_SURGE_CAPTURE_MIN_SCORE ?? 55);
    const minVol = Number(process.env.LIVE_SURGE_CAPTURE_MIN_VOLUME_ACCEL ?? 1.6);
    const cScore = input.captureScore ?? 0;
    const cConf = input.captureConfirmCount ?? 0;
    const cVol = input.captureVolumeAccel1m ?? 0;
    const cNearHigh = input.captureNearHighPct ?? -100;

    const isStructureOk = breakout || closeUpperHold || cNearHigh >= -0.6;
    const isBtcOk = input.marketState.btc_5m_trend !== "down";

    if (cScore >= minScore && cConf >= 2 && cVol >= minVol && isStructureOk && isBtcOk) {
       capturePromotionPassed = true;
       console.info(JSON.stringify({
          tag: "SURGE_CAPTURE_PROMOTION_GATE_PROOF",
          ts: new Date().toISOString(),
          market: input.market,
          capture_score: cScore,
          confirm_count: cConf,
          volume_accel_1m: cVol,
          structure_ok: isStructureOk,
          btc_ok: isBtcOk,
          pass: true
       }));
    } else {
       console.info(JSON.stringify({
          tag: "SURGE_CAPTURE_PROMOTION_GATE_PROOF",
          ts: new Date().toISOString(),
          market: input.market,
          capture_score: cScore,
          confirm_count: cConf,
          volume_accel_1m: cVol,
          structure_ok: isStructureOk,
          btc_ok: isBtcOk,
          pass: false
       }));
       return {
         action: "reject",
         reason: "blocked_surge_capture_promotion_gate",
         authoritySource: "surge-v2",
         detail: { symbol: input.market, sub: "capture_promotion_failed", source_kind: sourceKind, ...surgeSetupContext }
       };
    }
  }

  if (!capturePromotionPassed) {
    if (!input.bridgePass) {
      return {
        action: "reject",
        reason: "blocked_surge_bridge",
        authoritySource: "surge-v2",
        detail: { symbol: input.market, sub: "bridge_pass_false", source_kind: sourceKind, ...surgeSetupContext },
      };
    }
    if (!filterPass) {
      return {
        action: "reject",
        reason: "blocked_surge_filter",
        authoritySource: "surge-v2",
        detail: { symbol: input.market, sub: "filter_pass_false", source_kind: sourceKind, ...surgeSetupContext },
      };
    }
  } else {
    if (!input.bridgePass || !filterPass) {
       console.info(JSON.stringify({
          tag: "SURGE_CAPTURE_PROMOTION_BYPASS_PROOF",
          ts: new Date().toISOString(),
          market: input.market,
          bridge_pass_original: input.bridgePass,
          filter_pass_original: filterPass,
          reason: "capture_promotion_gate_replaced_failures"
       }));
    }
  }
  if (!input.staleOk) {
    return {
      action: "reject",
      reason: "blocked_surge_stale",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, age_seconds: input.ageSeconds, sub: "signal_stale", ...surgeSetupContext },
    };
  }
  if (!(input.volumeRatio >= 1.2)) {
    return {
      action: "reject",
      reason: "blocked_surge_volume",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, volume_multiple: input.volumeRatio, required_min: 1.2, ...surgeSetupContext },
    };
  }
  if (!(breakout || closeUpperHold)) {
    return {
      action: "reject",
      reason: "blocked_surge_structure",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, breakout, close_upper_hold: closeUpperHold, sub: "need_breakout_or_upper_hold", ...surgeSetupContext },
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
        ...surgeSetupContext,
      },
    };
  }

  const c = input.candles5;
  if (c.length < 4) {
    return {
      action: "reject",
      reason: "blocked_surge_candles",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, sub: "insufficient_candles", len: c.length, ...surgeSetupContext },
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
        ...surgeSetupContext,
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
            ...surgeSetupContext,
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
      detail: {
        symbol: input.market,
        sub: "strong_bearish_last_bar",
        open,
        close,
        range_pct: ((high - low) / open) * 100,
        ...surgeSetupContext,
      },
    };
  }

  const closes = completed.map(x => num(x.trade_price));
  const e5 = emaLast(closes, 5) ?? 0;
  const btcMatched = input.marketState.btc_5m_trend === "up";
  const aboveEma = e5 > 0 && close > e5;
  const pullbackRebound = Boolean(p.would_pass_with_pullback_relaxed || closeUpperHold);
  const relativeStrengthOk = num(p.relative_strength ?? 0) > 0 || num(p.rsi ?? 0) > 55;
  
  const isConfirmed = input.volumeRatio >= 1.5 && btcMatched && aboveEma && pullbackRebound && relativeStrengthOk;
  const entryMode = isConfirmed ? "CONFIRMED_SURGE_ENTRY" : "FAST_SURGE_PROBE";
  
  const sizeMultiplier = entryMode === "FAST_SURGE_PROBE" ? 0.5 : 1.0;
  const stopPct = entryMode === "FAST_SURGE_PROBE" ? -2.5 : -3.4;
  const takeProfitPct = entryMode === "FAST_SURGE_PROBE" ? 3.5 : 5.0;
  const trailingStartPct = entryMode === "FAST_SURGE_PROBE" ? 2.0 : 3.0;
  const trailingGapPct = entryMode === "FAST_SURGE_PROBE" ? 1.5 : 2.0;

  const proofTag = entryMode === "FAST_SURGE_PROBE" ? "SURGE_ENTRY_FAST_PROBE_DECISION_PROOF" : "SURGE_ENTRY_CONFIRMED_DECISION_PROOF";
  const baseLogPayload = {
    ts: new Date().toISOString(),
    market: input.market,
    entry_mode: entryMode,
    price: close,
    volume_ratio: input.volumeRatio,
    relative_strength: num(p.relative_strength ?? 0),
    breakout,
    pullback_rebound: pullbackRebound,
    overextended: false,
    spread_ok: true,
    reject_reasons: [],
    stopPrice: close * (1 + stopPct / 100),
    takeProfitPrice: close * (1 + takeProfitPct / 100),
    trailingStopPct: trailingGapPct,
    strict_exit: true,
    exit_policy_attached: true
  };

  console.info(JSON.stringify({ tag: proofTag, ...baseLogPayload }));

  return {
    action: "enter",
    reason: "surge_entry_approved",
    authoritySource: "surge-v2",
    entryMode,
    sizeMultiplier,
    stopPct,
    takeProfitPct,
    trailingStartPct,
    trailingGapPct,
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
      ...surgeSetupContext,
    },
  };
}
