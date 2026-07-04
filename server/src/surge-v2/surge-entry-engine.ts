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
  candles1: UpbitCandle[];
  candles5: UpbitCandle[];
  currentPrice: number;
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
  tickLease?: number;
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

  const now = new Date();
  const kstTimeStr = now.toLocaleTimeString("en-US", { timeZone: "Asia/Seoul", hour12: false, hour: "numeric", minute: "numeric" });
  const [kstHour, kstMinute] = kstTimeStr.split(":").map(Number);
  const kstTotalMins = kstHour * 60 + kstMinute;

  // UPBIT_DAILY_RESET_SURGE_WINDOW: 08:55 ~ 09:03
  if (kstTotalMins >= 535 && kstTotalMins < 543) {
    console.info(JSON.stringify({
      tag: "SURGE_ENTRY_REJECTED_PROOF",
      ts: now.toISOString(),
      market: input.market,
      reject_reasons: ["UPBIT_DAILY_RESET_SURGE_WINDOW"],
      price: 0, volume_ratio: input.volumeRatio, relative_strength: 0, breakout, pullback_rebound: false, overextended: false, spread_ok: true
    }));
    return {
      action: "reject",
      reason: "UPBIT_DAILY_RESET_SURGE_WINDOW",
      authoritySource: "surge-v2",
      detail: { symbol: input.market, kst_time: kstTimeStr, sub: "daily_reset_window_registration_only", ...surgeSetupContext }
    };
  }

  // RECLAIM 우선 구간: 09:03 ~ 09:15
  if (kstTotalMins >= 543 && kstTotalMins < 555) {
     if (!input.capturePromoted) {
        return {
          action: "reject",
          reason: "UPBIT_DAILY_RESET_RECLAIM_WINDOW",
          authoritySource: "surge-v2",
          detail: { symbol: input.market, kst_time: kstTimeStr, sub: "need_capture_promotion_in_reclaim_window", ...surgeSetupContext }
        };
     }
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

  // --- LATE_SURGE_CHASE_BLOCK ---
  let chaseBlockReasons: string[] = [];
  if (input.candles1 && input.candles1.length >= 4) {
      const c1Completed = input.candles1.slice(0, -1);
      const c1Last = c1Completed[c1Completed.length - 1];
      if (c1Last) {
          const tail1m = c1Completed.slice(-3);
          const o1m_start = num(tail1m[0]!.opening_price);
          const c1m_end = num(tail1m[tail1m.length - 1]!.trade_price);
          const recent_1m_return_3bar_pct = o1m_start > 0 ? ((c1m_end / o1m_start) - 1) * 100 : 0;
          
          const closes1m = c1Completed.map(x => num(x.trade_price));
          const ema1m = emaLast(closes1m, 5) ?? c1m_end;
          const distance_from_ema1m_pct = ((input.currentPrice - ema1m) / ema1m) * 100;
          
          const h1m = num(c1Last.high_price);
          const l1m = num(c1Last.low_price);
          const cl1m = num(c1Last.trade_price);
          const op1m = num(c1Last.opening_price);
          const range1m = Math.max(1e-9, h1m - l1m);
          const upper_wick_ratio_1m = (h1m - Math.max(cl1m, op1m)) / range1m;
          
          const prev5_1m = c1Completed.slice(-6, -1);
          const lastNotional = cl1m * num(c1Last.candle_acc_trade_volume);
          const prevAvgNotional = prev5_1m.reduce((a, b) => a + num(b.trade_price)*num(b.candle_acc_trade_volume), 0) / Math.max(1, prev5_1m.length);
          const volume_accel_1m = prevAvgNotional > 0 ? lastNotional / prevAvgNotional : 1.0;
          
          // 모든 시간대에 고점 추격 매수 방지 가드를 상시 가동
          const LIVE_SURGE_LATE_CHASE_1M_RETURN_MAX = Number(process.env.LIVE_SURGE_LATE_CHASE_1M_RETURN_MAX ?? 3.0); // 3% 이상 급등 시 차단
          const LIVE_SURGE_LATE_CHASE_EMA1M_DIST_MAX = Number(process.env.LIVE_SURGE_LATE_CHASE_EMA1M_DIST_MAX ?? 2.5); // EMA 1m 이격도 2.5% 이상 차단
          const LIVE_SURGE_LATE_CHASE_WICK_RATIO_MAX = Number(process.env.LIVE_SURGE_LATE_CHASE_WICK_RATIO_MAX ?? 0.45); // 윗꼬리 45% 이상 차단
          const LIVE_SURGE_LATE_CHASE_VOL_DROP_MAX = Number(process.env.LIVE_SURGE_LATE_CHASE_VOL_DROP_MAX ?? 0.6);   // 거래량 60% 이하 감속 시 차단

          let chaseCondCount = 0;
          if (recent_1m_return_3bar_pct >= LIVE_SURGE_LATE_CHASE_1M_RETURN_MAX) { chaseCondCount++; chaseBlockReasons.push("recent_1m_return_3bar_pct_high"); }
          if (distance_from_ema1m_pct >= LIVE_SURGE_LATE_CHASE_EMA1M_DIST_MAX) { chaseCondCount++; chaseBlockReasons.push("distance_from_ema1m_pct_high"); }
          if (upper_wick_ratio_1m >= LIVE_SURGE_LATE_CHASE_WICK_RATIO_MAX) { chaseCondCount++; chaseBlockReasons.push("upper_wick_ratio_1m_high"); }
          if (volume_accel_1m <= LIVE_SURGE_LATE_CHASE_VOL_DROP_MAX) { chaseCondCount++; chaseBlockReasons.push("volume_accel_1m_low"); }
          
          const c_and_d = distance_from_ema1m_pct >= LIVE_SURGE_LATE_CHASE_EMA1M_DIST_MAX && volume_accel_1m <= LIVE_SURGE_LATE_CHASE_VOL_DROP_MAX;

          if (chaseCondCount >= 2 || c_and_d) {
              console.info(JSON.stringify({
                tag: "SURGE_LATE_CHASE_EVALUATED_PROOF",
                ts: new Date().toISOString(),
                late_entry_guard_triggered: true,
                market: input.market,
                kst_time: kstTimeStr,
                age_seconds: input.ageSeconds,
                source_kind: sourceKind,
                is_reset_late_chase_window: true,
                thresholds: {
                    return_max: LIVE_SURGE_LATE_CHASE_1M_RETURN_MAX,
                    ema_dist_max: LIVE_SURGE_LATE_CHASE_EMA1M_DIST_MAX,
                    wick_ratio_max: LIVE_SURGE_LATE_CHASE_WICK_RATIO_MAX,
                    vol_drop_max: LIVE_SURGE_LATE_CHASE_VOL_DROP_MAX
                },
                chase_block_reasons: chaseBlockReasons,
                ck_lease: input.tickLease
            }));
             return {
                 action: "reject",
                 reason: "blocked_surge_late_chase",
                 authoritySource: "surge-v2",
                 detail: {
                     symbol: input.market,
                     sub: "late_surge_chase",
                     chase_block_reasons: chaseBlockReasons,
                     volume_accel_1m,
                     ...surgeSetupContext
                 }
             };
          }
      }
  }
  // --- END LATE_SURGE_CHASE_BLOCK ---

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
