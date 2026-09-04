import type { SignalLogEntry } from "@orbitalpha/shared";
import { mvpSignalPayloadV2Schema, ORDER_LIMITS, runEntryScoreGate, signalStrengthScore, type MarketState } from "@orbitalpha/shared";
import { appendLog } from "./log-store.js";
import { fetchMinuteCandles } from "./upbit-public.js";

export type { MarketState };
export type EntryPolicy = "적극 진입" | "선별 진입" | "축소 진입";

export type MarketStateSnapshot = {
  timestamp: string;
  market_state: MarketState;
  entry_policy: EntryPolicy;
  market_bonus: number;
  min_entry_score: number;
  /** risk_off가 아닐 때만 신규·추가 매수 게이트(점수) 평가 진행. */
  regime_allows_new_and_additional_buys: boolean;
  order_limits: typeof ORDER_LIMITS;
  btc_5m_trend: "up" | "down" | "flat";
  btc_15m_trend: "up" | "down" | "flat";
  breadth_ratio: number;
  recent_close_bias: "up" | "down" | "flat";
  /** BTC 약세 구간 보수 모드 여부 */
  conservative_mode: boolean;
  /** risk_off에서도 강한 대표 코인에 한해 신규 진입 예외 허용 */
  exception_entry_allowed: boolean;
  /** BTC RSI 14일 연산값 */
  btc_rsi?: number;
};

/** 주문 직전 게이트용 — UI `market-state` 와 동일 스냅샷 기준. */
export type OrderBuyGateResult =
  | {
      ok: true;
      market_state: MarketState;
      entry_policy: EntryPolicy;
      new_entry_blocked: false;
      add_entry_blocked: false;
      blocked_reason: null;
      size_scale: number;
    }
  | {
      ok: false;
      market_state: MarketState;
      entry_policy: EntryPolicy;
      new_entry_blocked: boolean;
      add_entry_blocked: boolean;
      blocked_reason: string;
      size_scale: number;
    };

function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let out = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) out = values[i]! * k + out * (1 - k);
  return out;
}

function trendByEma(closes: number[], shortP: number, longP: number): "up" | "down" | "flat" {
  const s = ema(closes, shortP);
  const l = ema(closes, longP);
  if (s > l * 1.001) return "up";
  if (s < l * 0.999) return "down";
  return "flat";
}

