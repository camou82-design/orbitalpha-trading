import type { UpbitCandle } from "../upbit-public.js";

export type SurgeImpulsePhase =
  | "IGNITION"
  | "EXPANSION"
  | "CONTINUATION"
  | "POST_SPIKE"
  | "DEAD_BOUNCE";

export type SurgeImpulseMemoryResult = {
  phase: SurgeImpulsePhase;
  windowBars: number;
  priorSpike: boolean;
  spikeHigh: number;
  spikeBarIndex: number;
  spikeAmplitudePct: number;
  spikeDurationBars: number;
  drawdownFromSpikeHighPct: number;
  volumeAcceleration: number;
  postSpikeVolumeDecay: number;
  highReclaim: boolean;
  higherLow: boolean;
  followThrough: boolean;
  postSpikeRecoveryOk: boolean;
  earlySurgeAuthorityPreserved: boolean;
};

const DEFAULT_WINDOW = 15;
const MIN_SPIKE_AMPLITUDE_PCT = 2.0;
const POST_SPIKE_DRAWDOWN_PCT = 5.0;
const STRONG_VOLUME_ACCEL = 1.35;
const IGNITION_MAX_RISE_5M_PCT = 1.2;

function barVolume(c: UpbitCandle): number {
  return Number(c.candle_acc_trade_volume ?? 0);
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function classifySurgeImpulseMemory(params: {
  completedCandles: UpbitCandle[];
  currentPx: number;
  windowBars?: number;
  payloadVolumeRatio?: number;
}): SurgeImpulseMemoryResult {
  const windowBars = params.windowBars ?? DEFAULT_WINDOW;
  const completed = params.completedCandles;
  const n = completed.length;
  const empty: SurgeImpulseMemoryResult = {
    phase: "EXPANSION",
    windowBars,
    priorSpike: false,
    spikeHigh: params.currentPx,
    spikeBarIndex: -1,
    spikeAmplitudePct: 0,
    spikeDurationBars: 0,
    drawdownFromSpikeHighPct: 0,
    volumeAcceleration: 1,
    postSpikeVolumeDecay: 1,
    highReclaim: false,
    higherLow: false,
    followThrough: false,
    postSpikeRecoveryOk: false,
    earlySurgeAuthorityPreserved: true,
  };
  if (n < windowBars) return empty;

  const slice = completed.slice(-windowBars);
  const highs = slice.map((c) => Number(c.high_price));
  const lows = slice.map((c) => Number(c.low_price));
  const closes = slice.map((c) => Number(c.trade_price));
  const vols = slice.map(barVolume);
  const opens = slice.map((c) => Number(c.opening_price));

  let spikeBarIndex = 0;
  let spikeHigh = highs[0]!;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i]! > spikeHigh) {
      spikeHigh = highs[i]!;
      spikeBarIndex = i;
    }
  }

  const baseIdx = Math.max(0, spikeBarIndex - 2);
  const baseLow = Math.min(...lows.slice(baseIdx, spikeBarIndex + 1));
  const spikeAmplitudePct = baseLow > 0 ? ((spikeHigh - baseLow) / baseLow) * 100 : 0;

  let spikeDurationBars = 1;
  for (let j = spikeBarIndex - 1; j >= 0; j--) {
    const rise = closes[spikeBarIndex]! - closes[j]!;
    if (rise > 0 && (closes[j]! > 0 ? (rise / closes[j]!) * 100 : 0) >= 0.4) {
      spikeDurationBars += 1;
    } else break;
  }

  const barsSinceSpike = slice.length - 1 - spikeBarIndex;
  const priorSpike =
    spikeAmplitudePct >= MIN_SPIKE_AMPLITUDE_PCT &&
    spikeBarIndex <= slice.length - 3 &&
    barsSinceSpike >= 2;

  const drawdownFromSpikeHighPct =
    spikeHigh > 0 ? ((spikeHigh - params.currentPx) / spikeHigh) * 100 : 0;
  const highReclaim = params.currentPx >= spikeHigh * 0.9985;

  const recentVol = avg(vols.slice(-2));
  const baselineVol = avg(vols.slice(2, Math.max(3, slice.length - 2)));
  const payloadVol = Number(params.payloadVolumeRatio ?? 0);
  const volumeAcceleration =
    baselineVol > 0
      ? Math.max(recentVol / baselineVol, payloadVol > 0 ? payloadVol : 0)
      : payloadVol > 0
        ? payloadVol
        : 1;

  const spikeVolWindow = vols.slice(Math.max(0, spikeBarIndex - 1), spikeBarIndex + 2);
  const postSpikeVols =
    spikeBarIndex + 1 < vols.length ? vols.slice(spikeBarIndex + 1) : [];
  const postSpikeVolumeDecay =
    avg(spikeVolWindow) > 0 && postSpikeVols.length > 0
      ? avg(postSpikeVols.slice(0, Math.min(4, postSpikeVols.length))) / avg(spikeVolWindow)
      : 1;

  const postSpikeLow =
    spikeBarIndex + 1 < lows.length
      ? Math.min(...lows.slice(spikeBarIndex + 1))
      : lows[lows.length - 1]!;
  const recentLow = Math.min(...lows.slice(-3));
  const higherLow = recentLow > postSpikeLow * 1.0015;

  const lastClose = closes[closes.length - 1]!;
  const prevClose = closes.length >= 2 ? closes[closes.length - 2]! : lastClose;
  const lastOpen = opens[opens.length - 1]!;
  const followThrough =
    (params.currentPx >= lastClose && lastClose > prevClose) ||
    (lastClose > lastOpen && params.currentPx >= lastClose * 0.999);

  const postSpikeRecoveryOk = highReclaim || (higherLow && followThrough);

  const rise5mPct =
    closes.length >= 6 && closes[closes.length - 6]! > 0
      ? ((params.currentPx - closes[closes.length - 6]!) / closes[closes.length - 6]!) * 100
      : 0;

  let phase: SurgeImpulsePhase = "EXPANSION";
  if (priorSpike && drawdownFromSpikeHighPct >= POST_SPIKE_DRAWDOWN_PCT && !highReclaim) {
    if (
      !postSpikeRecoveryOk &&
      volumeAcceleration >= STRONG_VOLUME_ACCEL &&
      postSpikeVolumeDecay >= 0.85
    ) {
      phase = "DEAD_BOUNCE";
    } else {
      phase = "POST_SPIKE";
    }
  } else if (!priorSpike && volumeAcceleration >= STRONG_VOLUME_ACCEL && rise5mPct <= IGNITION_MAX_RISE_5M_PCT) {
    phase = "IGNITION";
  } else if (priorSpike && drawdownFromSpikeHighPct < POST_SPIKE_DRAWDOWN_PCT && params.currentPx >= spikeHigh * 0.985) {
    phase = "CONTINUATION";
  } else if (!priorSpike && rise5mPct > IGNITION_MAX_RISE_5M_PCT) {
    phase = "EXPANSION";
  } else if (priorSpike && drawdownFromSpikeHighPct >= POST_SPIKE_DRAWDOWN_PCT && highReclaim) {
    phase = "CONTINUATION";
  }

  const earlySurgeAuthorityPreserved = phase !== "POST_SPIKE" && phase !== "DEAD_BOUNCE";

  return {
    phase,
    windowBars,
    priorSpike,
    spikeHigh,
    spikeBarIndex,
    spikeAmplitudePct,
    spikeDurationBars,
    drawdownFromSpikeHighPct,
    volumeAcceleration,
    postSpikeVolumeDecay,
    highReclaim,
    higherLow,
    followThrough,
    postSpikeRecoveryOk,
    earlySurgeAuthorityPreserved,
  };
}

export function postSpikeExtraEntryRequirements(impulse: SurgeImpulseMemoryResult): {
  required: boolean;
  ok: boolean;
  failed: string[];
} {
  if (impulse.phase !== "POST_SPIKE" && impulse.phase !== "DEAD_BOUNCE") {
    return { required: false, ok: true, failed: [] };
  }
  const failed: string[] = [];
  if (!impulse.highReclaim && !impulse.higherLow) failed.push("post_spike_higher_low_missing");
  if (!impulse.highReclaim && !impulse.followThrough) failed.push("post_spike_follow_through_missing");
  if (!impulse.highReclaim && impulse.higherLow && impulse.followThrough) {
    return { required: true, ok: true, failed: [] };
  }
  if (impulse.highReclaim) {
    return { required: true, ok: true, failed: [] };
  }
  return { required: true, ok: false, failed };
}
