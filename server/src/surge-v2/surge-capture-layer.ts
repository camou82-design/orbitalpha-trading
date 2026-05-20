import fs from "fs";
import path from "path";

export interface SurgeCaptureItem {
  market: string;
  first_seen_at: string;
  last_seen_at: string;
  tick_lease: string;
  capture_score: number;
  capture_grade: "LOW" | "MID" | "HIGH";
  source_kind: string;
  scanner_score: number;
  volume_multiple: number;
  volume_accel_1m: number;
  near_high_pct: number;
  breakout: boolean;
  close_upper_hold: boolean;
  relative_strength: number;
  btc_5m_trend: string;
  btc_15m_trend: string;
  btc_change_24h: number;
  reject_risks: string[];
  confirm_count: number;
  last_price: number;
  high_price_reference: number;
  status: "WATCHING" | "PROMOTED" | "EXPIRED" | "REJECTED" | "RECLAIM_WAIT";
  
  // Reclaim Wait fields
  reference_high_price?: number;
  reclaim_base_price?: number;
  watch_price?: number;
  pullback_from_high_pct?: number;
  reclaim_attempt_count?: number;
  chase_block_reasons?: string[];
  first_seen_tick?: number;
  last_seen_tick?: number;
}

const DATA_FILE = path.join(process.cwd(), "data", "runtime", "surge-capture-watch.json");

export function loadCaptureQueue(): SurgeCaptureItem[] {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load surge capture queue", e);
  }
  return [];
}