export function createMarketStateFilter(args: {
  companyId: string;
  serviceId: string;
  readLogs: (limit: number) => Promise<SignalLogEntry[]>;
  onEvent?: (row: {
    timestamp: string;
    event_type: string;
    market: string | null;
    strategy_type: string | null;
    market_state: string | null;
    side: string | null;
    reason: string | null;
    balance_krw: number | null;
    position_qty: number | null;
    avg_buy_price: number | null;
    current_price: number | null;
    pnl_net: number | null;
    pnl_net_pct: number | null;
    note: string | null;
    type?: string;
    final_close?: boolean;
    partial_exit?: boolean;
    stage?: string;
  }) => Promise<void>;
}) {
  const state: { latest: MarketStateSnapshot | null } = { latest: null };

  const evaluate = async () => {
    const t0 = Date.now();

    const wrap = async <T>(name: string, p: Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        const res = await p;
        const end = Date.now();
        console.info(
          JSON.stringify({
            tag: "MARKET_STATE_EVALUATE_PHASE_PROOF",
            ts: new Date().toISOString(),
            phase: name,
            elapsed_ms: end - start,
            outcome: "ok",
          }),
        );
        return res;
      } catch (e) {
        console.error(
          JSON.stringify({
            tag: "MARKET_STATE_EVALUATE_PHASE_PROOF",
            ts: new Date().toISOString(),
            phase: name,
            elapsed_ms: Date.now() - start,
            outcome: "error",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        throw e;
      }
    };

    const [c5, c15, logs] = await Promise.all([
      wrap("btc_5m", fetchMinuteCandles("KRW-BTC", 5, 50)),
      wrap("btc_15m", fetchMinuteCandles("KRW-BTC", 15, 50)),
      wrap("read_logs", args.readLogs(150)),
    ]);

    const t1 = Date.now();
    if (t1 - t0 > 15000) {
      console.warn(
        JSON.stringify({
          tag: "MARKET_STATE_EVALUATE_TIMEOUT_CAUSE_PROOF",
          ts: new Date().toISOString(),
          elapsed_ms: t1 - t0,
          reason: "slow_io_parallel_total_exceeded_15s",
        }),
      );
    }

    const closes5 = c5.map((c) => c.trade_price);
    const closes15 = c15.map((c) => c.trade_price);
    
    // 14일 RSI 연산 (5분봉 14개 기준의 RSI 계산 헬퍼)
    const btcRsi = (() => {
      if (closes5.length < 15) return undefined;
      let gains = 0;
      let losses = 0;
      for (let i = 1; i <= 14; i++) {
        const diff = Number(closes5[closes5.length - 15 + i]) - Number(closes5[closes5.length - 15 + i - 1]);
        if (diff > 0) gains += diff;
        else losses -= diff;
      }
      let avgGain = gains / 14;
      let avgLoss = losses / 14;
      if (avgLoss === 0) return 100;
      let rs = avgGain / avgLoss;
      let rsi = 100 - 100 / (1 + rs);
      
      // 와일더(Wilder) 스무딩 적용 (나머지 캔들 대상)
      const remainingStart = closes5.length - 14;
      for (let i = remainingStart; i < closes5.length; i++) {
        const diff = Number(closes5[i]) - Number(closes5[i - 1]);
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
      }
      if (avgLoss === 0) return 100;
      rs = avgGain / avgLoss;
      return 100 - 100 / (1 + rs);
    })();

    const btc5 = trendByEma(closes5, 5, 13);
    const btc15 = trendByEma(closes15, 4, 10);
    const r5 = closes5.length > 6 ? (closes5[closes5.length - 1]! / closes5[closes5.length - 6]! - 1) * 100 : 0;
    const r15 = closes15.length > 2 ? (closes15[closes15.length - 1]! / closes15[closes15.length - 2]! - 1) * 100 : 0;
    const recent3 = closes5.slice(-3);
    const flowUp = recent3.length === 3 && recent3[2]! >= recent3[1]! && recent3[1]! >= recent3[0]!;
    const flowDown = recent3.length === 3 && recent3[2]! <= recent3[1]! && recent3[1]! <= recent3[0]!;
    const sharpDrop = r5 <= -1.4 || r15 <= -2.2;

    const latestBy = new Map<string, unknown>();
    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!p.success) continue;
      if (!latestBy.has(p.data.market)) latestBy.set(p.data.market, row.payload);
    }
    const arr = [...latestBy.values()];
    const strong = arr.filter((p) => signalStrengthScore(p) >= 70).length;
    const weak = arr.filter((p) => signalStrengthScore(p) < 55).length;
    const breadth = arr.length > 0 ? strong / arr.length : 0;

    const breadthBad = weak >= Math.max(2, strong + 1);
    const riskOffScore =
      (btc5 === "down" ? 1 : 0) +
      (btc15 === "down" ? 1 : 0) +
      (flowDown ? 1 : 0) +
      (r5 <= -0.8 ? 1 : 0) +
      (breadthBad ? 1 : 0) +
      (sharpDrop ? 1 : 0);
    let marketState: MarketState = "neutral";
    if (riskOffScore >= 2) marketState = "risk_off";
    else if (btc5 === "up" && btc15 === "up" && flowUp && r5 > -0.2 && r15 > -0.2 && !sharpDrop) marketState = "risk_on";

    const conservativeMode = marketState === "risk_off";
    const snap: MarketStateSnapshot = {
      timestamp: new Date().toISOString(),
      market_state: marketState,
      // 분화 장세: risk_off도 차단이 아닌 축소 진입 모드로 운영.
      entry_policy: marketState === "risk_on" ? "적극 진입" : marketState === "neutral" ? "선별 진입" : "축소 진입",
      market_bonus: marketState === "risk_on" ? 18 : marketState === "neutral" ? 0 : -10,
      // 과거 neutral=90 컷은 신규진입·추가매수(대시보드 표기 포함)를 과도하게 보수적으로 만들었음.
      min_entry_score: marketState === "risk_on" ? 72 : marketState === "neutral" ? 76 : 88,
      regime_allows_new_and_additional_buys: true,
      order_limits: { ...ORDER_LIMITS },
      btc_5m_trend: btc5,
      btc_15m_trend: btc15,
      breadth_ratio: Number(breadth.toFixed(3)),
      recent_close_bias: flowUp ? "up" : flowDown ? "down" : "flat",
      conservative_mode: conservativeMode,
      exception_entry_allowed: conservativeMode,
      btc_rsi: btcRsi,
    };

    if (!state.latest || state.latest.market_state !== snap.market_state) {
      await appendLog({
        company_id: args.companyId as any,
        service_id: args.serviceId as any,
        ts: snap.timestamp,
        kind: "system",
        message: "market_state_changed",
        payload: snap,
      });
      if (args.onEvent) {
        await args.onEvent({
          timestamp: snap.timestamp,
          event_type: "market_state_changed",
          market: null,
          strategy_type: null,
          market_state: snap.market_state,
          side: null,
          reason: snap.entry_policy,
          balance_krw: null,
          position_qty: null,
          avg_buy_price: null,
          current_price: null,
          pnl_net: null,
          pnl_net_pct: null,
          note: `btc5=${snap.btc_5m_trend}, btc15=${snap.btc_15m_trend}, breadth=${snap.breadth_ratio}, close_bias=${snap.recent_close_bias}`,
        });
      }
    }
    state.latest = snap;
    return snap;
  };

  const entryGate = (
    payload: unknown,
    s: { market_state: "risk_on" | "neutral" | "risk_off"; min_entry_score: number; market_bonus: number },
  ) => runEntryScoreGate(s.market_state, s.min_entry_score, s.market_bonus, payload);

  return {
    evaluate,
    status: () => state.latest,
    entryGate,
  };
}

