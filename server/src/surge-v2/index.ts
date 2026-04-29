export * from "./surge-types.js";
export { isSurgePosition } from "./surge-position-classifier.js";
export { evaluateSurgeEntryPipeline } from "./surge-entry-engine.js";
export { evaluateSurgeExit } from "./surge-exit-engine.js";

// Shadow Judgment Logic (Preserved for paper-trading and workers)
import { detectEarlySurge } from "./surge-early-detector.js";
import { validateSurge } from "./surge-validation-layer.js";
import { evaluateSurgeRisk } from "./surge-risk-rejector.js";
import { manageSurgeProfit } from "./surge-profit-manager.js";

export type SurgeV2Judgment = {
  market: string;
  ts: string;
  surgeEarlyScore: number;
  surgeValidationScore: number;
  surgeProfitAction: "none" | "protect_break_even" | "partial_take_profit" | "hold_runner" | "tighten_exit" | "exit_now_candidate";
  validationGrade: "strong" | "valid" | "weak" | "reject_risk";
  surgeStage: "cold" | "warming" | "early_surge_candidate" | "active_surge" | "late_chase_risk";
  runnerAllowed: boolean;
  fakePumpExitRisk: number;
};

export function buildSurgeV2ShadowJudgment(market: string, data: any): SurgeV2Judgment {
  const early = detectEarlySurge(market, data);
  const validation = validateSurge(market, data);
  const risk = evaluateSurgeRisk(market, data);
  const profit = manageSurgeProfit(market, data);

  return {
    market,
    ts: new Date().toISOString(),
    surgeEarlyScore: early.score,
    surgeValidationScore: validation.validationScore,
    surgeProfitAction: profit.action,
    validationGrade: validation.validationGrade,
    surgeStage: early.stage,
    runnerAllowed: profit.runnerAllowed,
    fakePumpExitRisk: risk.fakePumpExitRisk,
  };
}
