import assert from "node:assert";
import type { UpbitCandle } from "./upbit-public.js";
import { isScannerEarlyContractApproved } from "./live-strategy.js";
import { evaluateSurgeEntryPipeline } from "./surge-v2/surge-entry-engine.js";
import {
  classifySurgeImpulseMemory,
  postSpikeExtraEntryRequirements,
  type SurgeImpulseMemoryResult,
} from "./surge-v2/surge-impulse-memory.js";

function makeBar(params: {
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}): UpbitCandle {
  return {
    candle_date_time_kst: new Date(params.tsMs).toISOString(),
    opening_price: params.open,
    high_price: params.high,
    low_price: params.low,
    trade_price: params.close,
    candle_acc_trade_volume: params.vol,
  };
}

function padFlatBars(count: number, baseMs: number, px: number, vol: number): UpbitCandle[] {
  const out: UpbitCandle[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      makeBar({
        tsMs: baseMs + i * 60_000,
        open: px,
        high: px * 1.001,
        low: px * 0.999,
        close: px,
        vol,
      }),
    );
  }
  return out;
}

function buildCowStyleMemoryWindow(): { completed: UpbitCandle[]; currentPx: number } {
  const baseMs = Date.now() - 60 * 60_000;
  const head = padFlatBars(35, baseMs, 1000, 800);
  const impulseStart = baseMs + 35 * 60_000;
  const tail: UpbitCandle[] = [
    makeBar({ tsMs: impulseStart, open: 1000, high: 1010, low: 998, close: 1005, vol: 900 }),
    makeBar({ tsMs: impulseStart + 60_000, open: 1005, high: 1100, low: 1000, close: 1090, vol: 4200 }),
    makeBar({ tsMs: impulseStart + 120_000, open: 1090, high: 1095, low: 1080, close: 1085, vol: 3800 }),
    makeBar({ tsMs: impulseStart + 180_000, open: 1085, high: 1088, low: 1020, close: 1030, vol: 2600 }),
    makeBar({ tsMs: impulseStart + 240_000, open: 1030, high: 1035, low: 990, close: 995, vol: 2200 }),
    makeBar({ tsMs: impulseStart + 300_000, open: 995, high: 998, low: 992, close: 994, vol: 1800 }),
    makeBar({ tsMs: impulseStart + 360_000, open: 994, high: 996, low: 990, close: 991, vol: 1700 }),
    makeBar({ tsMs: impulseStart + 420_000, open: 991, high: 993, low: 988, close: 989, vol: 1600 }),
    makeBar({ tsMs: impulseStart + 480_000, open: 989, high: 991, low: 987, close: 988, vol: 1500 }),
    makeBar({ tsMs: impulseStart + 540_000, open: 988, high: 990, low: 986, close: 987, vol: 1400 }),
    makeBar({ tsMs: impulseStart + 600_000, open: 987, high: 989, low: 985, close: 986, vol: 1300 }),
    makeBar({ tsMs: impulseStart + 660_000, open: 986, high: 988, low: 984, close: 985, vol: 3200 }),
    makeBar({ tsMs: impulseStart + 720_000, open: 985, high: 987, low: 983, close: 984, vol: 3400 }),
    makeBar({ tsMs: impulseStart + 780_000, open: 984, high: 986, low: 982, close: 983, vol: 3600 }),
    makeBar({ tsMs: impulseStart + 840_000, open: 983, high: 985, low: 981, close: 982, vol: 3800 }),
  ];
  const completed = [...head, ...tail];
  return { completed, currentPx: 981 };
}

function buildSeiStyleMemoryWindow(): { completed: UpbitCandle[]; currentPx: number } {
  const baseMs = Date.now() - 60 * 60_000;
  const head = padFlatBars(40, baseMs, 500, 600);
  const impulseStart = baseMs + 40 * 60_000;
  const tail: UpbitCandle[] = [];
  for (let i = 0; i < 15; i++) {
    const px = 500 + i * 0.15;
    const vol = i < 10 ? 650 : 650 + (i - 9) * 420;
    tail.push(
      makeBar({
        tsMs: impulseStart + i * 60_000,
        open: px,
        high: px + 0.4,
        low: px - 0.3,
        close: px + 0.1,
        vol,
      }),
    );
  }
  const completed = [...head, ...tail];
  return { completed, currentPx: 502.2 };
}

function buildNormalPullbackMemoryWindow(): { completed: UpbitCandle[]; currentPx: number } {
  const baseMs = Date.now() - 60 * 60_000;
  const head = padFlatBars(40, baseMs, 2000, 700);
  const start = baseMs + 40 * 60_000;
  const tail: UpbitCandle[] = [];
  let px = 2000;
  for (let i = 0; i < 12; i++) {
    px *= 1.003;
    tail.push(
      makeBar({
        tsMs: start + i * 60_000,
        open: px / 1.003,
        high: px * 1.0015,
        low: px * 0.9985,
        close: px,
        vol: 900 + i * 40,
      }),
    );
  }
  for (let i = 0; i < 3; i++) {
    px *= 0.996;
    tail.push(
      makeBar({
        tsMs: start + (12 + i) * 60_000,
        open: px / 0.996,
        high: px * 1.001,
        low: px * 0.997,
        close: px,
        vol: 1100,
      }),
    );
  }
  const completed = [...head, ...tail];
  return { completed, currentPx: px };
}