/**
 * 신규 진입·추가매수 공통 게이트.
 * - 신규: 장세(risk_off 차단) + entry score(min_entry_score) 반드시 통과.
 * - 추가매수: risk_off 전면 차단(물타기/추가 진입 없음).
 */
export function assertOrderBuyAllowed(
  snap: MarketStateSnapshot,
  args: {
    kind: "new_entry" | "add_to_position";
    signalPayload?: unknown;
    strategyType?: string;
    market?: string;
    entrySignalType?: string;
    reclaimScore?: number;
    volumeAccel?: number;
    aboveEma20?: boolean;
    candidateMeta?: any;
    sourceKind?: string;
    coreScore?: number;
    majorImpulseScore?: number;
  },
): OrderBuyGateResult {
  const { market_state, entry_policy } = snap;
  const size_scale = market_state === "risk_on" ? 1 : market_state === "neutral" ? 0.72 : 0.45;

  const deny = (
    blocked_reason: string,
    new_entry_blocked: boolean,
    add_entry_blocked: boolean,
  ): OrderBuyGateResult => ({
    ok: false,
    market_state,
    entry_policy,
    new_entry_blocked,
    add_entry_blocked,
    blocked_reason,
    size_scale: 0,
  });

  const strategyType = args.strategyType || "";
  const entrySignalType = args.entrySignalType || "";
  const sourceKind = args.sourceKind || (args.candidateMeta?.source_kind as string) || "";
  const market = args.market || (args.candidateMeta?.market as string) || "";

  const isMajorImpulseStrategy =
    strategyType === "major_impulse" ||
    sourceKind === "MAJOR_IMPULSE_V1" ||
    args.candidateMeta?.setupReason === "MAJOR_IMPULSE_V1" ||
    args.candidateMeta?.setup?.reason === "MAJOR_IMPULSE_V1";

  const isAggressiveSurgeStrategy =
    !isMajorImpulseStrategy &&
    (strategyType === "momentum" ||
      strategyType === "surge_breakout" ||
      strategyType === "surge_chase");

  const isReclaimStrategy =
    !isMajorImpulseStrategy &&
    (strategyType === "reclaim" ||
      strategyType === "surge_reclaim" ||
      entrySignalType === "reclaim");

  const isCoreStrategy =
    !isMajorImpulseStrategy &&
    !isAggressiveSurgeStrategy &&
    !isReclaimStrategy &&
    (strategyType === "core" ||
      strategyType === "stable" ||
      strategyType === "core_trend" ||
      strategyType === "core_pullback" ||
      sourceKind === "CORE_TRADE" ||
      args.candidateMeta?.engine_bucket === "core" ||
      (typeof args.candidateMeta?.setupReason === "string" && args.candidateMeta?.setupReason.startsWith("CORE_")));

  // genuine setup PASS evidence: 오직 production의 canonical engine_bucket === "surge" && setup.ok === true 만 인정
  const isSurgeSetupPassed = Boolean(
    isAggressiveSurgeStrategy &&
    !isReclaimStrategy &&
    args.candidateMeta?.engine_bucket === "surge" &&
    args.candidateMeta?.setup?.ok === true
  );

  const isMajorImpulseSetupPassed = Boolean(
    isMajorImpulseStrategy &&
    (market === "KRW-BTC" || market === "KRW-ETH") &&
    (args.candidateMeta?.setup?.ok === true || args.candidateMeta?.is_major_impulse === true || (args.majorImpulseScore !== undefined && args.majorImpulseScore >= 85)) &&
    args.candidateMeta?.is_panic !== true
  );

  if (args.kind === "new_entry") {
    const isMajorMarket = market === "KRW-BTC" || market === "KRW-ETH";
    const btcPhase = String(args.candidateMeta?.btc_phase || (args as any).btcPhase || "").toLowerCase();
    const assetPhase = String(args.candidateMeta?.asset_phase || (args as any).assetPhase || btcPhase).toLowerCase();

    // Panic 상태는 모든 전략 예외 없이 100% 하드 블록
    if (args.candidateMeta?.is_panic === true || (args as any).is_panic === true) {
      return deny("panic_hard_risk_blocked: 급락/패닉 상태 신규 진입 차단", true, false);
    }

    // [COMMON MAJOR MARKET PHASE SAFETY]
    // KRW-BTC / KRW-ETH 신규 진입 시 sourceKind 무관 공통 Market Phase 보호:
    // - exhaustion => BTC 또는 자산 자체(ETH 등)가 exhaustion이면 신규 breakout/trend chase 100% BLOCK
    // - retrace => BTC 또는 자산 자체(ETH 등)가 retrace이면 신규 breakout/trend chase BLOCK (명시적 pullback/reclaim 증거 필요)
    if (isMajorMarket) {
      if (btcPhase === "exhaustion" || assetPhase === "exhaustion") {
        return deny("major_phase_exhaustion_blocked: BTC/ETH exhaustion 상태에서 신규 추격 진입 차단", true, false);
      }
      if (btcPhase === "retrace" || assetPhase === "retrace") {
        const isPullbackReclaimSetup =
          isReclaimStrategy ||
          args.candidateMeta?.setupReason === "CORE_PULLBACK_RECLAIM" ||
          args.candidateMeta?.setup?.reason === "CORE_PULLBACK_RECLAIM" ||
          (typeof args.candidateMeta?.setupReason === "string" && args.candidateMeta?.setupReason.includes("PULLBACK") && args.candidateMeta?.setup?.ok === true);
        if (!isPullbackReclaimSetup) {
          return deny("major_phase_retrace_blocked: BTC/ETH retrace 상태에서 신규 추격 진입 차단", true, false);
        }
      }
    }

    if (market_state === "risk_off") {
      if (isMajorImpulseStrategy) {
        // [MAJOR_IMPULSE RISK_OFF EXCEPTION AUTHORITY]
        // BTC/ETH only, genuine setup.ok / impulse score >= 85, panic false 필수
        if (!isMajorImpulseSetupPassed) {
          return deny("risk_off: Major Impulse 예외 조건 미충족 (BTC/ETH only, setup.ok 필수, panic 불가)", true, false);
        }
      } else if (isAggressiveSurgeStrategy) {
        // [SURGE MARKET-STATE EXECUTION ALIGNMENT]
        // genuine setup.ok를 통과한 일반 Surge momentum에 한해 risk_off 일괄 차단을 해제하고,
        // 뒤쪽의 기존 BTC RSI 50 및 Entry Score 품질 검증을 거치도록 통과시킴.
        if (!isSurgeSetupPassed) {
          return deny("risk_off: 신규 진입 금지", true, false);
        }
      } else {
        // Core/Stable, Reclaim, 기타 전략은 risk_off에서 즉시 차단 (불변)
        return deny("risk_off: 신규 진입 금지", true, false);
      }
    }

    if (isMajorImpulseStrategy) {
      // 1. Major Impulse Fast-Track: KRW-BTC / KRW-ETH Only
      if (args.candidateMeta?.is_panic === true) {
        return deny("panic_hard_risk_blocked: 급락/패닉 상태 신규 진입 차단", true, false);
      }
      if (market && market !== "KRW-BTC" && market !== "KRW-ETH") {
        return deny("major_impulse_market_not_eligible: KRW-BTC/KRW-ETH only", true, false);
      }
      if (!args.candidateMeta?.setup?.ok && args.candidateMeta?.is_major_impulse !== true && (args.majorImpulseScore === undefined || !Number.isFinite(args.majorImpulseScore))) {
        return deny("major_impulse_setup_not_met: genuine setup evidence required", true, false);
      }
      const impulseScore = Math.min(
        100,
        Math.max(
          0,
          args.majorImpulseScore ??
            args.candidateMeta?.score ??
            (args.candidateMeta?.setup?.ok ? 85 : 0) + snap.market_bonus,
        ),
      );
      if (impulseScore < snap.min_entry_score) {
        return deny(`major_impulse_score_low: ${impulseScore} < ${snap.min_entry_score}`, true, false);
      }
      let probeScale: number;
      if (args.candidateMeta?.is_recovery_probe) {
        const rawScale = args.candidateMeta?.relaxed_multiplier;
        if (typeof rawScale !== "number" || !Number.isFinite(rawScale) || rawScale <= 0) {
          return deny("major_impulse_recovery_scale_invalid: missing, non-positive or NaN scale", true, false);
        }
        probeScale = Math.min(rawScale, 0.15);
      } else {
        probeScale = Math.min(0.35, Math.max(0.20, args.candidateMeta?.relaxed_multiplier ?? 0.30));
      }
      return {
        ok: true,
        market_state,
        entry_policy,
        new_entry_blocked: false,
        add_entry_blocked: false,
        blocked_reason: null,
        size_scale: size_scale * probeScale,
      };
    } else if (isCoreStrategy) {
      // 2. Core Strategy Score Authority: Setup 기반 점수 적용 (Fail-Closed)
      let coreScore: number | null = null;
      if (args.candidateMeta?.setup) {
        if (args.candidateMeta.setup.ok !== true) {
          return deny(`core_setup_not_met: ${args.candidateMeta.setup.reason ?? "setup_failed"}`, true, false);
        }
        coreScore = Math.min(
          100,
          Math.max(0, Number(args.coreScore ?? args.candidateMeta.score ?? (85 + snap.market_bonus))),
        );
      } else if (args.coreScore !== undefined && Number.isFinite(args.coreScore) && Number(args.coreScore) > 0) {
        coreScore = Math.min(100, Math.max(0, Number(args.coreScore) + snap.market_bonus));
      } else if (args.signalPayload) {
        const payloadScore = signalStrengthScore(args.signalPayload);
        if (payloadScore > 0) {
          coreScore = Math.min(100, Math.max(0, payloadScore + snap.market_bonus));
        }
      }

      if (coreScore === null || Number.isNaN(coreScore) || coreScore < snap.min_entry_score) {
        return deny(`entry score ${coreScore ?? 0} < ${snap.min_entry_score}`, true, false);
      }
    } else if (isReclaimStrategy) {
      // 3. Reclaim 전용 점수 결정 (우선순위: args.reclaimScore -> signalPayload 내 필드)
      let rScore: number | undefined = args.reclaimScore;
      if ((rScore === undefined || rScore === null || Number.isNaN(rScore)) && args.signalPayload) {
        const p = args.signalPayload as any;
        const candidateFields = [
          p.surge_capture_score,
          p.reclaim_score,
          p.scanner_score,
          p.entry_score,
          p.signal_score
        ];
        for (const f of candidateFields) {
          if (f !== undefined && f !== null && f !== "") {
            const parsed = Number(f);
            if (!Number.isNaN(parsed)) {
              rScore = parsed;
              break;
            }
          }
        }
      }

      if (rScore === undefined || rScore === null || Number.isNaN(rScore)) {
        return deny("reclaim_score_missing: Reclaim score is missing or invalid", true, false);
      }

      // 2. Reclaim 전용 BTC RSI 정책 분리
      if (snap.btc_rsi !== undefined) {
        if (snap.btc_rsi < 40) {
          return deny(`btc_rsi_low_reclaim_blocked: Reclaim requires BTC RSI >= 40 (${snap.btc_rsi.toFixed(1)})`, true, false);
        } else if (snap.btc_rsi < 50) {
          // 40 <= btc_rsi < 50: 추가 강화 조건 적용
          const volAccel = args.volumeAccel ?? 0;
          const aboveEma = args.aboveEma20 ?? false;
          if (rScore < 65) {
            return deny(`btc_rsi_low_reclaim_penalty_blocked: RSI < 50 requires reclaim_score >= 65 (actual: ${rScore})`, true, false);
          }
          if (volAccel < 1.1) {
            return deny(`btc_rsi_low_reclaim_penalty_blocked: RSI < 50 requires volume acceleration >= 1.1 (actual: ${volAccel.toFixed(2)})`, true, false);
          }
          if (!aboveEma) {
            return deny("btc_rsi_low_reclaim_penalty_blocked: RSI < 50 requires price > EMA20", true, false);
          }
        }
      }

      // 3. Reclaim 전용 최소 점수 적용
      const minReclaimScore = market_state === "risk_on" ? 50 : 55;
      if (rScore < minReclaimScore) {
        return deny(`reclaim_score_low: Reclaim score ${rScore} < ${minReclaimScore} in ${market_state} market`, true, false);
      }

    } else {
      // 4. 일반 Aggressive Surge 정책 (불변 유지)
      if (isAggressiveSurgeStrategy) {
        if (market_state === "neutral" && !isSurgeSetupPassed) {
          // genuine setup_ok를 통과하지 못한 Surge는 neutral에서 진입 차단
          return deny("neutral_market_surge_blocked: 중립 장세에서는 surge 진입 차단", true, false);
        }
        // [불변] BTC RSI < 50 기존 기준 100% 유지
        if (snap.btc_rsi !== undefined && snap.btc_rsi < 50) {
          return deny(`btc_rsi_low_surge_blocked: BTC RSI가 50 미만이라 진입 차단 (${snap.btc_rsi.toFixed(1)})`, true, false);
        }
      }

      // [품질 판정] Entry Score 품질 검증: 기존 min_entry_score 및 market_bonus 기준 100% 적용
      const score = signalStrengthScore(args.signalPayload) + snap.market_bonus;
      if (score < snap.min_entry_score) {
        return deny(`entry score ${score} < ${snap.min_entry_score}`, true, false);
      }
    }

    return {
      ok: true,
      market_state,
      entry_policy,
      new_entry_blocked: false,
      add_entry_blocked: false,
      blocked_reason: null,
      size_scale,
    };
  }

  if (market_state === "risk_off") {
    return deny("risk_off: 추가 매수·DCA 금지", false, true);
  }

  return {
    ok: true,
    market_state,
    entry_policy,
    new_entry_blocked: false,
    add_entry_blocked: false,
    blocked_reason: null,
    size_scale,
  };
}

