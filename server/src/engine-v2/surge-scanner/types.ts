import type { UpbitCandle, UpbitTicker } from "../../upbit-public.js";

export type Engine2SurgeCandidate = {
  market: string;
  scanner_score: number;
  volume_multiple: number;
  breakout: boolean;
  close_upper_hold: boolean;
  rise_3m_pct: number;
  signal_ts: string;
  updated_at: string;
  source_kind: "engine2_surge_scanner";
};

export type Engine2SurgeCandidatesFile = {
  kind: "surge_candidates_engine2";
  engine: "engine2_surge_scanner";
  updated_at: string;
  items: Engine2SurgeCandidate[];
};

export type Engine2EvalInput = {
  market: string;
  ticker: UpbitTicker;
  candles1m: UpbitCandle[];
};

