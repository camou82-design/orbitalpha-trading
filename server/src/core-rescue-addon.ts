/**
 * Core-only Rescue Add-on authority (1× per position).
 * Surge / Morning Surge paths must not import execution from here.
 */
import { ORDER_LIMITS } from "@orbitalpha/shared";

export const CORE_RESCUE_MAX_ADDON_COUNT = 1;

/** Fraction of entry→stop distance traveled toward stop (soft adverse band). */
export const CORE_RESCUE_MIN_ADVERSE_PROGRESS = 0.25;
export const CORE_RESCUE_MAX_ADVERSE_PROGRESS = 0.98;

export type CoreRescueHardRiskInput = {
  currentPrice: number;
  originalStopPrice: number;
  pnlGrossPct: number;
  marketState: string;
  btcFilterState?: string | null;
  dailyRiskKillSwitchActive?: boolean;
  /** Strong down continuation — same authority as surge rescue L6944. */
  recent1mRet: number | null;
  recent3mRet: number | null;
  signalFilters?: Array<{ id?: string; passed?: boolean }>;
  /** Price already at/below hard stop. */
  stopBreached?: boolean;
};

export type CoreRescueHardRiskResult = {
  hardRiskActive: boolean;
  hardRiskReason: string | null;
};

export type CoreRescueMicroReclaimInput = {
  currentPrice: number;
  entryPrice: number;
  originalStopPrice: number;
  recent1mRet: number | null;
  recent3mRet: number | null;
  volumeRatio: number | null;
  signalFilters?: Array<{ id?: string; passed?: boolean }>;
  /** Optional EMA20 micro support — reuse reclaim engine shape. */
  ema20?: number | null;
  pullbackLowPrice?: number | null;
};

export type CoreRescueMicroReclaimResult = {
  reclaimConfirmed: boolean;
  reclaimAuthority: string | null;
};

export type CoreRescueAddonSizingInput = {
  initialOrderKrw: number;
  preSoftOrderKrw: number;
  currentExposureKrw: number;
  originalStopPrice: number;
  entryPrice: number;
  currentPrice: number;
  coreRemainingKrw: number;
  availableKrw: number;
  perMarketRemainingKrw: number;
  addonAlreadyUsed?: boolean;
};

export type CoreRescueAddonSizingResult = {
  addonCandidateKrw: number;
  projectedTotalExposureKrw: number;
  projectedLossAtStopKrw: number;
  preSoftPlannedLossAtStopKrw: number;
  addonAllowed: boolean;
  blockReason: string | null;
};

export function isCoreRescueEngineBucket(engineBucket: string | undefined | null): boolean {
  return engineBucket === "core";
}

export function computeAdverseProgress(params: {
  entryPrice: number;
  currentPrice: number;
  originalStopPrice: number;
}): number | null {
  const { entryPrice, currentPrice, originalStopPrice } = params;
  if (!(entryPrice > originalStopPrice && originalStopPrice > 0)) return null;
  const span = entryPrice - originalStopPrice;
  if (span <= 0) return null;
  const traveled = entryPrice - currentPrice;
  return traveled / span;
}

export function evaluateCoreRescueHardRisk(input: CoreRescueHardRiskInput): CoreRescueHardRiskResult {
  if (input.dailyRiskKillSwitchActive) {
    return { hardRiskActive: true, hardRiskReason: "daily_risk_kill_switch_active" };
  }
  if (input.marketState === "risk_off") {
    return { hardRiskActive: true, hardRiskReason: "market_risk_off" };
  }
  if (input.btcFilterState === "panic") {
    return { hardRiskActive: true, hardRiskReason: "btc_panic" };
  }
  if (input.stopBreached || (input.originalStopPrice > 0 && input.currentPrice <= input.originalStopPrice)) {
    return { hardRiskActive: true, hardRiskReason: "hard_stop_breached" };
  }
  if (input.pnlGrossPct <= -2.0) {
    return { hardRiskActive: true, hardRiskReason: "emergency_loss_threshold" };
  }
  if (input.recent1mRet !== null && input.recent3mRet !== null && input.recent1mRet < 0 && input.recent3mRet < 0) {
    return { hardRiskActive: true, hardRiskReason: "strong_down_continuation" };
  }
  const filters = input.signalFilters ?? [];
  const hasFailed = (re: RegExp) => filters.some((f) => re.test(String(f.id ?? "")) && f.passed === false);
  if (hasFailed(/upper_wick|high_rejected/i)) {
    return { hardRiskActive: true, hardRiskReason: "structural_upper_wick_high_rejected" };
  }
  if (hasFailed(/retest|pullback/i)) {
    return { hardRiskActive: true, hardRiskReason: "structural_retest_pullback_fail" };
  }
  if (hasFailed(/volume_fade/i)) {
    return { hardRiskActive: true, hardRiskReason: "structural_volume_fade" };
  }
  return { hardRiskActive: false, hardRiskReason: null };
}