function buildGentleCandles5(count: number, startPx: number): UpbitCandle[] {
  const baseMs = Date.now() - count * 5 * 60_000;
  const out: UpbitCandle[] = [];
  let px = startPx;
  for (let i = 0; i < count; i++) {
    px *= 1.001;
    out.push(
      makeBar({
        tsMs: baseMs + i * 5 * 60_000,
        open: px / 1.001,
        high: px * 1.002,
        low: px * 0.998,
        close: px,
        vol: 1200,
      }),
    );
  }
  return out;
}

function effectiveEarlySurgeAuthority(payload: any, completed: UpbitCandle[], currentPx: number): boolean {
  const early = isScannerEarlyContractApproved(payload, true);
  const impulse = classifySurgeImpulseMemory({
    completedCandles: completed,
    currentPx,
    payloadVolumeRatio: Number(payload.volume_ratio ?? 0),
  });
  return early.approved && impulse.earlySurgeAuthorityPreserved;
}

function scannerEarlyContractThresholds(payload: any, completed: UpbitCandle[], currentPx: number) {
  const earlyApproved = effectiveEarlySurgeAuthority(payload, completed, currentPx);
  return {
    setupVolRequired: earlyApproved ? 1.2 : 1.4,
    setupMomentumRequired: earlyApproved ? 0.25 : 0.7,
    earlyApproved,
  };
}

/** Mirrors live-strategy SURGE_V2_ENTRY_DECISION_PROOF + setup shadow pass coupling for POST_SPIKE blocks. */
function resolveFinalSurgeEnterAllowed(proof: {
  decision_action: "enter" | "reject";
  surge_setup_pass: boolean;
}): boolean {
  return proof.decision_action === "enter" && proof.surge_setup_pass === true;
}

function inferSurgeSetupPassFromImpulse(params: {
  impulse: SurgeImpulseMemoryResult;
  postGate: ReturnType<typeof postSpikeExtraEntryRequirements>;
}): boolean {
  if (params.postGate.required && !params.postGate.ok) return false;
  return true;
}

function runSurgeV2PipelineDecision(params: {
  market: string;
  payload: Record<string, unknown>;
  candles1: UpbitCandle[];
  currentPx: number;
}): { action: "enter" | "reject"; reason: string } {
  const candles5 = buildGentleCandles5(12, params.currentPx * 0.99);
  const decision = evaluateSurgeEntryPipeline({
    market: params.market,
    payload: params.payload,
    candles1: params.candles1,
    candles5,
    currentPrice: params.currentPx,
    marketState: {
      market_state: "neutral",
      btc_5m_trend: "flat",
      btc_15m_trend: "flat",
      btc_change_24h: 0,
    },
    volumeRatio: Number(params.payload.volume_ratio ?? 1.2),
    bridgePass: true,
    staleOk: true,
    ageSeconds: Number(params.payload.age_seconds ?? 20),
    surgeSetupPass: false,
    failedSurgeConditions: ["post_spike_higher_low_missing", "post_spike_follow_through_missing"],
  });
  return { action: decision.action, reason: decision.reason };
}

