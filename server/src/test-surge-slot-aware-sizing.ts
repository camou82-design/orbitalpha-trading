import assert from "node:assert";
import { ORDER_LIMITS } from "@orbitalpha/shared";

interface PositionMock {
  engine_bucket?: string;
  market?: string;
  qty?: number;
  order_krw?: number;
}

interface StrategyStateMock {
  positions: Record<string, PositionMock>;
  early_positions: Record<string, PositionMock>;
}

function getEffectiveSurgeOpenCount(
  state: StrategyStateMock,
  acceptedSurgeMarketsThisTick: Set<string>,
): number {
  const canonicalCount =
    Object.values(state.positions).filter((p) => p.engine_bucket === "surge").length +
    Object.values(state.early_positions).filter((p) => p.engine_bucket === "surge").length;
  let pendingAcceptedNotInStateCount = 0;
  for (const mk of acceptedSurgeMarketsThisTick) {
    const inPos = state.positions[mk]?.engine_bucket === "surge";
    const inEarly = state.early_positions[mk]?.engine_bucket === "surge";
    if (!inPos && !inEarly) {
      pendingAcceptedNotInStateCount++;
    }
  }
  return canonicalCount + pendingAcceptedNotInStateCount;
}

function computeSurgeSlotBudget(params: {
  surgeCapAmount: number;
  currentSurgeInvestedKrw: number;
  sameTickAcceptedSurgeKrw: number;
  state: StrategyStateMock;
  acceptedSurgeMarketsThisTick: Set<string>;
  maxSurgePositions?: number;
}): {
  slotBaseOrderKrw: number;
  remainingSurgeCapital: number;
  remainingSlots: number;
} {
  const maxPositions = params.maxSurgePositions ?? 3;
  const currentInvestedTotal = params.currentSurgeInvestedKrw + params.sameTickAcceptedSurgeKrw;
  const remainingSurgeCapital = Math.max(0, params.surgeCapAmount - currentInvestedTotal);
  const openSurgePositionsCount = getEffectiveSurgeOpenCount(params.state, params.acceptedSurgeMarketsThisTick);
  const remainingSlots = Math.max(0, maxPositions - openSurgePositionsCount);

  let slotBaseOrderKrw = 0;
  if (remainingSlots > 0 && remainingSurgeCapital >= 5000) {
    slotBaseOrderKrw = Math.floor(remainingSurgeCapital / remainingSlots);
  }

  return {
    slotBaseOrderKrw,
    remainingSurgeCapital,
    remainingSlots,
  };
}

