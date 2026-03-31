import fs from "node:fs/promises";
import path from "node:path";
import { mvpSignalPayloadV2Schema, type SignalLogEntry } from "@orbitalpha/shared";
import { tradingDataRoot } from "./paths.js";
import { UPBIT_FEE_RATE } from "./strategy-risk-config.js";
import { fetchTickers } from "./upbit-public.js";

type PaperStateValue = "SIGNAL" | "OPEN" | "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT" | "SKIPPED";

type PaperPosition = {
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  invested_krw: number;
  buy_fee_krw: number;
  signal_strength: string;
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

const PAPER_START_KRW = 500_000;
const PAPER_ENTRY_KRW_PER_TRADE = 50_000;
const PAPER_MAX_OPEN = 3;
const PAPER_TAKE_PROFIT_PCT = 2.0;
const PAPER_STOP_LOSS_PCT = -1.5;
const PAPER_TIMEOUT_MS = 10 * 60_000;
const PAPER_HISTORY_MAX = 200;
const PAPER_SEEN_SIGNAL_MAX = 500;

function toNum(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function createPaperTradingEngine(opts: {
  companyId: string;
  serviceId: string;
  readLogs: (limit: number) => Promise<SignalLogEntry[]>;
}) {
  const baseDir = path.join(tradingDataRoot(), "paper", opts.companyId, opts.serviceId);
  const stateFile = path.join(baseDir, "paper_state.json");

  const state: {
    cashKrw: number;
    positions: Record<string, PaperPosition>;
    history: PaperTradeEvent[];
    seenSignalKeys: Set<string>;
  } = {
    cashKrw: PAPER_START_KRW,
    positions: {},
    history: [],
    seenSignalKeys: new Set<string>(),
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

  const paperBuy = (market: string, signalStrength: string, entryPrice: number): { ok: boolean; reason?: string } => {
    if (state.positions[market]) return { ok: false, reason: "already_open" };
    if (Object.keys(state.positions).length >= PAPER_MAX_OPEN) return { ok: false, reason: "max_open_positions" };
    const buyFee = PAPER_ENTRY_KRW_PER_TRADE * UPBIT_FEE_RATE;
    const totalNeed = PAPER_ENTRY_KRW_PER_TRADE + buyFee;
    if (state.cashKrw < totalNeed) return { ok: false, reason: "insufficient_cash" };
    if (!(entryPrice > 0)) return { ok: false, reason: "invalid_price" };

    const qty = PAPER_ENTRY_KRW_PER_TRADE / entryPrice;
    state.cashKrw -= totalNeed;
    state.positions[market] = {
      market,
      entry_ts: new Date().toISOString(),
      entry_price: entryPrice,
      qty,
      invested_krw: PAPER_ENTRY_KRW_PER_TRADE,
      buy_fee_krw: buyFee,
      signal_strength: signalStrength,
    };
    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: "OPEN",
      note: "paper_buy_opened",
      signal_strength: signalStrength,
      entry_price: entryPrice,
      exit_price: null,
      qty,
      pnl_krw: null,
      pnl_pct: null,
    });
    return { ok: true };
  };

  const paperSell = (market: string, exitPrice: number, closeState: "CLOSED_WIN" | "CLOSED_LOSS" | "CLOSED_TIMEOUT", note: string): { ok: boolean; reason?: string } => {
    const p = state.positions[market];
    if (!p) return { ok: false, reason: "position_not_found" };
    if (!(exitPrice > 0)) return { ok: false, reason: "invalid_price" };

    const gross = p.qty * exitPrice;
    const sellFee = gross * UPBIT_FEE_RATE;
    const netProceeds = gross - sellFee;
    const pnlKrw = netProceeds - p.invested_krw - p.buy_fee_krw;
    const pnlPct = p.invested_krw > 0 ? (pnlKrw / p.invested_krw) * 100 : 0;

    state.cashKrw += netProceeds;
    delete state.positions[market];

    appendHistory({
      ts: new Date().toISOString(),
      market,
      state: closeState,
      note,
      signal_strength: p.signal_strength,
      entry_price: p.entry_price,
      exit_price: exitPrice,
      qty: p.qty,
      pnl_krw: pnlKrw,
      pnl_pct: pnlPct,
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
    const logs = await opts.readLogs(300);
    const latestSignalByMarket = new Map<string, { key: string; ts: string; signal_strength: string }>();
    const watchMarkets = new Set<string>(Object.keys(state.positions));

    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const parsed = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!parsed.success) continue;
      const p = parsed.data;
      const market = p.market;
      const signalType = String(p.signal_type ?? "").toUpperCase();
      if (!p.filter_pass || signalType === "LOW") continue;
      const key = `${row.ts}|${market}|${signalType}`;
      if (!latestSignalByMarket.has(market)) {
        latestSignalByMarket.set(market, {
          key,
          ts: row.ts,
          signal_strength: signalType || "MID",
        });
      }
      watchMarkets.add(market);
    }

    if (watchMarkets.size === 0) {
      await persist();
      return;
    }

    const tickers = await fetchTickers([...watchMarkets]);
    const priceByMarket: Record<string, number> = {};
    for (const t of tickers) {
      const p = toNum(t.trade_price, 0);
      if (p > 0) priceByMarket[t.market] = p;
    }

    for (const [market, sig] of latestSignalByMarket.entries()) {
      if (state.seenSignalKeys.has(sig.key)) continue;
      state.seenSignalKeys.add(sig.key);

      appendHistory({
        ts: new Date().toISOString(),
        market,
        state: "SIGNAL",
        note: `signal_detected:${sig.signal_strength}`,
        signal_strength: sig.signal_strength,
        entry_price: null,
        exit_price: null,
        qty: null,
        pnl_krw: null,
        pnl_pct: null,
      });

      const px = priceByMarket[market] ?? 0;
      const b = paperBuy(market, sig.signal_strength, px);
      if (!b.ok) {
        appendHistory({
          ts: new Date().toISOString(),
          market,
          state: "SKIPPED",
          note: `entry_skipped:${b.reason ?? "unknown"}`,
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

      if (grossPct >= PAPER_TAKE_PROFIT_PCT) {
        paperSell(p.market, px, "CLOSED_WIN", "take_profit_2pct");
      } else if (grossPct <= PAPER_STOP_LOSS_PCT) {
        paperSell(p.market, px, "CLOSED_LOSS", "stop_loss_-1.5pct");
      } else if (heldMs >= PAPER_TIMEOUT_MS) {
        paperSell(p.market, px, "CLOSED_TIMEOUT", "time_exit_10m");
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

    return {
      mode: "paper_trading",
      updated_at: new Date().toISOString(),
      ...summary,
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