/**
 * Micro reclaim — reuses production micro-reclaim / short-term momentum authority patterns
 * (surge rescue negative-return block inverse + 1m bounce + optional EMA20 / pullback rebound).
 */
export function evaluateCoreRescueMicroReclaim(input: CoreRescueMicroReclaimInput): CoreRescueMicroReclaimResult {
  const { recent1mRet, recent3mRet, volumeRatio, currentPrice, entryPrice, originalStopPrice } = input;

  if (recent1mRet !== null && recent3mRet !== null && recent1mRet < 0 && recent3mRet < 0) {
    return { reclaimConfirmed: false, reclaimAuthority: null };
  }
  if (volumeRatio !== null && volumeRatio < 0.65) {
    return { reclaimConfirmed: false, reclaimAuthority: null };
  }

  const filters = input.signalFilters ?? [];
  const hasFailed = (re: RegExp) => filters.some((f) => re.test(String(f.id ?? "")) && f.passed === false);
  if (hasFailed(/volume_fade|retest|pullback|upper_wick|high_rejected/i)) {
    return { reclaimConfirmed: false, reclaimAuthority: null };
  }

  if (recent1mRet !== null && recent1mRet > 0) {
    if (typeof input.ema20 === "number" && Number.isFinite(input.ema20) && currentPrice >= input.ema20) {
      return { reclaimConfirmed: true, reclaimAuthority: "micro_reclaim_1m_positive_ema20_support" };
    }
    if (input.pullbackLowPrice != null && currentPrice > input.pullbackLowPrice) {
      return { reclaimConfirmed: true, reclaimAuthority: "micro_reclaim_1m_positive_pullback_rebound" };
    }
    return { reclaimConfirmed: true, reclaimAuthority: "micro_reclaim_1m_positive" };
  }

  const span = entryPrice - originalStopPrice;
  if (span > 0) {
    const recoveryFromStop = (currentPrice - originalStopPrice) / span;
    if (recoveryFromStop >= 0.15 && recent3mRet !== null && recent3mRet >= -0.2) {
      return { reclaimConfirmed: true, reclaimAuthority: "micro_reclaim_stop_span_recovery" };
    }
  }

  return { reclaimConfirmed: false, reclaimAuthority: null };
}

export function computePreSoftPlannedLossAtStopKrw(params: {
  preSoftOrderKrw: number;
  entryPrice: number;
  originalStopPrice: number;
}): number {
  const { preSoftOrderKrw, entryPrice, originalStopPrice } = params;
  if (!(preSoftOrderKrw > 0 && entryPrice > originalStopPrice && originalStopPrice > 0)) return 0;
  const qty = preSoftOrderKrw / entryPrice;
  return qty * (entryPrice - originalStopPrice);
}

export function computeProjectedLossAtStopKrw(params: {
  totalExposureKrw: number;
  avgEntryPrice: number;
  originalStopPrice: number;
}): number {
  const { totalExposureKrw, avgEntryPrice, originalStopPrice } = params;
  if (!(totalExposureKrw > 0 && avgEntryPrice > originalStopPrice && originalStopPrice > 0)) return 0;
  const qty = totalExposureKrw / avgEntryPrice;
  return qty * (avgEntryPrice - originalStopPrice);
}

