import fs from "node:fs/promises";
import path from "node:path";
import { tradingDataRoot } from "./paths.js";
import { evaluateMvpSignal } from "./signal-engine.js";
import { UPBIT_FEE_RATE } from "./strategy-risk-config.js";
import { fetchMinuteCandles, fetchTickers } from "./upbit-public.js";

/**
 * Paper trading 전용 MVP 거래량 메인 임계 (signal-monitor·실거래는 env `ORBITALPHA_TRADING_VOLUME_THRESHOLD_MAIN` 기본 1.15 유지).
 * 이 모듈에서만 사용 — 공용 env 기본값을 바꾸지 않음.
 */
const PAPER_VOLUME_THRESHOLD_MAIN = (() => {
  const raw = process.env.ORBITALPHA_TRADING_PAPER_VOLUME_THRESHOLD_MAIN;
  if (raw === undefined || raw === "") return 0.85;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.85;
})();

type PaperStateValue = "SIGNAL" | "OPEN" | "PARTIAL_EXIT" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT" | "SKIPPED";

type PaperPosition = {
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  invested_krw: number;
  buy_fee_krw: number;
  signal_strength: string;
  take_profit_partial_done?: boolean;
  take_profit_second_done?: boolean;
  peak_price?: number;
  dca_count?: number;
  xrp_recovery_partial_done?: boolean;
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

type LifecycleState = "idle" | "candidate" | "entered" | "cooldown";
type MarketLifecycle = {
  state: LifecycleState;
  state_since_ts: string;
  cooldown_until_ts?: string;
  candidate_score?: number;
  last_reason?: string;
};

const PAPER_START_KRW = 500_000;
const PAPER_ENTRY_KRW_PER_TRADE = 45_000;
const PAPER_PROBE_ENTRY_KRW = 20_000;
const PAPER_MAX_OPEN = 3;
const PAPER_TAKE_PROFIT_PCT = 2.8;
const PAPER_STOP_LOSS_PCT = -1.0;
const PAPER_TAKE_PROFIT_PARTIAL_PCT = 1.5;
const PAPER_TAKE_PROFIT_FINAL_PCT = 3.0;
const PAPER_TIMEOUT_MS = 10 * 60_000;
/** surge_scanner 진입만 — 급등 후 추격 진입 시 10분 청산이 TP(1.5%/3%)·SL 전에 도달해 전부 TIMEOUT 되는 경우 완화. paper 전용. */
const PAPER_SURGE_SCANNER_TIMEOUT_MS = (() => {
  const raw = process.env.PAPER_SURGE_SCANNER_TIMEOUT_MINUTES;
  if (raw === undefined || raw === "") return 30 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10 && n <= 180 ? n * 60_000 : 30 * 60_000;
})();
const PAPER_EARLY_EXIT_MIN_MS = 2 * 60_000;
const PAPER_EARLY_EXIT_STRENGTH_BREAK_PCT = -0.45;
const PAPER_TRAILING_AFTER_TP2_DRAWDOWN_PCT = 1.0;
const CANDIDATE_KEEP_MS = 3 * 60_000;
const CANDIDATE_REEVAL_COOLDOWN_LOSS_MS = 3 * 60_000;
const CANDIDATE_REEVAL_COOLDOWN_WIN_MS = 2 * 60_000;
const CANDIDATE_MAX_TRACKED = 8;
const XRP_DCA_TRIGGER_1_PCT = -2.0;
const XRP_DCA_TRIGGER_2_PCT = -4.0;
const XRP_DCA_MAX_COUNT = 2;
const XRP_DCA_BUY_KRW = 25_000;
const XRP_RECOVERY_EXIT_MIN_PCT = 0;
const XRP_RECOVERY_EXIT_MAX_PCT = 1.0;
const XRP_RECOVERY_PARTIAL_MINUTES = 25;
const XRP_RECOVERY_PARTIAL_PCT = -0.6;
const XRP_RECOVERY_FULL_MINUTES = 40;
const XRP_RECOVERY_FULL_PCT = -0.2;
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

export function createPaperTradingEngine(opts: {
  companyId: string;
  serviceId: string;
  getScannerSignals: () => Array<{
    market: string;
    score: number;
    status: string;
    signal_key: string;
    reason: string;
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
    candidatePool: Map<string, { score: number; reason: string; status: string; detectedAt: number; signalStrength: string }>;
    metrics: {
      candidateCaptured: number;
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
    candidatePool: new Map(),
    metrics: {
      candidateCaptured: 0,
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
      dca_count: 0,
      xrp_recovery_partial_done: false,
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
    const c = state.candidatePool.get(market);
    if (c) {
      state.metrics.entryLatencyMs.push(Date.now() - c.detectedAt);
      state.candidatePool.delete(market);
    }
    state.metrics.entriesOpened += 1;
    setLifecycle(market, "entered", { last_reason: note });
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
      const cd = closeState === "CLOSED_LOSS" ? CANDIDATE_REEVAL_COOLDOWN_LOSS_MS : CANDIDATE_REEVAL_COOLDOWN_WIN_MS;
      setLifecycle(market, "cooldown", {
        cooldown_until_ts: new Date(Date.now() + cd).toISOString(),
        last_reason: note,
      });
    }
    if (note.startsWith("early_exit:")) state.metrics.earlyExitCount += 1;
    return { ok: true };
  };

  const paperDcaBuyXrp = (p: PaperPosition, currentPrice: number): { ok: boolean; reason?: string } => {
    if (p.market !== "KRW-XRP") return { ok: false, reason: "not_xrp" };
    if (!(currentPrice > 0)) return { ok: false, reason: "invalid_price" };
    const dcaCount = p.dca_count ?? 0;
    if (dcaCount >= XRP_DCA_MAX_COUNT) return { ok: false, reason: "dca_max_reached" };

    const grossPct = ((currentPrice / p.entry_price) - 1) * 100;
    const trigger =
      dcaCount === 0 ? XRP_DCA_TRIGGER_1_PCT : dcaCount === 1 ? XRP_DCA_TRIGGER_2_PCT : -999;
    if (grossPct > trigger) return { ok: false, reason: "trigger_not_met" };

    const buyFee = XRP_DCA_BUY_KRW * UPBIT_FEE_RATE;
    const totalNeed = XRP_DCA_BUY_KRW + buyFee;
    if (state.cashKrw < totalNeed) return { ok: false, reason: "insufficient_cash" };

    const addQty = XRP_DCA_BUY_KRW / currentPrice;
    const prevQty = p.qty;
    const nextQty = prevQty + addQty;
    const nextAvg = nextQty > 0 ? ((p.entry_price * prevQty) + (currentPrice * addQty)) / nextQty : p.entry_price;

    state.cashKrw -= totalNeed;
    p.qty = nextQty;
    p.entry_price = nextAvg;
    p.invested_krw += XRP_DCA_BUY_KRW;
    p.buy_fee_krw += buyFee;
    p.dca_count = dcaCount + 1;

    appendHistory({
      ts: new Date().toISOString(),
      market: p.market,
      state: "OPEN",
      note: p.dca_count === 1 ? "dca_buy_1" : "dca_buy_2",
      signal_strength: p.signal_strength,
      entry_price: currentPrice,
      exit_price: null,
      qty: addQty,
      pnl_krw: null,
      pnl_pct: null,
    });
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
        take_profit_pct: PAPER_TAKE_PROFIT_PCT,
        stop_loss_pct: PAPER_STOP_LOSS_PCT,
        timeout_minutes: PAPER_TIMEOUT_MS / 60_000,
        fee_rate: UPBIT_FEE_RATE,
        /** Paper 전용 — `evaluateMvpSignal` 주입값 (실거래·signal-monitor와 분리) */
        paper_volume_threshold_main: PAPER_VOLUME_THRESHOLD_MAIN,
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
    const latestSignalByMarket = new Map<
      string,
      {
        key: string;
        signal_strength: string;
        reason: string;
        score: number;
        status: string;
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
        });
      }
      const life = getLifecycle(market);
      if (life.state === "cooldown" && life.cooldown_until_ts && Date.now() < Date.parse(life.cooldown_until_ts)) continue;
      if (life.state === "cooldown") setLifecycle(market, "idle");
      watchMarkets.add(market);
    }

    // Keep strong candidates for a short window and re-evaluate quickly without re-scanning whole market.
    for (const [market, c] of Array.from(state.candidatePool.entries())) {
      if (Date.now() - c.detectedAt > CANDIDATE_KEEP_MS) {
        state.candidatePool.delete(market);
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
    for (const [market, sig] of orderedSignals) {
      if (state.seenSignalKeys.has(sig.key)) continue;
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

      const px = priceByMarket[market] ?? 0;
      const scoreOk = sig.score >= 60;
      const reasonLower = sig.reason.toLowerCase();
      const signalState = reasonLower.includes("breakout_confirmed")
        ? "돌파"
        : reasonLower.includes("upper_hold_confirmed")
          ? "상단유지"
          : "기타";
      const isCandidateWatch = reasonLower.includes("candidate_watch");
      const isBreakout = signalState === "돌파";

      if (!scoreOk) {
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: "entry_blocked:score_below_60",
          signal_strength: sig.signal_strength,
          entry_price: px > 0 ? px : null,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
        continue;
      }
      if (!isBreakout && !isCandidateWatch) {
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: "entry_blocked:state_not_breakout",
          signal_strength: sig.signal_strength,
          entry_price: px > 0 ? px : null,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
        continue;
      }

      const prior = state.candidatePool.get(market);
      if (!prior) {
        state.candidatePool.set(market, {
          score: sig.score,
          reason: sig.reason,
          status: sig.status,
          detectedAt: Date.now(),
          signalStrength: sig.signal_strength,
        });
        state.metrics.candidateCaptured += 1;
        setLifecycle(market, "candidate", { candidate_score: sig.score, last_reason: sig.reason });
      }
      if (state.candidatePool.size > CANDIDATE_MAX_TRACKED) {
        const weakest = Array.from(state.candidatePool.entries()).sort((a, b) => a[1].score - b[1].score)[0]?.[0];
        if (weakest) state.candidatePool.delete(weakest);
      }

      if (Object.keys(state.positions).length >= PAPER_MAX_OPEN) continue;

      const candles5 = await fetchMinuteCandles(market, 5, 42);
      const candles1 = await fetchMinuteCandles(market, 1, 30);
      const mvpEv = evaluateMvpSignal(market, candles5, candles1, {
        volumeThresholdMain: PAPER_VOLUME_THRESHOLD_MAIN,
      });
      if (!mvpEv.filter_pass) {
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: `entry_blocked:paper_mvp_filter:paper_vol_main=${PAPER_VOLUME_THRESHOLD_MAIN}:vr=${mvpEv.volume_ratio.toFixed(4)}:${mvpEv.filter_fail_reason ?? "filter_pass"}`,
          signal_strength: sig.signal_strength,
          entry_price: px > 0 ? px : null,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
        continue;
      }

      const entryAmountBase = isBreakout ? PAPER_ENTRY_KRW_PER_TRADE : PAPER_PROBE_ENTRY_KRW;
      const entryAmount = Math.max(5_000, Math.floor(entryAmountBase * entryScale));

      const entryNote = isBreakout
        ? `paper_buy_opened:surge_scanner:breakout_confirmed:paper_mvp_ok:paper_vol_main_${PAPER_VOLUME_THRESHOLD_MAIN}:btc_risk_scaled_${entryScale}`
        : `paper_buy_opened:surge_scanner:candidate_probe:paper_mvp_ok:paper_vol_main_${PAPER_VOLUME_THRESHOLD_MAIN}:btc_risk_scaled_${entryScale}`;
      const b = paperBuy(market, sig.signal_strength, px, entryNote, entryAmount);
      if (!b.ok) {
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: `entry_blocked:${b.reason ?? "unknown"}`,
          signal_strength: sig.signal_strength,
          entry_price: px > 0 ? px : null,
          exit_price: null,
          qty: null,
          pnl_krw: null,
          pnl_pct: null,
        });
      }
    }

    for (const p of Object.values(state.positions)) {
      const px = priceByMarket[p.market] ?? 0;
      if (!(px > 0)) continue;
      const grossPct = ((px / p.entry_price) - 1) * 100;
      const heldMs = Date.now() - Date.parse(p.entry_ts);
      const heldMinutes = heldMs / 60_000;
      p.peak_price = Math.max(Number(p.peak_price ?? p.entry_price), px);

      if (p.market === "KRW-XRP") {
        void paperDcaBuyXrp(p, px);
        const grossPctAfterDca = ((px / p.entry_price) - 1) * 100;

        if (grossPctAfterDca >= XRP_RECOVERY_EXIT_MIN_PCT && grossPctAfterDca <= XRP_RECOVERY_EXIT_MAX_PCT) {
          paperSell(p.market, px, "CLOSED_TIMEOUT", "recovery_exit");
          continue;
        }
        if (
          heldMinutes >= XRP_RECOVERY_PARTIAL_MINUTES &&
          !p.xrp_recovery_partial_done &&
          grossPctAfterDca >= XRP_RECOVERY_PARTIAL_PCT
        ) {
          const r = paperSell(p.market, px, "CLOSED_TIMEOUT", "recovery_exit_partial", 0.5);
          if (r.ok && state.positions[p.market]) state.positions[p.market]!.xrp_recovery_partial_done = true;
          continue;
        }
        if (heldMinutes >= XRP_RECOVERY_FULL_MINUTES && grossPctAfterDca >= XRP_RECOVERY_FULL_PCT) {
          paperSell(p.market, px, "CLOSED_TIMEOUT", "recovery_exit");
          continue;
        }
        if (heldMs >= paperTimeExitDeadlineMs(p)) {
          paperSell(p.market, px, "CLOSED_TIMEOUT", paperTimeExitNote(p));
        }
        continue;
      }

      if (grossPct <= PAPER_STOP_LOSS_PCT) {
        paperSell(p.market, px, "CLOSED_LOSS", "stop_loss_-1.0pct");
      } else if (!p.take_profit_partial_done && grossPct >= PAPER_TAKE_PROFIT_PARTIAL_PCT) {
        const r = paperSell(p.market, px, "CLOSED_TIMEOUT", "take_profit_partial_1.5pct", 0.5);
        if (r.ok && state.positions[p.market]) state.positions[p.market]!.take_profit_partial_done = true;
      } else if (p.take_profit_partial_done && !p.take_profit_second_done && grossPct >= PAPER_TAKE_PROFIT_FINAL_PCT) {
        const r = paperSell(p.market, px, "CLOSED_TIMEOUT", "take_profit_additional_3.0pct", 0.5);
        if (r.ok && state.positions[p.market]) state.positions[p.market]!.take_profit_second_done = true;
      } else if (
        heldMs >= PAPER_EARLY_EXIT_MIN_MS &&
        grossPct <= PAPER_EARLY_EXIT_STRENGTH_BREAK_PCT
      ) {
        paperSell(p.market, px, "CLOSED_LOSS", "early_exit:strength_breakdown");
      } else if (
        p.take_profit_second_done &&
        p.peak_price &&
        p.peak_price > 0 &&
        ((p.peak_price - px) / p.peak_price) * 100 >= PAPER_TRAILING_AFTER_TP2_DRAWDOWN_PCT
      ) {
        paperSell(p.market, px, "CLOSED_WIN", "trailing_exit_after_tp2");
      } else if (heldMs >= paperTimeExitDeadlineMs(p)) {
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
        candidate_capture_count: state.metrics.candidateCaptured,
        entry_count: state.metrics.entriesOpened,
        entries_opened: state.metrics.entriesOpened,
        avg_entry_latency_sec: Number((avgEntryLatencyMs / 1000).toFixed(2)),
        early_exit_ratio:
          closed.length > 0 ? Number((state.metrics.earlyExitCount / closed.length).toFixed(4)) : 0,
        avg_win_loss_ratio: Number(avgWinLossRatio.toFixed(3)),
        active_candidates_count: state.candidatePool.size,
        tracked_candidates: state.candidatePool.size,
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