export function saveCaptureQueue(queue: SurgeCaptureItem[]) {
  try {
    const maxWatch = Number(process.env.LIVE_SURGE_CAPTURE_MAX_WATCH ?? 12);
    if (queue.length > maxWatch) {
      queue.sort((a, b) => {
        if (b.capture_score !== a.capture_score) return b.capture_score - a.capture_score;
        return new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime();
      });
      const truncated = queue.slice(0, maxWatch);
      queue.length = 0;
      queue.push(...truncated);
    }

    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(queue, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save surge capture queue", e);
  }
}

export function evaluateSurgeCaptureCandidate(input: {
  market: string;
  currentPrice: number;
  payload: any;
  candles1: any[];
  candles5: any[];
  marketState: any;
  tickLease: string;
  sourceKind: string;
}): {
  pass: boolean;
  score: number;
  grade: "LOW" | "MID" | "HIGH";
  volumeAccel: number;
  nearHighPct: number;
  rejectRisks: string[];
} {
  let score = 0;
  const rejectRisks: string[] = [];

  const volRatio = Number(input.payload.volume_ratio ?? input.payload.volume_multiple ?? 0);
  let volumeAccel = volRatio; // Fallback
  
  if (input.candles1 && input.candles1.length >= 7) {
    const last = input.candles1[input.candles1.length - 1];
    const prev5 = input.candles1.slice(-6, -1);
    const lastNotional = Number(last.trade_price ?? 0) * Number(last.candle_acc_trade_volume ?? 0);
    const prevAvg = prev5.reduce((acc: number, c: any) => acc + (Number(c.trade_price ?? 0) * Number(c.candle_acc_trade_volume ?? 0)), 0) / Math.max(1, prev5.length);
    if (prevAvg > 0) {
      volumeAccel = lastNotional / prevAvg;
    }
  }

  // A. 거래량 가속도
  if (volumeAccel >= 3.0) {
    score += 45;
  } else if (volumeAccel >= 2.2) {
    score += 35;
  } else if (volumeAccel >= 1.6) {
    score += 25;
  }

  // B. 고점 근접도
  let nearHighPct = 0;
  let recentHigh = input.currentPrice;
  if (input.candles5.length > 0) {
    const lookback = input.candles5.slice(-6); // 30 mins
    recentHigh = Math.max(...lookback.map((c: any) => c.high_price));
    if (recentHigh > 0) {
      nearHighPct = ((input.currentPrice - recentHigh) / recentHigh) * 100;
    }
  }

  if (nearHighPct >= 0) {
    score += 35; // 이미 돌파
  } else if (nearHighPct >= -0.6) {
    score += 30;
  } else if (nearHighPct >= -1.2) {
    score += 20;
  }

  const lastCandle = input.candles5[input.candles5.length - 1];
  if (lastCandle) {
    const bodyLength = Math.abs(lastCandle.trade_price - lastCandle.opening_price);
    const upperWick = lastCandle.high_price - Math.max(lastCandle.trade_price, lastCandle.opening_price);
    const totalLength = lastCandle.high_price - lastCandle.low_price;
    if (totalLength > 0 && upperWick / totalLength > 0.58) {
      score -= 15;
      rejectRisks.push("long_upper_wick");
    }
  }

  // C. 가격 유지력
  if (lastCandle) {
    const totalLength = lastCandle.high_price - lastCandle.low_price;
    if (totalLength > 0) {
      const closeFromBottom = lastCandle.trade_price - lastCandle.low_price;
      if (closeFromBottom / totalLength >= 0.6) {
        score += 20;
      }
    }
  }
  // Simplified EMA checks using payload if available
  if (input.payload.close_above_ema5) {
    score += 15;
  }

  // D. 상대강도
  const rs = Number(input.payload.relative_strength ?? 0);
  if (input.marketState.btc_5m_trend !== "up" && input.payload.rise_3m_pct > 0) {
    score += 20;
  }
  if (rs > 0) {
    score += 15;
  }
  if (Number(input.payload.rsi ?? 0) > 55) {
    score += 10;
  }

  // E. 구조
  if (input.payload.breakout) {
    score += 25;
  }
  if (input.payload.close_upper_hold) {
    score += 20;
  }
  if (input.payload.would_pass_with_pullback_relaxed) {
    score += 15;
  }

  // F. 위험 감점
  if (input.payload.volumeState === "faded") {
    score = 0;
    rejectRisks.push("volume_faded");
  }
  if (input.marketState.btc_5m_trend === "down" && input.marketState.btc_15m_trend === "down") {
    rejectRisks.push("btc_double_down");
  }

  const minScore = Number(process.env.LIVE_SURGE_CAPTURE_MIN_SCORE ?? 55);
  const highScore = Number(process.env.LIVE_SURGE_CAPTURE_HIGH_SCORE ?? 75);

  let grade: "LOW" | "MID" | "HIGH" = "LOW";
  if (score >= highScore) grade = "HIGH";
  else if (score >= minScore) grade = "MID";

  return {
    pass: score >= minScore,
    score,
    grade,
    volumeAccel,
    nearHighPct,
    rejectRisks,
  };
}

export function processSurgeCaptureQueue(
  queue: SurgeCaptureItem[],
  currentTickTs: number,
  marketMap: Map<string, any>,
  currentTickLease: number
): {
  promoted: SurgeCaptureItem[];
  watchingCount: number;
  expiredCount: number;
  rejectedCount: number;
} {
  const promoted: SurgeCaptureItem[] = [];
  let expiredCount = 0;
  let rejectedCount = 0;
  let watchingCount = 0;

  for (const item of queue) {
    if (item.status !== "WATCHING" && item.status !== "RECLAIM_WAIT") continue;

    const marketData = marketMap.get(item.market);
    if (!marketData) continue;
    
    if (item.status === "RECLAIM_WAIT") {
        item.reclaim_attempt_count = (item.reclaim_attempt_count || 0) + 1;
        const maxReclaimTicks = 5;
        const currentPrice = marketData.currentPrice;
        const referenceHigh = item.reference_high_price || item.high_price_reference;
        const reclaimBase = item.reclaim_base_price || item.last_price;
        const pullbackFromHighPct = ((currentPrice - referenceHigh) / referenceHigh) * 100;
        
        if (item.reclaim_attempt_count > maxReclaimTicks) {
            item.status = "REJECTED";
            item.reject_risks.push("reclaim_timeout");
            rejectedCount++;
            continue;
        }

        if (pullbackFromHighPct <= -2.2 || marketData.volumeState === "faded" || marketData.btcCrashGuard) {
            item.status = "REJECTED";
            item.reject_risks.push(pullbackFromHighPct <= -2.2 ? "reclaim_pullback_too_deep" : "faded_or_crash");
            rejectedCount++;
            continue;
        }

        // FAST_SURGE_PROBE_RECLAIM condition
        const inPullbackZone = pullbackFromHighPct >= -1.8 && pullbackFromHighPct <= -0.4;
        const aboveEma1m = currentPrice > (marketData.ema1m || 0);
        const aboveReclaimBase = currentPrice > reclaimBase;
        const volumeAccelMaintained = (marketData.volume_accel_1m || 0) >= 1.0;
        const upperWickSafe = (marketData.upper_wick_ratio_1m || 0) < 0.45;
        const btcSafe = item.btc_5m_trend !== "down";
        const notCrazyTop = currentPrice <= referenceHigh * 1.005; 

        // If the price is rocketing with no pullback and huge wick, reject early
        if (pullbackFromHighPct > 0.5 && upperWickSafe === false) {
             item.status = "REJECTED";
             item.reject_risks.push("reclaim_wick_rejection");
             rejectedCount++;
             continue;
        }

        if (inPullbackZone && aboveEma1m && aboveReclaimBase && volumeAccelMaintained && upperWickSafe && btcSafe && notCrazyTop) {
            let isConfirmed = false;
            const volumeAccelStrong = (marketData.volume_accel_1m || 0) >= 2.0;
            const breakoutOrHold = item.breakout || item.close_upper_hold;
            const relativeStrengthOk = item.relative_strength > 0;
            const btc15mSafe = item.btc_15m_trend !== "down";

            if (breakoutOrHold && volumeAccelStrong && relativeStrengthOk && btc15mSafe) {
                isConfirmed = true;
            }

            item.status = "PROMOTED";
            item.capture_grade = isConfirmed ? "HIGH" : "MID";
            promoted.push(item);

            console.info(JSON.stringify({
                tag: "SURGE_RECLAIM_PROMOTED_PROOF",
                ts: new Date().toISOString(),
                market: item.market,
                promoted_to: isConfirmed ? "CONFIRMED_SURGE_ENTRY_RECLAIM" : "FAST_SURGE_PROBE_RECLAIM",
                pullback_pct: pullbackFromHighPct,
                volume_accel: marketData.volume_accel_1m,
                chase_reasons_cleared: item.chase_block_reasons,
                tick_lease: currentTickLease
            }));
        } else {
             watchingCount++;
             console.info(JSON.stringify({
                 tag: "SURGE_RECLAIM_WATCH_UPDATED_PROOF",
                 ts: new Date().toISOString(),
                 market: item.market,
                 attempt: item.reclaim_attempt_count,
                 pullback_pct: pullbackFromHighPct,
                 status: "RECLAIM_WAIT"
             }));
        }
        continue;
    }
    if (!marketData) continue;

    const currentPrice = marketData.currentPrice;
    const itemLease = Number(item.tick_lease);
    const maxTicks = Number(process.env.LIVE_SURGE_CAPTURE_TTL_TICKS ?? 3);

    if (currentTickLease - itemLease >= maxTicks) {
      item.status = "EXPIRED";
      expiredCount++;
      continue;
    }

    const priceChangePct = ((currentPrice - item.last_price) / item.last_price) * 100;

    // Check Rejection Criteria
    if (priceChangePct <= -1.2 || marketData.volumeState === "faded" || marketData.btcCrashGuard) {
      item.status = "REJECTED";
      const rejectReason = priceChangePct <= -1.2 ? "price_drop_1.2pct" : "faded_or_crash";
      item.reject_risks.push(rejectReason);
      rejectedCount++;
      console.info(JSON.stringify({
        tag: "SURGE_CAPTURE_REJECTED_PROOF",
        ts: new Date().toISOString(),
        market: item.market,
        reason: rejectReason,
        capture_score: item.capture_score,
        reject_reasons: item.reject_risks,
        age_ticks: currentTickLease - itemLease,
        price_change_from_watch_pct: priceChangePct,
        tick_lease: currentTickLease
      }));
      continue;
    }

    // Check Promotion Criteria
    item.confirm_count++;

    let isFastProbe = false;
    let isConfirmed = false;

    // FAST_SURGE_PROBE conditions
    let fastCond = 0;
    if (item.capture_score >= 55) fastCond++;
    if (item.volume_accel_1m >= 1.6) fastCond++;
    if (priceChangePct >= -0.8) fastCond++;
    if (currentPrice > item.high_price_reference * 0.99) fastCond++; // near high
    if (item.breakout || item.close_upper_hold) fastCond++;
    if (item.relative_strength > 0) fastCond++;
    if (item.btc_5m_trend !== "down") fastCond++;

    if (fastCond >= 3) {
      isFastProbe = true;
    }

    // CONFIRMED_SURGE_ENTRY conditions
    let confCond = 0;
    if (item.capture_score >= 75) confCond++;
    if (item.volume_accel_1m >= 2.2) confCond++;
    if (item.breakout || item.close_upper_hold) confCond++;
    if (item.btc_5m_trend === "up" || item.btc_15m_trend !== "down") confCond++;
    if (!item.reject_risks.includes("long_upper_wick")) confCond++;
    
    if (confCond >= 4) {
      isConfirmed = true;
    }

    if (isConfirmed || isFastProbe) {
      item.status = "PROMOTED";
      item.capture_grade = isConfirmed ? "HIGH" : "MID";
      promoted.push(item);
      const promotionReasons = [];
      if (isConfirmed) promotionReasons.push("confirmed_conditions_met");
      if (isFastProbe) promotionReasons.push("fast_probe_conditions_met");
      const promotedToMode = isConfirmed ? "CONFIRMED_SURGE_ENTRY" : "FAST_SURGE_PROBE";
      console.info(JSON.stringify({
        tag: "SURGE_CAPTURE_PROMOTED_PROOF",
        ts: new Date().toISOString(),
        market: item.market,
        promoted_to: promotedToMode,
        capture_score: item.capture_score,
        confirm_count: item.confirm_count,
        promotion_reasons: promotionReasons,
        selected_size_multiplier: isConfirmed ? 1.0 : 0.5,
        tick_lease: currentTickLease
      }));
    } else {
      watchingCount++;
      console.info(JSON.stringify({
        tag: "SURGE_CAPTURE_WATCH_UPDATED_PROOF",
        ts: new Date().toISOString(),
        market: item.market,
        previous_score: item.capture_score,
        current_score: item.capture_score,
        confirm_count: item.confirm_count,
        last_price: currentPrice,
        price_change_from_watch_pct: priceChangePct,
        volume_accel_1m: item.volume_accel_1m,
        status: "WATCHING",
        tick_lease: currentTickLease
      }));
    }
  }

  return { promoted, watchingCount, expiredCount, rejectedCount };
}