export function computeCoreRescueAddonSizing(input: CoreRescueAddonSizingInput): CoreRescueAddonSizingResult {
  const {
    initialOrderKrw,
    preSoftOrderKrw,
    currentExposureKrw,
    originalStopPrice,
    entryPrice,
    currentPrice,
    coreRemainingKrw,
    availableKrw,
    perMarketRemainingKrw,
  } = input;

  const preSoftPlannedLossAtStopKrw = computePreSoftPlannedLossAtStopKrw({
    preSoftOrderKrw,
    entryPrice,
    originalStopPrice,
  });

  if (initialOrderKrw <= 0) {
    return {
      addonCandidateKrw: 0,
      projectedTotalExposureKrw: currentExposureKrw,
      projectedLossAtStopKrw: computeProjectedLossAtStopKrw({
        totalExposureKrw: currentExposureKrw,
        avgEntryPrice: entryPrice,
        originalStopPrice,
      }),
      preSoftPlannedLossAtStopKrw,
      addonAllowed: false,
      blockReason: "initial_order_krw_invalid",
    };
  }

  if (input.addonAlreadyUsed) {
    return {
      addonCandidateKrw: 0,
      projectedTotalExposureKrw: currentExposureKrw,
      projectedLossAtStopKrw: computeProjectedLossAtStopKrw({
        totalExposureKrw: currentExposureKrw,
        avgEntryPrice: entryPrice,
        originalStopPrice,
      }),
      preSoftPlannedLossAtStopKrw,
      addonAllowed: false,
      blockReason: "core_rescue_addon_already_used",
    };
  }

  const maxByInitial = initialOrderKrw;
  const maxByPreSoft = Math.max(0, preSoftOrderKrw - currentExposureKrw);
  const maxByPerMarket = Math.max(0, perMarketRemainingKrw);
  const maxByCoreCap = Math.max(0, coreRemainingKrw);
  const maxByAvailable = Math.max(0, availableKrw);

  let addonCandidateKrw = Math.min(maxByInitial, maxByPreSoft, maxByPerMarket, maxByCoreCap, maxByAvailable);
  addonCandidateKrw = Math.floor(addonCandidateKrw);

  const projectedTotalExposureKrw = currentExposureKrw + addonCandidateKrw;
  const fillPrice = currentPrice > 0 ? currentPrice : entryPrice;
  const currentQty = entryPrice > 0 ? currentExposureKrw / entryPrice : 0;
  const addedQty = fillPrice > 0 ? addonCandidateKrw / fillPrice : 0;
  const newQty = currentQty + addedQty;
  const newAvgEntry = newQty > 0 ? projectedTotalExposureKrw / newQty : entryPrice;
  const projectedLossAtStopKrw = computeProjectedLossAtStopKrw({
    totalExposureKrw: projectedTotalExposureKrw,
    avgEntryPrice: newAvgEntry,
    originalStopPrice,
  });

  if (addonCandidateKrw < 5000) {
    return {
      addonCandidateKrw,
      projectedTotalExposureKrw,
      projectedLossAtStopKrw,
      preSoftPlannedLossAtStopKrw,
      addonAllowed: false,
      blockReason: "addon_below_min_order",
    };
  }

  if (projectedTotalExposureKrw > preSoftOrderKrw + 1e-6) {
    return {
      addonCandidateKrw,
      projectedTotalExposureKrw,
      projectedLossAtStopKrw,
      preSoftPlannedLossAtStopKrw,
      addonAllowed: false,
      blockReason: "total_exposure_exceeds_pre_soft_order",
    };
  }

  if (projectedTotalExposureKrw > ORDER_LIMITS.MAX_STRATEGY_INVESTED_KRW_PER_MARKET + 1e-6) {
    return {
      addonCandidateKrw,
      projectedTotalExposureKrw,
      projectedLossAtStopKrw,
      preSoftPlannedLossAtStopKrw,
      addonAllowed: false,
      blockReason: "per_market_220k_cap_exceeded",
    };
  }

  if (projectedLossAtStopKrw > preSoftPlannedLossAtStopKrw + 1e-6) {
    return {
      addonCandidateKrw,
      projectedTotalExposureKrw,
      projectedLossAtStopKrw,
      preSoftPlannedLossAtStopKrw,
      addonAllowed: false,
      blockReason: "projected_loss_exceeds_pre_soft_envelope",
    };
  }

  return {
    addonCandidateKrw,
    projectedTotalExposureKrw,
    projectedLossAtStopKrw,
    preSoftPlannedLossAtStopKrw,
    addonAllowed: true,
    blockReason: null,
  };
}

export function buildCoreRescueEvalProof(params: {
  market: string;
  entryPrice: number;
  currentPrice: number;
  originalStopPrice: number;
  adverseProgress: number | null;
  hardRisk: CoreRescueHardRiskResult;
  reclaim: CoreRescueMicroReclaimResult;
  sizing: CoreRescueAddonSizingResult;
  initialOrderKrw: number;
  currentExposureKrw: number;
  preSoftOrderKrw: number;
  addonAllowed: boolean;
  blockReason: string | null;
}): Record<string, unknown> {
  return {
    tag: "CORE_RESCUE_ADDON_EVAL_PROOF",
    ts: new Date().toISOString(),
    market: params.market,
    entry_price: params.entryPrice,
    current_price: params.currentPrice,
    original_stop_price: params.originalStopPrice,
    adverse_progress: params.adverseProgress,
    hard_risk_active: params.hardRisk.hardRiskActive,
    hard_risk_reason: params.hardRisk.hardRiskReason,
    reclaim_confirmed: params.reclaim.reclaimConfirmed,
    reclaim_authority: params.reclaim.reclaimAuthority,
    initial_order_krw: params.initialOrderKrw,
    current_exposure_krw: params.currentExposureKrw,
    pre_soft_order_krw: params.preSoftOrderKrw,
    addon_candidate_krw: params.sizing.addonCandidateKrw,
    projected_total_exposure_krw: params.sizing.projectedTotalExposureKrw,
    projected_loss_at_stop_krw: Math.floor(params.sizing.projectedLossAtStopKrw),
    pre_soft_planned_loss_at_stop_krw: Math.floor(params.sizing.preSoftPlannedLossAtStopKrw),
    addon_allowed: params.addonAllowed,
    block_reason: params.blockReason,
  };
}