function simulateSurgeCandidateExecution(params: {
  market: string;
  state: StrategyStateMock;
  acceptedSurgeMarketsThisTick: Set<string>;
  surgeCapAmount: number;
  currentSurgeInvestedKrw: number;
  sameTickAcceptedSurgeKrw: number;
  remainingInTick: number;
  finalMultiplier?: number;
  isHighConfidence?: boolean;
  marketStateScale?: number;
  mockOutcome: "accepted" | "rejected" | "unknown_unresolved" | "unknown_resolved_by_identifier";
  delayStateRegistration?: boolean; // managed state 등록 지연 시뮬레이션
}): {
  allowed: boolean;
  orderKrw: number;
  blockReason: string | null;
  newRemainingInTick: number;
  newSameTickAccepted: number;
} {
  const SURGE_MAX_OPEN_POSITIONS = 3;
  const currentOpenCount = getEffectiveSurgeOpenCount(params.state, params.acceptedSurgeMarketsThisTick);

  // 1. Preorder Gate: Max Positions check using effective slot count
  if (currentOpenCount >= SURGE_MAX_OPEN_POSITIONS) {
    return {
      allowed: false,
      orderKrw: 0,
      blockReason: "surge_max_positions_reached",
      newRemainingInTick: params.remainingInTick,
      newSameTickAccepted: params.sameTickAcceptedSurgeKrw,
    };
  }

  // 2. Sizing calculation
  const budget = computeSurgeSlotBudget({
    surgeCapAmount: params.surgeCapAmount,
    currentSurgeInvestedKrw: params.currentSurgeInvestedKrw,
    sameTickAcceptedSurgeKrw: params.sameTickAcceptedSurgeKrw,
    state: params.state,
    acceptedSurgeMarketsThisTick: params.acceptedSurgeMarketsThisTick,
  });

  if (budget.remainingSlots === 0 || budget.slotBaseOrderKrw <= 0) {
    return {
      allowed: false,
      orderKrw: 0,
      blockReason: "surge_remaining_below_min_order",
      newRemainingInTick: params.remainingInTick,
      newSameTickAccepted: params.sameTickAcceptedSurgeKrw,
    };
  }

  let orderKrw = Math.floor(budget.slotBaseOrderKrw * (params.finalMultiplier ?? 1.0));
  if (params.isHighConfidence) {
    orderKrw = Math.max(orderKrw, Math.floor(budget.slotBaseOrderKrw * 1.15));
  }

  const liveMin = 50_000;
  const minOrder = Math.max(5000, Math.min(budget.slotBaseOrderKrw, liveMin));
  orderKrw = Math.max(minOrder, Math.min(250_000, orderKrw));

  const scale = params.marketStateScale ?? 1.0;
  if (scale < 1.0) {
    orderKrw = Math.max(5000, Math.floor(orderKrw * scale));
  }

  orderKrw = Math.min(orderKrw, ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET, params.remainingInTick, 250_000);

  if (orderKrw < 5000 || params.remainingInTick < 5000) {
    return {
      allowed: false,
      orderKrw: 0,
      blockReason: "order_krw_below_min",
      newRemainingInTick: params.remainingInTick,
      newSameTickAccepted: params.sameTickAcceptedSurgeKrw,
    };
  }

  // 3. Execution Outcome simulation
  if (params.mockOutcome === "accepted" || params.mockOutcome === "unknown_resolved_by_identifier") {
    // Reservation added immediately upon accepted
    params.acceptedSurgeMarketsThisTick.add(params.market);

    if (!params.delayStateRegistration) {
      // Immediate state registration
      params.state.positions[params.market] = {
        engine_bucket: "surge",
        market: params.market,
        order_krw: orderKrw,
      };
    }

    const newRemaining = Math.max(0, params.remainingInTick - orderKrw);
    const newAccepted = params.sameTickAcceptedSurgeKrw + orderKrw;
    return {
      allowed: true,
      orderKrw,
      blockReason: null,
      newRemainingInTick: newRemaining,
      newSameTickAccepted: newAccepted,
    };
  }

  // If rejected or unresolved unknown: NOT added to reservation Set, NOT deducted from tick cap
  return {
    allowed: false,
    orderKrw,
    blockReason: "order_failed",
    newRemainingInTick: params.remainingInTick,
    newSameTickAccepted: params.sameTickAcceptedSurgeKrw,
  };
}