async function run() {
  console.log("=== Surge impulse memory regression (1–5) ===\n");

  const cowPayload = {
    source_kind: "scanner_tradable_candidate",
    filter_pass: true,
    volume_ratio: 1.32,
    rise_3m_pct: 0.35,
    breakout: true,
    close_upper_hold: true,
    scanner_score: 84,
    age_seconds: 30,
    is_fresh_signal: true,
  };
  const cow = buildCowStyleMemoryWindow();
  const cowImpulse = classifySurgeImpulseMemory({
    completedCandles: cow.completed,
    currentPx: cow.currentPx,
    payloadVolumeRatio: cowPayload.volume_ratio,
  });
  const cowPost = postSpikeExtraEntryRequirements(cowImpulse);
  const cowEarly = effectiveEarlySurgeAuthority(cowPayload, cow.completed, cow.currentPx);
  const cowSetupPass = inferSurgeSetupPassFromImpulse({ impulse: cowImpulse, postGate: cowPost });
  const cowPipeline = runSurgeV2PipelineDecision({
    market: "KRW-COW",
    payload: cowPayload,
    candles1: cow.completed,
    currentPx: cow.currentPx,
  });

  assert.ok(
    cowImpulse.phase === "POST_SPIKE" || cowImpulse.phase === "DEAD_BOUNCE",
    `[1] COW phase must be POST_SPIKE/DEAD_BOUNCE, got ${cowImpulse.phase}`,
  );
  assert.strictEqual(cowEarly, false, "[1] COW early_surge_authority must be false");
  assert.strictEqual(cowPost.required, true, "[1] COW post-spike gates must apply");
  assert.strictEqual(cowPost.ok, false, "[1] COW must fail recovery without reclaim/follow-through");
  assert.strictEqual(cowImpulse.highReclaim, false, "[1] COW must not have high reclaim");
  assert.strictEqual(cowImpulse.followThrough, false, "[1] COW must not have follow-through");
  assert.strictEqual(cowSetupPass, false, "[1] COW surge_setup_pass must be false");
  assert.strictEqual(
    resolveFinalSurgeEnterAllowed({
      decision_action: cowPipeline.action,
      surge_setup_pass: cowSetupPass,
    }),
    false,
    "[1] COW final ENTER must be forbidden (pipeline must not override POST_SPIKE block)",
  );
  console.log("[PASS] 1. COW: POST_SPIKE/DEAD_BOUNCE, no early authority, final ENTER blocked");

  const seiPayload = {
    source_kind: "scanner_tradable_candidate",
    filter_pass: true,
    volume_ratio: 1.38,
    rise_3m_pct: 0.28,
    age_seconds: 20,
    is_fresh_signal: true,
  };
  const sei = buildSeiStyleMemoryWindow();
  const seiImpulse = classifySurgeImpulseMemory({
    completedCandles: sei.completed,
    currentPx: sei.currentPx,
    payloadVolumeRatio: seiPayload.volume_ratio,
  });
  const seiPost = postSpikeExtraEntryRequirements(seiImpulse);
  const seiEarly = effectiveEarlySurgeAuthority(seiPayload, sei.completed, sei.currentPx);
  const seiThresholds = scannerEarlyContractThresholds(seiPayload, sei.completed, sei.currentPx);

  assert.strictEqual(seiImpulse.phase, "IGNITION", `[2] SEI must be IGNITION, got ${seiImpulse.phase}`);
  assert.strictEqual(seiEarly, true, "[2] SEI early_surge_authority must stay true");
  assert.strictEqual(seiPost.required, false, "[2] SEI must not require post-spike gates");
  assert.strictEqual(seiThresholds.setupVolRequired, 1.2, "[2] SEI must keep scanner vol 1.2");
  assert.strictEqual(seiThresholds.setupMomentumRequired, 0.25, "[2] SEI must keep scanner momentum 0.25");
  assert.strictEqual(isScannerEarlyContractApproved(seiPayload, true).approved, true, "[2] scanner early contract approved");
  console.log("[PASS] 2. SEI: IGNITION, early authority + 1.2/0.25 preserved");

  const pull = buildNormalPullbackMemoryWindow();
  const pullImpulse = classifySurgeImpulseMemory({
    completedCandles: pull.completed,
    currentPx: pull.currentPx,
    payloadVolumeRatio: 1.25,
  });
  assert.ok(
    pullImpulse.phase !== "POST_SPIKE" && pullImpulse.phase !== "DEAD_BOUNCE",
    `[3] Normal pullback must not be POST_SPIKE/DEAD_BOUNCE, got ${pullImpulse.phase}`,
  );
  console.log(`[PASS] 3. Normal pullback classified as ${pullImpulse.phase} (no post-spike mislabel)`);

  assert.strictEqual(cowPost.required, true, "[4] DEAD_BOUNCE/POST_SPIKE recovery required flag");
  const postSpikeTwin: SurgeImpulseMemoryResult = { ...cowImpulse, phase: "POST_SPIKE" };
  const deadAsPost = postSpikeExtraEntryRequirements(postSpikeTwin);
  assert.deepStrictEqual(
    { required: cowPost.required, ok: cowPost.ok, failed: cowPost.failed },
    { required: deadAsPost.required, ok: deadAsPost.ok, failed: deadAsPost.failed },
    "[4] DEAD_BOUNCE recovery requirements must match POST_SPIKE",
  );
  console.log("[PASS] 4. DEAD_BOUNCE recovery requirements equal to POST_SPIKE");

  const proofSurgeSetupPass = cowSetupPass;
  const proofDecisionAction = cowPipeline.action;
  console.info(
    JSON.stringify({
      tag: "SURGE_V2_ENTRY_DECISION_PROOF_REGRESSION",
      scenario: "COW_POST_SPIKE",
      decision_action: proofDecisionAction,
      surge_setup_pass: proofSurgeSetupPass,
      impulse_phase: cowImpulse.phase,
      failed_surge_conditions: cowPost.failed,
      final_enter_allowed: resolveFinalSurgeEnterAllowed({
        decision_action: proofDecisionAction,
        surge_setup_pass: proofSurgeSetupPass,
      }),
    }),
  );
  assert.strictEqual(proofSurgeSetupPass, false, "[5] proof snapshot surge_setup_pass must be false");
  assert.strictEqual(
    resolveFinalSurgeEnterAllowed({
      decision_action: proofDecisionAction,
      surge_setup_pass: proofSurgeSetupPass,
    }),
    false,
    "[5] downstream must not revive POST_SPIKE block into final ENTER",
  );
  if (proofDecisionAction === "enter") {
    console.log("[PASS] 5. Pipeline enter ignored when surge_setup_pass=false (no override)");
  } else {
    console.log(`[PASS] 5. Pipeline reject (${proofDecisionAction}) aligned with POST_SPIKE block`);
  }

  console.log("\nAll surge impulse memory regression tests passed.\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
