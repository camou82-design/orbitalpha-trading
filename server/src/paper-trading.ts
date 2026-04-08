import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";
import { UPBIT_FEE_RATE } from "./strategy-risk-config.js";
import { fetchMinuteCandles, fetchTickers } from "./upbit-public.js";

type PaperStateValue = "SIGNAL" | "OPEN" | "PARTIAL_EXIT" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT" | "SKIPPED";

type PaperPosition = {
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  invested_krw: number;
  buy_fee_krw: number;
  signal_strength: string;
  position_stage?: "early_active" | "normal_active";
  signal_ts?: string | null;
  signal_price?: number | null;
  entry_recent_high?: number | null;
  take_profit_partial_done?: boolean;
  take_profit_second_done?: boolean;
  peak_price?: number;
  /** 진입 이후 최고 수익률(%) — 조기 실패 판단 */
  max_up_pct?: number;
  /** +3% 이상에서 러너 트레일 활성 */
  runner_trail_armed?: boolean;
  /** pump surge 2차(70%) 배분 완료 여부 */
  surge_add_leg_done?: boolean;
};

type PaperTradeEvent = {
  ts: string;
  market: string;
  state: PaperStateValue;
  note: string;
  signal_strength: string | null;
  entry_price: number | null;
  exit_price: number | null;
  qty: number | null;
  pnl_krw: number | null;
  pnl_pct: number | null;
};

type PaperStateFile = {
  cash_krw: number;
  positions: Record<string, PaperPosition>;
  history: PaperTradeEvent[];
  seen_signal_keys: string[];
};

type LifecycleState = "idle" | "pre_entry" | "entered" | "cooldown";
type MarketLifecycle = {
  state: LifecycleState;
  state_since_ts: string;
  cooldown_until_ts?: string;
  candidate_score?: number;
  last_reason?: string;
  first_seen_ts?: string;
  first_seen_price?: number;
  last_local_high?: number;
};

const PAPER_START_KRW = 500_000;
const PAPER_ENTRY_KRW_PER_TRADE = 45_000;
const PAPER_MAX_OPEN = 2;

// --- Paper entry timing (early-first) ---
const PAPER_ENTRY_SIGNAL_STALE_SECONDS = (() => {
  const raw = process.env.PAPER_ENTRY_SIGNAL_STALE_SECONDS;
  const n = raw === undefined || raw === "" ? 90 : Number(raw);
  return Number.isFinite(n) ? Math.max(15, Math.min(600, Math.floor(n))) : 90;
})();
const PAPER_MAX_CHASE_FROM_SIGNAL_PCT = (() => {
  const raw = process.env.PAPER_MAX_CHASE_FROM_SIGNAL_PCT;
  const n = raw === undefined || raw === "" ? 0.8 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(8, n)) : 0.8;
})();
/** (high-now)/high*100 < 이 값이면 고점 추격으로 간주, 진입 차단 */
const PAPER_MAX_ENTRY_NEAR_HIGH_PCT = (() => {
  const raw = process.env.PAPER_MAX_ENTRY_NEAR_HIGH_PCT;
  const n = raw === undefined || raw === "" ? 0.25 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(3, n)) : 0.25;
})();
const PAPER_EARLY_ENTRY_MAX_OPEN = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_MAX_OPEN;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n))) : 2;
})();
const PAPER_EARLY_ENTRY_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_MIN_VOLUME_RATIO;
  const n = raw === undefined || raw === "" ? 1.2 : Number(raw);
  return Number.isFinite(n) ? Math.max(1.0, Math.min(6, n)) : 1.2;
})();
const PAPER_EARLY_ENTRY_MAX_SIGNAL_SECONDS = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_MAX_SIGNAL_SECONDS;
  const n = raw === undefined || raw === "" ? 20 : Number(raw);
  return Number.isFinite(n) ? Math.max(5, Math.min(120, Math.floor(n))) : 20;
})();
const PAPER_EARLY_ENTRY_FAIL_SECONDS = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_FAIL_SECONDS;
  const n = raw === undefined || raw === "" ? 45 : Number(raw);
  return Number.isFinite(n) ? Math.max(10, Math.min(300, Math.floor(n))) : 45;
})();
const PAPER_EARLY_ENTRY_FAIL_LOSS_PCT = (() => {
  const raw = process.env.PAPER_EARLY_ENTRY_FAIL_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -0.5 : Number(raw);
  return Number.isFinite(n) ? Math.max(-5, Math.min(-0.1, n)) : -0.5;
})();
const PAPER_EARLY_PROMOTION_PCT = (() => {
  const raw = process.env.PAPER_EARLY_PROMOTION_PCT;
  const n = raw === undefined || raw === "" ? 0.4 : Number(raw);
  return Number.isFinite(n) ? Math.max(0.1, Math.min(3, n)) : 0.4;
})();
const PAPER_EARLY_PROMOTION_MAX_SECONDS = (() => {
  const raw = process.env.PAPER_EARLY_PROMOTION_MAX_SECONDS;
  const n = raw === undefined || raw === "" ? 60 : Number(raw);
  return Number.isFinite(n) ? Math.max(10, Math.min(300, Math.floor(n))) : 60;
})();
/** pump 스캐너 1차 선진입 비중 · 2차 돌파 추격 비중 */
const SURGE_EARLY_ALLOC_RATIO = 0.3;
const SURGE_ADD_ALLOC_RATIO = 0.7;
/** 스캐너 피드와 동일: 1차는 거래량 배수 > 이 값 (기본 1.2) */
const SURGE_EARLY_VOLUME_RATIO_MIN = Math.max(1.0, Number(process.env.PUMP_SCANNER_EARLY_VOLUME_RATIO_MIN ?? 1.2));
/** 진입가 대비 손절(%) — -0.5 ~ -1 구간으로 clamp, 기본 -0.75 */
const SURGE_STOP_LOSS_PCT = (() => {
  const raw = process.env.PAPER_SURGE_STOP_LOSS_PCT;
  const n = raw === undefined || raw === "" ? -0.75 : Number(raw);
  if (!Number.isFinite(n)) return -0.75;
  return Math.max(-1, Math.min(-0.5, n));
})();
const SURGE_COOLDOWN_MS = 25 * 60_000;
const SURGE_COOLDOWN_AFTER_LOSS_MS = 30 * 60_000;
const PAPER_TIMEOUT_MS = 45 * 60_000;
/** surge 후보 시간청산(백업) */
const PAPER_SURGE_SCANNER_TIMEOUT_MS = (() => {
  const raw = process.env.PAPER_SURGE_SCANNER_TIMEOUT_MINUTES;
  if (raw === undefined || raw === "") return 45 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10 && n <= 180 ? n * 60_000 : 45 * 60_000;
})();
const CANDIDATE_KEEP_MS = 3 * 60_000;
const CANDIDATE_MAX_TRACKED = 8;
const PAPER_HISTORY_MAX = 200;
const PAPER_SEEN_SIGNAL_MAX = 500;
const PAPER_BTC_NEUTRAL_ENTRY_SCALE = 0.75;
const PAPER_BTC_WEAK_ENTRY_SCALE = 0.5;