async function runSurgeSlotLockSafetyTests() {
  console.log("=== Starting Surge Same-Tick Slot Lock & Reservation Regression Tests (A-K) ===\n");

  const surgeCap = 350_000;

  // --- Test A: 0 open + 4 eligible candidates -> accepted 최대 3 (Immediate Registration) ---
  console.log("--- Test A: 0 open + 4 eligible candidates -> accepted 최대 3개 (Immediate Registration) ---");
  const stateA: StrategyStateMock = { positions: {}, early_positions: {} };
  const acceptedSetA = new Set<string>();
  let remA = surgeCap;
  let accA = 0;
  const candidatesA = ["KRW-C1", "KRW-C2", "KRW-C3", "KRW-C4"];
  const outcomesA: boolean[] = [];

  for (const sym of candidatesA) {
    const res = simulateSurgeCandidateExecution({
      market: sym,
      state: stateA,
      acceptedSurgeMarketsThisTick: acceptedSetA,
      surgeCapAmount: surgeCap,
      currentSurgeInvestedKrw: 0,
      sameTickAcceptedSurgeKrw: accA,
      remainingInTick: remA,
      mockOutcome: "accepted",
      delayStateRegistration: false,
    });
    outcomesA.push(res.allowed);
    remA = res.newRemainingInTick;
    accA = res.newSameTickAccepted;
  }

  assert.deepStrictEqual(outcomesA, [true, true, true, false], "Exactly 3 orders accepted, 4th blocked");
  assert.strictEqual(getEffectiveSurgeOpenCount(stateA, acceptedSetA), 3, "Final surge count must be exactly 3");
  assert.strictEqual(accA, 350_000, "Total accepted across 3 orders must equal surgeCap 350,000");
  console.log(`[PASS] Test A: 4 후보 중 3개 accepted, 4번째 surge_max_positions_reached 차단 (acc=${accA}, rem=${remA})`);

  // --- Test B: 0 open + 4 eligible candidates -> accepted 최대 3 (DELAYED State Registration) ---
  console.log("\n--- Test B: 0 open + 4 eligible candidates -> accepted 최대 3개 (DELAYED State Registration) ---");
  const stateB: StrategyStateMock = { positions: {}, early_positions: {} };
  const acceptedSetB = new Set<string>();
  let remB = surgeCap;
  let accB = 0;
  const candidatesB = ["KRW-D1", "KRW-D2", "KRW-D3", "KRW-D4"];
  const outcomesB: boolean[] = [];

  for (const sym of candidatesB) {
    const res = simulateSurgeCandidateExecution({
      market: sym,
      state: stateB,
      acceptedSurgeMarketsThisTick: acceptedSetB,
      surgeCapAmount: surgeCap,
      currentSurgeInvestedKrw: 0,
      sameTickAcceptedSurgeKrw: accB,
      remainingInTick: remB,
      mockOutcome: "accepted",
      delayStateRegistration: true, // managed state 등록이 지연됨!
    });
    outcomesB.push(res.allowed);
    remB = res.newRemainingInTick;
    accB = res.newSameTickAccepted;
  }

  assert.deepStrictEqual(outcomesB, [true, true, true, false], "Exactly 3 orders accepted even when state registration is delayed");
  assert.strictEqual(getEffectiveSurgeOpenCount(stateB, acceptedSetB), 3, "Effective count must be exactly 3 via reservation Set");
  console.log(`[PASS] Test B: State 등록이 지연되더라도 Reservation Set에 의해 4번째 후보 정상 차단`);

  // --- Test C: Double count 방지 검증 (state 등록 전후 effective count 일치) ---
  console.log("\n--- Test C: Double count 방지 검증 (state 등록 전후 effective count 불변) ---");
  const stateC: StrategyStateMock = { positions: {}, early_positions: {} };
  const acceptedSetC = new Set<string>(["KRW-ZK"]);
  // 아직 state.positions에 미등록 상태
  assert.strictEqual(getEffectiveSurgeOpenCount(stateC, acceptedSetC), 1, "Pending set only -> count 1");
  // state.positions에 등록 완료
  stateC.positions["KRW-ZK"] = { engine_bucket: "surge", market: "KRW-ZK", order_krw: 110_000 };
  // state에도 있고 set에도 있지만 double count 없이 정확히 1이어야 함!
  assert.strictEqual(getEffectiveSurgeOpenCount(stateC, acceptedSetC), 1, "Both in state and set -> still count 1 (NO DOUBLE COUNT)");
  console.log(`[PASS] Test C: Managed state 등록 전(1) -> 등록 후(1) Double count 0건 검증 완료`);

  // --- Test D: 1 open + 3 eligible candidates -> accepted 최대 2 ---
  console.log("\n--- Test D: 1 open + 3 eligible candidates -> accepted 최대 2개 ---");
  const stateD: StrategyStateMock = {
    positions: { "KRW-EXIST": { engine_bucket: "surge", market: "KRW-EXIST", order_krw: 110_000 } },
    early_positions: {},
  };
  const acceptedSetD = new Set<string>();
  let remD = 240_000;
  let accD = 0;
  const candidatesD = ["KRW-B1", "KRW-B2", "KRW-B3"];
  const outcomesD: boolean[] = [];

  for (const sym of candidatesD) {
    const res = simulateSurgeCandidateExecution({
      market: sym,
      state: stateD,
      acceptedSurgeMarketsThisTick: acceptedSetD,
      surgeCapAmount: surgeCap,
      currentSurgeInvestedKrw: 110_000,
      sameTickAcceptedSurgeKrw: accD,
      remainingInTick: remD,
      mockOutcome: "accepted",
    });
    outcomesD.push(res.allowed);
    remD = res.newRemainingInTick;
    accD = res.newSameTickAccepted;
  }

  assert.deepStrictEqual(outcomesD, [true, true, false], "Exactly 2 orders accepted, 3rd blocked");
  assert.strictEqual(getEffectiveSurgeOpenCount(stateD, acceptedSetD), 3);
  console.log(`[PASS] Test D: 1 existing + 3 후보 중 2개 accepted, 3번째 차단`);

  // --- Test E: 2 open + 2 eligible candidates -> accepted 최대 1 ---
  console.log("\n--- Test E: 2 open + 2 eligible candidates -> accepted 최대 1개 ---");
  const stateE: StrategyStateMock = {
    positions: {
      "KRW-P1": { engine_bucket: "surge", market: "KRW-P1", order_krw: 110_000 },
      "KRW-P2": { engine_bucket: "surge", market: "KRW-P2", order_krw: 115_000 },
    },
    early_positions: {},
  };
  const acceptedSetE = new Set<string>();
  let remE = 125_000;
  let accE = 0;
  const candidatesE = ["KRW-C1", "KRW-C2"];
  const outcomesE: boolean[] = [];

  for (const sym of candidatesE) {
    const res = simulateSurgeCandidateExecution({
      market: sym,
      state: stateE,
      acceptedSurgeMarketsThisTick: acceptedSetE,
      surgeCapAmount: surgeCap,
      currentSurgeInvestedKrw: 225_000,
      sameTickAcceptedSurgeKrw: accE,
      remainingInTick: remE,
      mockOutcome: "accepted",
    });
    outcomesE.push(res.allowed);
    remE = res.newRemainingInTick;
    accE = res.newSameTickAccepted;
  }

  assert.deepStrictEqual(outcomesE, [true, false], "Exactly 1 order accepted, 2nd blocked");
  assert.strictEqual(getEffectiveSurgeOpenCount(stateE, acceptedSetE), 3);
  console.log(`[PASS] Test E: 2 existing + 2 후보 중 1개 accepted, 2번째 차단`);

  // --- Test F: 3 open -> accepted 0개 ---
  console.log("\n--- Test F: 3 open -> accepted 0개 ---");
  const stateF: StrategyStateMock = {
    positions: {
      "KRW-P1": { engine_bucket: "surge", market: "KRW-P1" },
      "KRW-P2": { engine_bucket: "surge", market: "KRW-P2" },
      "KRW-P3": { engine_bucket: "surge", market: "KRW-P3" },
    },
    early_positions: {},
  };
  const acceptedSetF = new Set<string>();
  const resF = simulateSurgeCandidateExecution({
    market: "KRW-NEW",
    state: stateF,
    acceptedSurgeMarketsThisTick: acceptedSetF,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 350_000,
    sameTickAcceptedSurgeKrw: 0,
    remainingInTick: 0,
    mockOutcome: "accepted",
  });
  assert.strictEqual(resF.allowed, false);
  assert.strictEqual(resF.blockReason, "surge_max_positions_reached");
  console.log(`[PASS] Test F: 3 open 시 신규 후보 즉시 차단 (${resF.blockReason})`);

  // --- Test G: 첫 주문 rejected -> reservation 없음 및 slot 미차감 ---
  console.log("\n--- Test G: 첫 주문 rejected -> reservation 없음 ---");
  const stateG: StrategyStateMock = { positions: {}, early_positions: {} };
  const acceptedSetG = new Set<string>();
  const resG1 = simulateSurgeCandidateExecution({
    market: "KRW-FAIL",
    state: stateG,
    acceptedSurgeMarketsThisTick: acceptedSetG,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 0,
    sameTickAcceptedSurgeKrw: 0,
    remainingInTick: surgeCap,
    mockOutcome: "rejected",
  });
  assert.strictEqual(resG1.allowed, false);
  assert.strictEqual(acceptedSetG.has("KRW-FAIL"), false, "Rejected market must NOT be added to reservation Set");
  assert.strictEqual(getEffectiveSurgeOpenCount(stateG, acceptedSetG), 0);
  console.log(`[PASS] Test G: Rejected 주문 reservation Set 미추가 검증 완료`);

  // --- Test H: exchange_order_unknown unresolved -> reservation 없음 ---
  console.log("\n--- Test H: exchange_order_unknown unresolved -> reservation 없음 ---");
  const stateH: StrategyStateMock = { positions: {}, early_positions: {} };
  const acceptedSetH = new Set<string>();
  const resH = simulateSurgeCandidateExecution({
    market: "KRW-UNKNOWN",
    state: stateH,
    acceptedSurgeMarketsThisTick: acceptedSetH,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 0,
    sameTickAcceptedSurgeKrw: 0,
    remainingInTick: surgeCap,
    mockOutcome: "unknown_unresolved",
  });
  assert.strictEqual(resH.allowed, false);
  assert.strictEqual(acceptedSetH.has("KRW-UNKNOWN"), false);
  assert.strictEqual(getEffectiveSurgeOpenCount(stateH, acceptedSetH), 0);
  console.log(`[PASS] Test H: Unknown unresolved 주문 reservation Set 미추가 검증`);

  // --- Test I: identifier lookup accepted -> reservation 1 ---
  console.log("\n--- Test I: identifier lookup accepted -> reservation 1 ---");
  const stateI: StrategyStateMock = { positions: {}, early_positions: {} };
  const acceptedSetI = new Set<string>();
  const resI = simulateSurgeCandidateExecution({
    market: "KRW-RESOLVED",
    state: stateI,
    acceptedSurgeMarketsThisTick: acceptedSetI,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 0,
    sameTickAcceptedSurgeKrw: 0,
    remainingInTick: surgeCap,
    mockOutcome: "unknown_resolved_by_identifier",
  });
  assert.strictEqual(resI.allowed, true);
  assert.strictEqual(acceptedSetI.has("KRW-RESOLVED"), true);
  assert.strictEqual(getEffectiveSurgeOpenCount(stateI, acceptedSetI), 1);
  console.log(`[PASS] Test I: Identifier lookup 확정 시 정상 reservation 반영`);

  // --- Test J: Early position 1 + Normal Surge 2 -> 총 3개 허용 (4번째 차단) ---
  console.log("\n--- Test J: Early position 1 + Normal Surge 2 -> 총 3개 허용 ---");
  const stateJ: StrategyStateMock = {
    positions: {},
    early_positions: { "KRW-EARLY": { engine_bucket: "surge", market: "KRW-EARLY", order_krw: 80_000 } },
  };
  const acceptedSetJ = new Set<string>(["KRW-EARLY"]);
  let remJ = 270_000;
  let accJ = 80_000;

  // Normal 1
  const resJ1 = simulateSurgeCandidateExecution({
    market: "KRW-NORM1",
    state: stateJ,
    acceptedSurgeMarketsThisTick: acceptedSetJ,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 0,
    sameTickAcceptedSurgeKrw: accJ,
    remainingInTick: remJ,
    mockOutcome: "accepted",
  });
  assert.strictEqual(resJ1.allowed, true);
  remJ = resJ1.newRemainingInTick;
  accJ = resJ1.newSameTickAccepted;

  // Normal 2
  const resJ2 = simulateSurgeCandidateExecution({
    market: "KRW-NORM2",
    state: stateJ,
    acceptedSurgeMarketsThisTick: acceptedSetJ,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 0,
    sameTickAcceptedSurgeKrw: accJ,
    remainingInTick: remJ,
    mockOutcome: "accepted",
  });
  assert.strictEqual(resJ2.allowed, true);
  remJ = resJ2.newRemainingInTick;
  accJ = resJ2.newSameTickAccepted;

  // Normal 3 (4번째 시도)
  const resJ3 = simulateSurgeCandidateExecution({
    market: "KRW-NORM3",
    state: stateJ,
    acceptedSurgeMarketsThisTick: acceptedSetJ,
    surgeCapAmount: surgeCap,
    currentSurgeInvestedKrw: 0,
    sameTickAcceptedSurgeKrw: accJ,
    remainingInTick: remJ,
    mockOutcome: "accepted",
  });
  assert.strictEqual(resJ3.allowed, false, "4th overall surge order (1 early + 2 normal) must be blocked");
  assert.strictEqual(getEffectiveSurgeOpenCount(stateJ, acceptedSetJ), 3);
  console.log(`[PASS] Test J: Early 1 + Normal 2 = 총 3개 정확히 제한 검증`);

  console.log("\n=======================================================");
  console.log("  ALL TESTS (Test A through J) PASSED SUCCESSFULLY! (0) ");
  console.log("=======================================================\n");
}

runSurgeSlotLockSafetyTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
