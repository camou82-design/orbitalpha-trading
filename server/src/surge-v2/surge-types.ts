export type SurgeDecisionAuthority = "surge-v2";

export type SurgeEntryMode = "FAST_SURGE_PROBE" | "CONFIRMED_SURGE_ENTRY";

export type SurgeEntryDecision =
  | {
      action: "enter";
      reason: "surge_entry_approved";
      authoritySource: SurgeDecisionAuthority;
      detail: Record<string, unknown>;
      entryMode: SurgeEntryMode;
      sizeMultiplier: number;
      stopPct: number;
      takeProfitPct: number;
      trailingStartPct: number;
      trailingGapPct: number;
    }
  | {
      action: "reject";
      reason: string;
      authoritySource: SurgeDecisionAuthority;
      detail: Record<string, unknown>;
    };

export type SurgeExitDecision =
  | {
      action: "hold";
      reason: "surge_hold";
      ratio: 0;
      runnerTrailActive: boolean;
      authoritySource: SurgeDecisionAuthority;
    }
  | {
      action: "sell";
      reason: string;
      ratio: number;
      runnerTrailActive: boolean;
      authoritySource: SurgeDecisionAuthority;
    };