function toNum(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function paperTimeExitDeadlineMs(p: Pick<PaperPosition, "signal_strength">): number {
  return p.signal_strength === "SURGE_SCANNER" ? PAPER_SURGE_SCANNER_TIMEOUT_MS : PAPER_TIMEOUT_MS;
}

function paperTimeExitNote(p: Pick<PaperPosition, "signal_strength">): string {
  const ms = paperTimeExitDeadlineMs(p);
  const m = Math.round(ms / 60_000);
  return p.signal_strength === "SURGE_SCANNER"
    ? `time_exit_${m}m:surge_scanner`
    : `time_exit_${m}m:paper`;
}

function logPumpScannerDebug(payload: Record<string, unknown>) {
  const on =
    (process.env.DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    (process.env.ORBITALPHA_TRADING_DEBUG_LOG_ENABLED ?? "").toLowerCase() === "true" ||
    process.env.ORBITALPHA_TRADING_SCANNER_DEBUG === "1";
  if (!on) return;
  console.info(JSON.stringify({ tag: "DEBUG_PAPER_PUMP_SCANNER", ts: new Date().toISOString(), ...payload }));
}

function emitPaper(tag: string, payload: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ tag, ts: new Date().toISOString(), ...payload }));
}

export function createPaperTradingEngine(opts: {
  companyId: string;
  serviceId: string;
  getScannerSignals: () => Array<{
    market: string;
    score: number;
    status: string;
    signal_key: string;
    reason: string;
    breakout?: boolean;
    volume_multiple?: number;
    early_entry_eligible?: boolean;
    add_entry_eligible?: boolean;
  }>;
}) {
  const baseDir = path.join(tradingDataRoot(), "paper", opts.companyId, opts.serviceId);
  const stateFile = path.join(baseDir, "paper_state.json");

  const state: {
    cashKrw: number;
    positions: Record<string, PaperPosition>;
    history: PaperTradeEvent[];
    seenSignalKeys: Set<string>;
    lifecycle: Map<string, MarketLifecycle>;
    /** 스캐너 기준 진입 직전(선·추가 진입 조건 감시), 과거 candidate_pool */
    preEntryWatch: Map<string, { score: number; reason: string; status: string; detectedAt: number; signalStrength: string }>;
    metrics: {
      preEntryWatchHits: number;
      entriesOpened: number;
      entryLatencyMs: number[];
      earlyExitCount: number;
    };
  } = {
    cashKrw: PAPER_START_KRW,
    positions: {},
    history: [],
    seenSignalKeys: new Set<string>(),
    lifecycle: new Map(),
    preEntryWatch: new Map(),
    metrics: {
      preEntryWatchHits: 0,
      entriesOpened: 0,
      entryLatencyMs: [],
      earlyExitCount: 0,
    },
  };

  const trimHistoryAndSignals = () => {
    if (state.history.length > PAPER_HISTORY_MAX) state.history = state.history.slice(-PAPER_HISTORY_MAX);
    if (state.seenSignalKeys.size > PAPER_SEEN_SIGNAL_MAX) {
      const arr = Array.from(state.seenSignalKeys);
      state.seenSignalKeys = new Set(arr.slice(arr.length - PAPER_SEEN_SIGNAL_MAX));
    }
  };

  const appendHistory = (row: PaperTradeEvent) => {
    state.history.push(row);
    trimHistoryAndSignals();
  };

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    const filePayload: PaperStateFile = {
      cash_krw: state.cashKrw,
      positions: state.positions,
      history: state.history,
      seen_signal_keys: Array.from(state.seenSignalKeys),
    };
    await fs.writeFile(stateFile, JSON.stringify(filePayload, null, 2), "utf8");
  };

  const init = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, "utf8")) as Partial<PaperStateFile>;
      state.cashKrw = Math.max(0, toNum(raw.cash_krw, PAPER_START_KRW));
      state.positions = (raw.positions ?? {}) as Record<string, PaperPosition>;
      state.history = Array.isArray(raw.history) ? (raw.history as PaperTradeEvent[]) : [];
      state.seenSignalKeys = new Set(Array.isArray(raw.seen_signal_keys) ? raw.seen_signal_keys : []);
      trimHistoryAndSignals();
      for (const p of Object.values(state.positions)) {
        if (p.signal_strength !== "SURGE_SCANNER") continue;
        if (p.surge_add_leg_done !== undefined) continue;
        p.surge_add_leg_done = p.invested_krw >= PAPER_ENTRY_KRW_PER_TRADE * 0.42;
      }
    } catch {
      /* first boot */
    }
  };

  const setLifecycle = (market: string, next: LifecycleState, extra: Partial<MarketLifecycle> = {}) => {
    const prev = state.lifecycle.get(market);
    state.lifecycle.set(market, {
      state: next,
      state_since_ts: new Date().toISOString(),
      cooldown_until_ts: prev?.cooldown_until_ts,
      candidate_score: prev?.candidate_score,
      last_reason: prev?.last_reason,
      ...extra,
    });
  };

  const getLifecycle = (market: string): MarketLifecycle => {
    return state.lifecycle.get(market) ?? { state: "idle", state_since_ts: new Date().toISOString() };
  };

  const paperBuy = (
    market: string,
    signalStrength: string,
    entryPrice: number,
    note: string,
    amountKrw = PAPER_ENTRY_KRW_PER_TRADE,
  ): { ok: boolean; reason?: string } => {
    if (state.positions[market]) return { ok: false, reason: "already_open" };
    if (Object.keys(state.positions).length >= PAPER_MAX_OPEN) return { ok: false, reason: "max_open_positions" };
    const orderKrw = Math.max(5_000, amountKrw);
    const buyFee = orderKrw * UPBIT_FEE_RATE;
    const totalNeed = orderKrw + buyFee;
    if (state.cashKrw < totalNeed) return { ok: false, reason: "insufficient_cash" };
    if (!(entryPrice > 0)) return { ok: false, reason: "invalid_price" };

    const qty = orderKrw / entryPrice;
    state.cashKrw -= totalNeed;
    state.positions[market] = {
      market,
      entry_ts: new Date().toISOString(),
      entry_price: entryPrice,
      qty,
      invested_krw: orderKrw,
      buy_fee_krw: buyFee,
      signal_strength: signalStrength,
      take_profit_partial_done: false,
      take_profit_second_done: false,
      peak_price: entryPrice,
      max_up_pct: 0,
      runner_trail_armed: false,
      ...(signalStrength === "SURGE_SCANNER" ? { surge_add_leg_done: false } : {}),
    };
    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: "OPEN",
      note,
      signal_strength: signalStrength,
      entry_price: entryPrice,
      exit_price: null,
      qty,
      pnl_krw: null,
      pnl_pct: null,
    });
    const c = state.preEntryWatch.get(market);
    if (c) {
      state.metrics.entryLatencyMs.push(Date.now() - c.detectedAt);
      state.preEntryWatch.delete(market);
    }
    state.metrics.entriesOpened += 1;
    setLifecycle(market, "entered", { last_reason: note, cooldown_until_ts: undefined });
    return { ok: true };
  };

  const paperSurgeAddBuy = (
    market: string,
    entryPrice: number,
    note: string,
    amountKrw: number,
  ): { ok: boolean; reason?: string } => {
    const p = state.positions[market];
    if (!p) return { ok: false, reason: "position_not_found" };
    if (p.signal_strength !== "SURGE_SCANNER") return { ok: false, reason: "not_surge" };
    if (p.surge_add_leg_done === true) return { ok: false, reason: "add_leg_done" };
    const orderKrw = Math.max(5_000, amountKrw);
    const buyFee = orderKrw * UPBIT_FEE_RATE;
    const totalNeed = orderKrw + buyFee;
    if (state.cashKrw < totalNeed) return { ok: false, reason: "insufficient_cash" };
    if (!(entryPrice > 0)) return { ok: false, reason: "invalid_price" };

    const addQty = orderKrw / entryPrice;
    const newQty = p.qty + addQty;
    const newEntryPx = (p.entry_price * p.qty + entryPrice * addQty) / newQty;

    state.cashKrw -= totalNeed;
    p.qty = newQty;
    p.entry_price = newEntryPx;
    p.invested_krw += orderKrw;
    p.buy_fee_krw += buyFee;
    p.surge_add_leg_done = true;
    p.peak_price = Math.max(Number(p.peak_price ?? p.entry_price), entryPrice);

    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: "OPEN",
      note,
      signal_strength: p.signal_strength,
      entry_price: newEntryPx,
      exit_price: null,
      qty: addQty,
      pnl_krw: null,
      pnl_pct: null,
    });
    return { ok: true };
  };

  const paperSell = (
    market: string,
    exitPrice: number,
    closeState: "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT",
    note: string,
    ratio = 1,
  ): { ok: boolean; reason?: string } => {
    const p = state.positions[market];
    if (!p) return { ok: false, reason: "position_not_found" };
    if (!(exitPrice > 0)) return { ok: false, reason: "invalid_price" };
    const ratioClamped = Math.max(0.01, Math.min(1, ratio));
    const sellQty = p.qty * ratioClamped;
    if (!(sellQty > 0)) return { ok: false, reason: "invalid_qty" };

    const gross = sellQty * exitPrice;
    const sellFee = gross * UPBIT_FEE_RATE;
    const netProceeds = gross - sellFee;
    const investedPart = p.invested_krw * ratioClamped;
    const buyFeePart = p.buy_fee_krw * ratioClamped;
    const pnlKrw = netProceeds - investedPart - buyFeePart;
    const pnlPct = investedPart > 0 ? (pnlKrw / investedPart) * 100 : 0;

    state.cashKrw += netProceeds;
    const remainQty = p.qty - sellQty;
    if (remainQty <= 1e-12 || ratioClamped >= 0.9999) {
      delete state.positions[market];
    } else {
      p.qty = remainQty;
      p.invested_krw = Math.max(0, p.invested_krw - investedPart);
      p.buy_fee_krw = Math.max(0, p.buy_fee_krw - buyFeePart);
    }

    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: ratioClamped < 0.9999 ? "PARTIAL_EXIT" : closeState,
      note,
      signal_strength: p.signal_strength,
      entry_price: p.entry_price,
      exit_price: exitPrice,
      qty: sellQty,
      pnl_krw: pnlKrw,
      pnl_pct: pnlPct,
    });
    if (ratioClamped >= 0.9999 || !state.positions[market]) {
      const lossExit =
        closeState === "CLOSED_LOSS" ||
        note.includes("hard_stop_loss") ||
        note.includes("early_failure_cut") ||
        note.includes("surge_stop_loss");
      const cdMs = lossExit ? SURGE_COOLDOWN_AFTER_LOSS_MS : SURGE_COOLDOWN_MS;
      setLifecycle(market, "cooldown", {
        cooldown_until_ts: new Date(Date.now() + cdMs).toISOString(),
        last_reason: note,
      });
    }
    if (note.startsWith("early_exit:") || note.includes("early_failure_cut")) state.metrics.earlyExitCount += 1;
    return { ok: true };
  };

  const buildSummary = (priceByMarket: Record<string, number>) => {
    const openPositions = Object.values(state.positions);
    const holdingsEval = openPositions.reduce((acc, p) => acc + p.qty * Math.max(0, toNum(priceByMarket[p.market], 0)), 0);
    const totalAssetKrw = state.cashKrw + holdingsEval;
    const totalPnlKrw = totalAssetKrw - PAPER_START_KRW;
    const totalReturnPct = PAPER_START_KRW > 0 ? (totalPnlKrw / PAPER_START_KRW) * 100 : 0;

    let openUnrealizedPnlKrw = 0;
    for (const p of openPositions) {
      const px = Math.max(0, toNum(priceByMarket[p.market], 0));
      if (px <= 0) continue;
      const gross = p.qty * px;
      const estSellFee = gross * UPBIT_FEE_RATE;
      openUnrealizedPnlKrw += gross - estSellFee - p.invested_krw - p.buy_fee_krw;
    }

    const closed = state.history.filter((h) => h.state === "CLOSED_WIN" || h.state === "CLOSED_LOSS" || h.state === "CLOSED_TIMEOUT");
    const wins = closed.filter((h) => h.state === "CLOSED_WIN").length;
    const losses = closed.filter((h) => h.state === "CLOSED_LOSS").length;
    const timeouts = closed.filter((h) => h.state === "CLOSED_TIMEOUT").length;

    return {
      config: {
        start_krw: PAPER_START_KRW,
        entry_krw_per_trade: PAPER_ENTRY_KRW_PER_TRADE,
        max_open_positions: PAPER_MAX_OPEN,
        surge_early_alloc_ratio: SURGE_EARLY_ALLOC_RATIO,
        surge_add_alloc_ratio: SURGE_ADD_ALLOC_RATIO,
        surge_early_volume_ratio_min: SURGE_EARLY_VOLUME_RATIO_MIN,
        surge_stop_loss_pct: SURGE_STOP_LOSS_PCT,
        timeout_minutes: PAPER_TIMEOUT_MS / 60_000,
        fee_rate: UPBIT_FEE_RATE,
        /** surge_scanner 포지션 시간청산(분). 기본 30. `PAPER_SURGE_SCANNER_TIMEOUT_MINUTES` */
        surge_scanner_timeout_minutes: PAPER_SURGE_SCANNER_TIMEOUT_MS / 60_000,
      },
      account: {
        total_asset_krw: totalAssetKrw,
        cash_krw: state.cashKrw,
        holdings_eval_krw: holdingsEval,
        total_pnl_krw: totalPnlKrw,
        total_return_pct: totalReturnPct,
        open_unrealized_pnl_krw: openUnrealizedPnlKrw,
      },
      counters: {
        open_positions: openPositions.length,
        closed_wins: wins,
        closed_losses: losses,
        closed_timeouts: timeouts,
      },
    };
  };

  const tick = async () => {
    const scannerSignals = opts.getScannerSignals();
    emitPaper("DEBUG_PAPER_SIGNAL_HANDOFF", {
      scanner_signals_length: scannerSignals.length,
      markets: scannerSignals.map((s) => String((s as any)?.market ?? "")).filter((m) => m).slice(0, 50),
    });
    const latestSignalByMarket = new Map<
      string,
      {
        key: string;
        signal_strength: string;
        reason: string;
        score: number;
        status: string;
        breakout: boolean;
        volume_multiple: number;
        early_entry_eligible: boolean;
        add_entry_eligible: boolean;
      }
    >();
    const watchMarkets = new Set<string>(Object.keys(state.positions));
    watchMarkets.add("KRW-BTC");

    for (const sig of scannerSignals) {
      const market = String(sig.market ?? "").trim();
      if (!market) continue;
      const signalType = "SURGE_SCANNER";
      const key = String(sig.signal_key ?? `${market}|${sig.reason}`);
      const score = toNum(sig.score, 0);
      const status = String(sig.status ?? "");
      const reason = String(sig.reason ?? "surge_scanner");
      const prev = latestSignalByMarket.get(market);
      if (!prev || score >= prev.score) {
        latestSignalByMarket.set(market, {
          key,
          signal_strength: signalType,
          reason,
          score,
          status,
          breakout: sig.breakout === true,
          volume_multiple: toNum(sig.volume_multiple, 0),
          early_entry_eligible: sig.early_entry_eligible === true,
          add_entry_eligible: sig.add_entry_eligible === true,
        });
      }
      const life = getLifecycle(market);
      if (life.state === "cooldown" && life.cooldown_until_ts && Date.now() < Date.parse(life.cooldown_until_ts)) continue;
      if (life.state === "cooldown") setLifecycle(market, "idle");
      if (!life.first_seen_ts) {
        setLifecycle(market, life.state, {
          first_seen_ts: new Date().toISOString(),
          first_seen_price: undefined,
          last_local_high: undefined,
        });
      }
      watchMarkets.add(market);
    }

    for (const [market, c] of Array.from(state.preEntryWatch.entries())) {
      if (Date.now() - c.detectedAt > CANDIDATE_KEEP_MS) {
        state.preEntryWatch.delete(market);
        if (!state.positions[market]) setLifecycle(market, "idle");
        continue;
      }
      watchMarkets.add(market);
    }

    if (watchMarkets.size === 0) {
      await persist();
      return;
    }

    const tickers = await fetchTickers([...watchMarkets]);
    const priceByMarket: Record<string, number> = {};
    let btcChange = 0;
    for (const t of tickers) {
      const p = toNum(t.trade_price, 0);
      if (p > 0) priceByMarket[t.market] = p;
      if (t.market === "KRW-BTC") btcChange = Number(t.signed_change_rate ?? 0);
    }
    const btcTier: "strong" | "neutral" | "weak" =
      btcChange <= -0.004 ? "weak" : btcChange >= 0.002 ? "strong" : "neutral";
    const entryScale = btcTier === "weak" ? PAPER_BTC_WEAK_ENTRY_SCALE : btcTier === "neutral" ? PAPER_BTC_NEUTRAL_ENTRY_SCALE : 1;

    const orderedSignals = Array.from(latestSignalByMarket.entries()).sort((a, b) => b[1].score - a[1].score);
    emitPaper("DEBUG_PAPER_ENTRY_UNIVERSE_CREATED", {
      ordered_signals_length: orderedSignals.length,
      symbols: orderedSignals.map(([m]) => m).slice(0, 50),
    });

    // 0) Manage early-active positions: promote or fast-cut before evaluating new entries
    for (const p of Object.values(state.positions)) {
      if (p.signal_strength !== "SURGE_SCANNER") continue;
      if (p.position_stage !== "early_active") continue;
      const px = priceByMarket[p.market] ?? 0;
      if (!(px > 0)) continue;
      const heldSec = Math.max(0, Math.floor((Date.now() - Date.parse(p.entry_ts)) / 1000));
      const grossPct = ((px / p.entry_price) - 1) * 100;
      const life = getLifecycle(p.market);
      const recentHigh = Number(p.entry_recent_high ?? life.last_local_high ?? 0);
      const breakoutNow = recentHigh > 0 ? px >= recentHigh : false;
      const promoteNow = breakoutNow || grossPct >= PAPER_EARLY_PROMOTION_PCT || heldSec >= PAPER_EARLY_PROMOTION_MAX_SECONDS;
      if (promoteNow) {
        p.position_stage = "normal_active";
        emitPaper("DEBUG_PAPER_EARLY_ENTRY_EXIT", {
          market: p.market,
          early_entry_fail_triggered: false,
          exit_reason: "promoted_to_normal",
          held_seconds: heldSec,
          pnl_gross_pct: Number(grossPct.toFixed(4)),
        });
        continue;
      }
      const failByTime = heldSec >= PAPER_EARLY_ENTRY_FAIL_SECONDS;
      const failByLoss = grossPct <= PAPER_EARLY_ENTRY_FAIL_LOSS_PCT;
      if (failByTime || failByLoss) {
        emitPaper("DEBUG_PAPER_EARLY_ENTRY_EXIT", {
          market: p.market,
          early_entry_fail_triggered: true,
          exit_reason: failByLoss ? "early_fail_loss" : "early_breakout_failed",
          held_seconds: heldSec,
          pnl_gross_pct: Number(grossPct.toFixed(4)),
        });
        paperSell(p.market, px, "CLOSED_LOSS", failByLoss ? "paper_early_fail_loss" : "paper_early_breakout_failed");
      }
    }

    for (const [market, sig] of orderedSignals) {
      const px = priceByMarket[market] ?? 0;
      emitPaper("DEBUG_PAPER_PRECHECK_ENTER", {
        market,
        early_entry_eligible: sig.early_entry_eligible,
        volume_multiple: sig.volume_multiple,
        price: px,
        open_positions: Object.keys(state.positions).length,
        max_positions: PAPER_MAX_OPEN,
      });

      if (!state.seenSignalKeys.has(sig.key)) {
        state.seenSignalKeys.add(sig.key);
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SIGNAL",
          note: `signal_detected:surge_scanner:${sig.reason}`,
          signal_strength: sig.signal_strength,
          entry_price: null,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
      }

      const watchWorthy = sig.score >= 45 || sig.early_entry_eligible || sig.add_entry_eligible;
      const priorPool = state.preEntryWatch.get(market);
      if (!priorPool && watchWorthy) {
        state.preEntryWatch.set(market, {
          score: sig.score,
          reason: sig.reason,
          status: sig.status,
          detectedAt: Date.now(),
          signalStrength: sig.signal_strength,
        });
        state.metrics.preEntryWatchHits += 1;
        setLifecycle(market, "pre_entry", { candidate_score: sig.score, last_reason: sig.reason });
      }
      if (state.preEntryWatch.size > CANDIDATE_MAX_TRACKED) {
        const weakest = Array.from(state.preEntryWatch.entries()).sort((a, b) => a[1].score - b[1].score)[0]?.[0];
        if (weakest) state.preEntryWatch.delete(weakest);
      }

      const lifeEntry = getLifecycle(market);
      if (lifeEntry.cooldown_until_ts && Date.now() < Date.parse(lifeEntry.cooldown_until_ts)) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "cooldown_active", stage: "ordered_signals_loop" });
        continue;
      }

      if (state.positions[market]) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "already_open", stage: "ordered_signals_loop" });
        continue;
      }
      if (Object.keys(state.positions).length >= PAPER_MAX_OPEN) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "max_open_positions", stage: "ordered_signals_loop" });
        continue;
      }

      if (!(px > 0)) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "invalid_or_missing_price", stage: "ordered_signals_loop" });
        continue;
      }

      // Timing guard inputs (signal freshness + chase + near-high + volume fade)
      const signalTs = lifeEntry.first_seen_ts ?? null;
      const signalPrice = Number(lifeEntry.first_seen_price ?? px);
      const secondsSinceSignal = signalTs ? Math.max(0, Math.floor((Date.now() - Date.parse(signalTs)) / 1000)) : null;
      let localHigh = Number(lifeEntry.last_local_high ?? 0);
      let distanceFromLocalHighPct: number | null = null;
      let priceChangeSinceSignalPct: number | null = null;
      let volumeRatio1m5: number | null = null;
      try {
        const c1 = await fetchMinuteCandles(market, 1, 12);
        const highs = c1.map((x: any) => Number(x.high_price ?? 0)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (highs.length > 0) localHigh = Math.max(...highs);
        if (localHigh > 0) distanceFromLocalHighPct = ((localHigh - px) / localHigh) * 100;
        if (signalPrice > 0) priceChangeSinceSignalPct = ((px / signalPrice) - 1) * 100;
        if (c1.length >= 7) {
          const last = c1[c1.length - 1] as any;
          const prev5 = c1.slice(-6, -1) as any[];
          const lastNotional = Number(last.candle_acc_trade_volume ?? 0) * Number(last.trade_price ?? 0);
          const prevAvg =
            prev5.reduce((acc, r) => acc + Number(r.candle_acc_trade_volume ?? 0) * Number(r.trade_price ?? 0), 0) /
            Math.max(1, prev5.length);
          if (Number.isFinite(lastNotional) && Number.isFinite(prevAvg) && prevAvg > 0) {
            volumeRatio1m5 = lastNotional / prevAvg;
          }
        }
      } catch {
        // ignore candle failures
      }
      setLifecycle(market, lifeEntry.state, {
        first_seen_ts: signalTs ?? undefined,
        first_seen_price: signalPrice,
        last_local_high: localHigh > 0 ? localHigh : undefined,
      });

      let timingBlockReason: string | null = null;
      if (secondsSinceSignal !== null && secondsSinceSignal > PAPER_ENTRY_SIGNAL_STALE_SECONDS) timingBlockReason = "signal_stale";
      else if (priceChangeSinceSignalPct !== null && priceChangeSinceSignalPct > PAPER_MAX_CHASE_FROM_SIGNAL_PCT)
        timingBlockReason = "chase_too_high";
      else if (distanceFromLocalHighPct !== null && distanceFromLocalHighPct < PAPER_MAX_ENTRY_NEAR_HIGH_PCT)
        timingBlockReason = "near_high_entry";
      else if (volumeRatio1m5 !== null && volumeRatio1m5 < 0.65) timingBlockReason = "volume_faded";

      if (timingBlockReason) {
        emitPaper("DEBUG_PAPER_ENTRY_TIMING_GUARD", {
          market,
          reason: timingBlockReason,
          seconds_since_signal: secondsSinceSignal,
          price_change_since_signal_pct: priceChangeSinceSignalPct,
          distance_from_local_high_pct: distanceFromLocalHighPct,
          volume_ratio: volumeRatio1m5,
        });
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: `timing_guard:${timingBlockReason}`, stage: "ordered_signals_loop" });
        continue;
      }

      // 1) Early entry first (aggressive)
      const earlyMinScoreDefault = Math.max(0, sig.score - 10);
      const earlyMinScore = (() => {
        const raw = process.env.PAPER_EARLY_ENTRY_MIN_SCORE;
        const n = raw === undefined || raw === "" ? earlyMinScoreDefault : Number(raw);
        return Number.isFinite(n) ? n : earlyMinScoreDefault;
      })();
      const earlySlotsUsed = Object.values(state.positions).filter((p) => p.position_stage === "early_active").length;
      const earlySlotOk = earlySlotsUsed < PAPER_EARLY_ENTRY_MAX_OPEN;
      const earlyFreshOk = secondsSinceSignal !== null && secondsSinceSignal <= PAPER_EARLY_ENTRY_MAX_SIGNAL_SECONDS;
      const earlyNearHighOk = distanceFromLocalHighPct !== null && distanceFromLocalHighPct <= PAPER_MAX_ENTRY_NEAR_HIGH_PCT;
      const earlyVolOk = volumeRatio1m5 !== null && volumeRatio1m5 >= PAPER_EARLY_ENTRY_MIN_VOLUME_RATIO;
      const earlyScoreOk = sig.score >= earlyMinScore;
      const earlyAllowed = earlySlotOk && earlyFreshOk && earlyNearHighOk && earlyVolOk && earlyScoreOk;

      emitPaper("DEBUG_PAPER_EARLY_ENTRY_DECISION", {
        market,
        seconds_since_signal: secondsSinceSignal,
        price_change_since_signal_pct: priceChangeSinceSignalPct,
        distance_from_local_high_pct: distanceFromLocalHighPct,
        volume_ratio: volumeRatio1m5,
        early_entry_allowed: earlyAllowed,
        early_entry_block_reason: earlyAllowed
          ? null
          : !earlySlotOk
            ? "early_slot_full"
            : !earlyFreshOk
              ? "signal_not_fresh"
              : !earlyNearHighOk
                ? "near_high_requirement_failed"
                : !earlyVolOk
                  ? "volume_not_strong"
                  : !earlyScoreOk
                    ? "score_too_low"
                    : "unknown",
      });

      if (earlyAllowed) {
        const earlyAmount = Math.max(5_000, Math.floor(PAPER_ENTRY_KRW_PER_TRADE * 0.4 * entryScale));
        emitPaper("DEBUG_PAPER_ORDER_ATTEMPT", { market, order_krw: earlyAmount, stage: "paper_early_entry" });
        const b = paperBuy(market, "SURGE_SCANNER", px, "paper_early_entry", earlyAmount);
        if (b.ok) {
          const filled = (state.positions as any)[market] as any;
          if (filled) {
            filled.position_stage = "early_active";
            filled.signal_ts = signalTs;
            filled.signal_price = signalPrice;
            filled.entry_recent_high = localHigh > 0 ? localHigh : null;
          }
          emitPaper("DEBUG_PAPER_EARLY_ENTRY_FILLED", {
            market,
            order_krw: earlyAmount,
            qty: Number(filled?.qty ?? 0),
            price: px,
            seconds_since_signal: secondsSinceSignal,
            volume_ratio: volumeRatio1m5,
          });
          continue;
        }
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: `paperBuy:${b.reason ?? "unknown"}`, stage: "paper_early_entry" });
      }

      // 2) normal entry fallback (only if early not allowed)
      const volOkLegacy = sig.volume_multiple > SURGE_EARLY_VOLUME_RATIO_MIN;
      if (!sig.early_entry_eligible || !volOkLegacy) {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: "early_not_ok_and_no_normal_path", stage: "ordered_signals_loop" });
        continue;
      }

      const earlyAmount = Math.max(5_000, Math.floor(PAPER_ENTRY_KRW_PER_TRADE * SURGE_EARLY_ALLOC_RATIO * entryScale));
      const earlyNote = `early_entry:surge_30pct|vr=${sig.volume_multiple.toFixed(3)}|score=${sig.score}|btc_scale=${entryScale}`;
      emitPaper("DEBUG_PAPER_ORDER_ATTEMPT", { market, order_krw: earlyAmount, stage: "legacy_early_entry" });
      const b = paperBuy(market, sig.signal_strength, px, earlyNote, earlyAmount);
      if (b.ok) {
        const filled = (state.positions as any)[market] as any;
        emitPaper("DEBUG_PAPER_ORDER_FILLED", {
          market,
          qty: Number(filled?.qty ?? 0),
          price: Number(filled?.entry_price ?? px),
          stage: "early_entry",
        });
        logPumpScannerDebug({
          early_entry_triggered: true,
          market,
          price: px,
          volume_multiple: sig.volume_multiple,
          score: sig.score,
          early_krw: earlyAmount,
        });
      } else {
        emitPaper("DEBUG_PAPER_BLOCK_REASON", { market, reason: b.reason ?? "unknown", stage: "paperBuy" });
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: `early_entry_blocked:${b.reason ?? "unknown"}`,
          signal_strength: sig.signal_strength,
          entry_price: px,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
      }
    }

    const trySurgeAddLegs = () => {
      for (const p of Object.values(state.positions)) {
        if (p.signal_strength !== "SURGE_SCANNER") continue;
        if (p.surge_add_leg_done === true) continue;
        const sig = latestSignalByMarket.get(p.market);
        if (!sig?.add_entry_eligible) continue;
        const px = priceByMarket[p.market] ?? 0;
        if (!(px > 0)) continue;
        const addAmount = Math.max(5_000, Math.floor(PAPER_ENTRY_KRW_PER_TRADE * SURGE_ADD_ALLOC_RATIO * entryScale));
        const addNote = `add_entry:surge_70pct|score=${sig.score}|btc_scale=${entryScale}|${sig.breakout ? "high20" : "box_top"}`;
        const r = paperSurgeAddBuy(p.market, px, addNote, addAmount);
        if (r.ok) {
          logPumpScannerDebug({
            add_entry_triggered: true,
            market: p.market,
            price: px,
            score: sig.score,
            add_krw: addAmount,
            entry_vwap: state.positions[p.market]?.entry_price,
          });
        }
      }
    };
    trySurgeAddLegs();

    for (const p of Object.values(state.positions)) {
      const px = priceByMarket[p.market] ?? 0;
      if (!(px > 0)) continue;
      const grossPct = ((px / p.entry_price) - 1) * 100;
      const heldMs = Date.now() - Date.parse(p.entry_ts);
      p.peak_price = Math.max(Number(p.peak_price ?? p.entry_price), px);
      p.max_up_pct = Math.max(p.max_up_pct ?? grossPct, grossPct);

      if (p.signal_strength === "SURGE_SCANNER") {
        if (grossPct <= SURGE_STOP_LOSS_PCT) {
          logPumpScannerDebug({
            stop_loss_triggered: true,
            market: p.market,
            price: px,
            entry_price: p.entry_price,
            gross_pct: Number(grossPct.toFixed(4)),
            stop_loss_pct: SURGE_STOP_LOSS_PCT,
          });
          paperSell(p.market, px, "CLOSED_LOSS", `surge_stop_loss:${SURGE_STOP_LOSS_PCT}`);
          continue;
        }
        if (heldMs >= paperTimeExitDeadlineMs(p)) {
          paperSell(p.market, px, "CLOSED_TIMEOUT", paperTimeExitNote(p));
        }
        continue;
      }

      if (grossPct <= -2.5) {
        paperSell(p.market, px, "CLOSED_LOSS", "hard_stop_loss");
        continue;
      }
      if (heldMs >= 6 * 60_000 && (p.max_up_pct ?? 0) < 0.25 && grossPct <= -1.2) {
        paperSell(p.market, px, "CLOSED_LOSS", "early_failure_cut");
        continue;
      }
      if (!p.take_profit_partial_done && grossPct >= 1.5) {
        const r = paperSell(p.market, px, "CLOSED_WIN", "partial_take_profit", 0.4);
        if (r.ok && state.positions[p.market]) {
          state.positions[p.market]!.take_profit_partial_done = true;
          state.positions[p.market]!.runner_trail_armed = false;
        }
        continue;
      }
      if (p.take_profit_partial_done) {
        if (grossPct >= 3.0) {
          p.runner_trail_armed = true;
        }
        const peak = Number(p.peak_price ?? 0);
        if (p.runner_trail_armed && peak > 0) {
          const ddFromPeak = ((peak - px) / peak) * 100;
          if (ddFromPeak >= 1.2) {
            paperSell(p.market, px, "CLOSED_WIN", "runner_trailing_exit");
            continue;
          }
        }
      }
      if (heldMs >= paperTimeExitDeadlineMs(p)) {
        paperSell(p.market, px, "CLOSED_TIMEOUT", paperTimeExitNote(p));
      }
    }

    await persist();
  };

  const status = async () => {
    const watchMarkets = Object.keys(state.positions);
    const tickerRows = watchMarkets.length > 0 ? await fetchTickers(watchMarkets) : [];
    const priceByMarket: Record<string, number> = {};
    for (const t of tickerRows) {
      const p = toNum(t.trade_price, 0);
      if (p > 0) priceByMarket[t.market] = p;
    }
    const summary = buildSummary(priceByMarket);
    const avgEntryLatencyMs =
      state.metrics.entryLatencyMs.length > 0
        ? state.metrics.entryLatencyMs.reduce((a, b) => a + b, 0) / state.metrics.entryLatencyMs.length
        : 0;
    const closed = state.history.filter((h) => h.state === "CLOSED_WIN" || h.state === "CLOSED_LOSS" || h.state === "CLOSED_TIMEOUT");
    const wins = closed.filter((h) => (h.pnl_krw ?? 0) > 0).map((h) => Number(h.pnl_krw ?? 0));
    const losses = closed.filter((h) => (h.pnl_krw ?? 0) < 0).map((h) => Math.abs(Number(h.pnl_krw ?? 0)));
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

    return {
      mode: "paper_trading",
      updated_at: new Date().toISOString(),
      ...summary,
      execution_metrics: {
        pre_entry_watch_hits: state.metrics.preEntryWatchHits,
        entry_count: state.metrics.entriesOpened,
        entries_opened: state.metrics.entriesOpened,
        avg_entry_latency_sec: Number((avgEntryLatencyMs / 1000).toFixed(2)),
        early_exit_ratio:
          closed.length > 0 ? Number((state.metrics.earlyExitCount / closed.length).toFixed(4)) : 0,
        avg_win_loss_ratio: Number(avgWinLossRatio.toFixed(3)),
        active_pre_entry_watch_count: state.preEntryWatch.size,
        tracked_pre_entry_watch: state.preEntryWatch.size,
      },
      holdings: Object.values(state.positions).map((p) => {
        const px = priceByMarket[p.market] ?? 0;
        const evalKrw = p.qty * px;
        const estSellFee = evalKrw * UPBIT_FEE_RATE;
        const pnlKrw = evalKrw - estSellFee - p.invested_krw - p.buy_fee_krw;
        const pnlPct = p.invested_krw > 0 ? (pnlKrw / p.invested_krw) * 100 : 0;
        return {
          market: p.market,
          entry_ts: p.entry_ts,
          entry_price: p.entry_price,
          current_price: px,
          qty: p.qty,
          invested_krw: p.invested_krw,
          unrealized_pnl_krw: pnlKrw,
          unrealized_pnl_pct: pnlPct,
          signal_strength: p.signal_strength,
        };
      }),
      recent_history: state.history.slice(-40).reverse(),
      files: { state: stateFile },
    };
  };

  return {
    init,
    tick,
    status,
    paperBuy,
    paperSell,
  };
}

