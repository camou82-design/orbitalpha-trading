import type { Engine2EvalInput, Engine2SurgeCandidate } from "./types.js";

function avg(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function toScore(params: {
  volumeMultiple: number;
  breakout: boolean;
  closeUpperHold: boolean;
  rise3mPct: number;
}) {
  const scoreVol = clamp((params.volumeMultiple - 1) * 18, 0, 45);
  const scoreBreakout = params.breakout ? 30 : 0;
  const scoreClose = params.closeUpperHold ? 16 : 4;
  const scoreRise3 = clamp((params.rise3mPct - 0.5) * 1.1, 0, 25);
  return clamp(scoreVol + scoreBreakout + scoreClose + scoreRise3, 0, 100);
}

export function evaluateEngine2SurgeCandidate(
  input: Engine2EvalInput,
  nowIso = new Date().toISOString(),
): Engine2SurgeCandidate | null {
  const c1 = input.candles1m;
  const last = c1[c1.length - 1];
  if (!last) return null;
  const prev20 = c1.slice(-21, -1);
  if (prev20.length < 20) return null;

  const vNow = last.candle_acc_trade_volume * last.trade_price;
  const vAvg = avg(prev20.map((c) => c.candle_acc_trade_volume * c.trade_price));
  const volumeMultiple = vAvg > 0 ? vNow / vAvg : 0;
  const high20 = Math.max(...prev20.map((c) => c.high_price));
  const breakout = last.trade_price >= high20;
  const range = Math.max(1e-9, last.high_price - last.low_price);
  const closeTopRatio = (last.trade_price - last.low_price) / range;
  const closeUpperHold = closeTopRatio >= 0.65;
  const recent3 = c1.slice(-3);
  const rise3mPct = recent3.length >= 3 ? (recent3[2]!.trade_price / recent3[0]!.trade_price - 1) * 100 : 0;
  const score = toScore({ volumeMultiple, breakout, closeUpperHold, rise3mPct });

  return {
    market: input.market,
    scanner_score: Number(score.toFixed(1)),
    volume_multiple: Number(volumeMultiple.toFixed(3)),
    breakout,
    close_upper_hold: closeUpperHold,
    rise_3m_pct: Number(rise3mPct.toFixed(3)),
    signal_ts: nowIso,
    updated_at: nowIso,
    source_kind: "engine2_surge_scanner",
  };
}

