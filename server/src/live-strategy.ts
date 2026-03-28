import fs from "node:fs/promises";
import path from "node:path";
import type { SignalLogEntry } from "@orbitalpha/shared";
import { mvpSignalPayloadV2Schema } from "@orbitalpha/shared";
import { tradingDataRoot } from "./paths.js";
import { fetchMinuteCandles, fetchTickers } from "./upbit-public.js";
import { STRATEGY_RISK_CONFIG, UPBIT_FEE_RATE, type StopTriggerKind, type StrategyType } from "./strategy-risk-config.js";

type TradeApi = {
  status: () => Promise<any>;
  placeBuy: (
    market: string,
    confirm: boolean,
    amountKrw?: number,
    strategyType?: StrategyType,
    bucket?: "strategy" | "legacy",
    signalPayload?: unknown,
  ) => Promise<any>;
  placeSell: (market: string, confirm: boolean, ratio?: number) => Promise<any>;
  placeLegacyDcaBuy?: (market: string, confirm: boolean, amountKrw?: number, signalPayload?: unknown) => Promise<any>;
  placeLegacyExitSell?: (market: string, confirm: boolean, ratio?: number) => Promise<any>;
  setAutoTradeEnabled?: (enabled: boolean) => Promise<void>;
};

type MarketStateApi = {
  evaluate: () => Promise<{
    market_state: "risk_on" | "neutral" | "risk_off";
    min_entry_score: number;
    market_bonus: number;
  }>;
  entryGate: (
    payload: unknown,
    s: { market_state: "risk_on" | "neutral" | "risk_off"; min_entry_score: number; market_bonus: number; [k: string]: unknown },
  ) => { ok: boolean; reason?: string; score: number };
};

type StrategyPosition = {
  strategy_type: StrategyType;
  market: string;
  entry_ts: string;
  entry_price: number;
  qty: number;
  order_krw: number;
  reason_enter: string;
  signal_strength: string;
  volume_ratio: number;
  partial_tp_done: boolean;
  max_pnl_pct: number;
  breakeven_armed: boolean;
  highest_price_after_entry: number;
  trailing_stop_price: number;
  realized_partial_profit: number;
  remaining_qty: number;
  current_net_pnl_pct: number;
  breakeven_armed_at: string | null;
  partial_tp_at: string | null;
};

type StrategyTradeRow = {
  timestamp: string;
  entry_ts: string;
  market: string;
  action: "buy" | "sell";
  order_krw: number;
  filled_qty: number;
  avg_buy_price: number;
  exit_price: number | null;
  pnl_krw: number;
  pnl_pct: number;
  reason_enter: string;
  reason_exit: string;
  holding_minutes: number;
  signal_strength: string;
  volume_ratio: number;
  strategy_tag: "live_data_mode_v1";
  strategy_type: StrategyType;
  stop_trigger_kind: StopTriggerKind | null;
  current_net_pnl_pct: number;
  liquidation_reason: string;
  remaining_qty: number;
  highest_price_after_entry: number;
  trailing_stop_price: number;
  breakeven_armed_at: string | null;
  partial_tp_at: string | null;
};

type DailyStats = {
  date: string;
  entry_count: number;
  loss_pct: number;
  stop_by_market: Record<string, number>;
};

type PersistedState = {
  positions: Record<string, StrategyPosition>;
  trades: StrategyTradeRow[];
  daily: DailyStats;
  cooldown_until: Record<string, string>;
  safety_guard: {
    state: "정상" | "주의" | "자동정지";
    reason: string | null;
    order_fail_count_today: number;
    consecutive_losses: number;
    max_positions: number;
  };
  legacy: {
    dca_count: Record<string, number>;
    dca_locked: Record<string, boolean>;
    next_dca_at: Record<string, string>;
    exit_stage: Record<string, 0 | 1 | 2>;
  };
};

const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-TRX"] as const;

function todayKst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

function minutesSince(ts: string) {
  return Math.max(0, (Date.now() - Date.parse(ts)) / 60_000);
}

function netPnlPct(entryPrice: number, nowPrice: number): number {
  if (entryPrice <= 0 || nowPrice <= 0) return 0;
  const grossSell = nowPrice;
  const principal = entryPrice;
  const buyFee = principal * UPBIT_FEE_RATE;
  const sellFee = grossSell * UPBIT_FEE_RATE;
  const net = grossSell - principal - buyFee - sellFee;
  return (net / principal) * 100;
}

export function createLiveDataStrategy(opts: {
  companyId: string;
  serviceId: string;
  readLogs: (limit: number) => Promise<SignalLogEntry[]>;
  trade: TradeApi;
  marketState: MarketStateApi;
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
  }) => Promise<void>;
}) {
  const baseDir = path.join(tradingDataRoot(), "strategy", opts.companyId, opts.serviceId);
  const tradesFile = path.join(baseDir, "live_strategy_trades.json");
  const dailyFile = path.join(baseDir, "live_strategy_daily_stats.json");
  const state: PersistedState = {
    positions: {},
    trades: [],
    daily: { date: todayKst(), entry_count: 0, loss_pct: 0, stop_by_market: {} },
    cooldown_until: {},
    safety_guard: {
      state: "주의",
      reason: "state_restore_pending",
      order_fail_count_today: 0,
      consecutive_losses: 0,
      max_positions: 2,
    },
    legacy: {
      dca_count: {},
      dca_locked: {},
      next_dca_at: {},
      exit_stage: {},
    },
  };

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(tradesFile, JSON.stringify(state.trades, null, 2), "utf8");
    await fs.writeFile(
      dailyFile,
      JSON.stringify({ daily: state.daily, positions: state.positions, cooldown_until: state.cooldown_until, safety_guard: state.safety_guard, legacy: state.legacy }, null, 2),
      "utf8",
    );
  };

  const restore = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    try {
      state.trades = JSON.parse(await fs.readFile(tradesFile, "utf8"));
    } catch {}
    try {
      const d = JSON.parse(await fs.readFile(dailyFile, "utf8"));
      state.daily = d.daily ?? state.daily;
      state.positions = d.positions ?? state.positions;
      state.cooldown_until = d.cooldown_until ?? state.cooldown_until;
      state.safety_guard = d.safety_guard ?? state.safety_guard;
      state.legacy = d.legacy ?? state.legacy;
    } catch {}
    state.safety_guard.state = "정상";
    state.safety_guard.reason = null;
  };

  const summarize = () => {
    const sells = state.trades.filter((t) => t.action === "sell" && t.filled_qty > 0);
    const wins = sells.filter((t) => t.pnl_krw > 0).length;
    const tpCount = sells.filter((t) => t.reason_exit.startsWith("tp")).length;
    const slCount = sells.filter((t) => t.reason_exit.includes("stop")).length;
    const avgHold = sells.length > 0 ? sells.reduce((a, b) => a + b.holding_minutes, 0) / sells.length : 0;
    const pnl = sells.reduce((a, b) => a + b.pnl_krw, 0);
    const usedKrw = Object.values(state.positions).reduce((a, p) => a + p.order_krw, 0);
    return {
      mode: "data_accum_live",
      strategy_tag: "live_data_mode_v1",
      strategy_available_krw: null,
      strategy_invested_krw: usedKrw,
      strategy_pnl_krw: pnl,
      strategy_win_rate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
      strategy_total_fills: state.trades.length,
      strategy_take_profit_count: tpCount,
      strategy_stop_loss_count: slCount,
      strategy_avg_holding_minutes: avgHold,
      legacy_asset_pnl: null,
      strategy_asset_pnl: pnl,
      total_asset_pnl: null,
      files: { trades: tradesFile, daily: dailyFile },
      open_positions: state.positions,
      safety_guard_state: state.safety_guard.state,
      safety_guard_reason: state.safety_guard.reason,
      order_fail_count_today: state.safety_guard.order_fail_count_today,
      consecutive_losses: state.safety_guard.consecutive_losses,
      max_positions: state.safety_guard.max_positions,
      reentry_cooldowns: state.cooldown_until,
      legacy_management: state.legacy,
    };
  };

  const legacySignalAllowsDca = (sig: any): boolean => {
    if (!sig?.p) return false;
    const p = sig.p;
    const volumeOkay = Number(p.volume_ratio ?? 0) >= 0.85;
    const filters = Array.isArray(p.filters) ? p.filters : [];
    const passed = new Set(filters.filter((f: any) => f?.passed === true).map((f: any) => String(f.id)));
    const reboundPattern =
      passed.has("box_breakout") ||
      passed.has("pullback_reclaim") ||
      passed.has("volume_spike_close_fail");
    return volumeOkay && reboundPattern;
  };

  const legacySignalWeakening = (sig: any): boolean => {
    if (!sig?.p) return false;
    const p = sig.p;
    const filters = Array.isArray(p.filters) ? p.filters : [];
    const closeHold = filters.find((f: any) => String(f?.id) === "volume_spike_close_fail");
    const volume = Number(p.volume_ratio ?? 0);
    return (closeHold && closeHold.passed === false) || volume < 0.75;
  };

  const runTick = async () => {
    if (state.daily.date !== todayKst()) {
      state.daily = { date: todayKst(), entry_count: 0, loss_pct: 0, stop_by_market: {} };
      state.safety_guard.order_fail_count_today = 0;
      state.safety_guard.consecutive_losses = 0;
      if (state.safety_guard.state === "자동정지") {
        state.safety_guard.state = "주의";
        state.safety_guard.reason = "daily_reset";
      }
    }

    const tstatus = await opts.trade.status();
    if (!tstatus.auto_trade_enabled || !tstatus.api_connected || !tstatus.live_enabled) return;
    if (state.safety_guard.state === "자동정지") return;
    const tickerRows = await fetchTickers([...MARKETS]);
    const priceBy = new Map(tickerRows.map((r) => [r.market, r.trade_price]));
    const latestByMarket = new Map<string, any>();
    const logs = await opts.readLogs(220);
    const marketState = await opts.marketState.evaluate();
    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!p.success) continue;
      if (!MARKETS.includes(p.data.market as any)) continue;
      if (!latestByMarket.has(p.data.market)) latestByMarket.set(p.data.market, { ts: row.ts, p: p.data });
    }

    // legacy buckets: no stop-loss, limited DCA, staged recovery exits.
    const legacyByMarket = (tstatus.legacy_positions ?? {}) as Record<
      string,
      { qty?: number; avg?: number; dca_count?: number; dca_max?: number; dca_available?: boolean; exit_status?: string }
    >;
    for (const market of MARKETS) {
      const legacy = legacyByMarket[market];
      const legacyQty = Number(legacy?.qty ?? 0);
      const legacyAvg = Number(legacy?.avg ?? 0);
      if (legacyQty <= 0 || legacyAvg <= 0) continue;
      const now = priceBy.get(market) ?? legacyAvg;
      const pnlPct = netPnlPct(legacyAvg, now);
      const sig = latestByMarket.get(market);
      const stage = state.legacy.exit_stage[market] ?? 0;
      const dcaCount = state.legacy.dca_count[market] ?? Number(legacy?.dca_count ?? 0);
      const dcaMax = Number(legacy?.dca_max ?? 3);
      const locked = state.legacy.dca_locked[market] ?? !(legacy?.dca_available ?? true);
      const nextDcaAt = state.legacy.next_dca_at[market];
      const dcaCooldownPassed = !nextDcaAt || Date.now() >= Date.parse(nextDcaAt);

      // DCA only when market is not collapsing, signal supports rebound, and capped by count/size.
      if (opts.trade.placeLegacyDcaBuy && !locked && dcaCount < dcaMax && dcaCooldownPassed) {
        const krw = Number(tstatus.krw_available ?? 0);
        const orderKrw = Math.floor(Math.max(5000, Math.min(12000, krw * 0.06)));
        if (orderKrw >= 5000 && krw > orderKrw * 1.2 && legacySignalAllowsDca(sig)) {
          try {
            await opts.trade.placeLegacyDcaBuy(market, true, orderKrw, sig?.p);
            state.legacy.dca_count[market] = dcaCount + 1;
            state.legacy.next_dca_at[market] = new Date(Date.now() + 20 * 60_000).toISOString();
            state.legacy.dca_locked[market] = dcaCount + 1 >= dcaMax;
          } catch {}
        }
      }

      // Recovery exits: break-even partial -> small profit partial -> weaken signal trim.
      if (!opts.trade.placeLegacyExitSell) continue;
      const shouldStage1 = stage < 1 && pnlPct >= 0;
      const shouldStage2 = stage < 2 && pnlPct >= 0.9;
      const shouldTrimWeak = stage >= 1 && pnlPct >= 0.4 && legacySignalWeakening(sig);
      try {
        if (shouldStage1) {
          await opts.trade.placeLegacyExitSell(market, true, 0.35);
          state.legacy.exit_stage[market] = 1;
        } else if (shouldStage2) {
          await opts.trade.placeLegacyExitSell(market, true, 0.35);
          state.legacy.exit_stage[market] = 2;
        } else if (shouldTrimWeak) {
          await opts.trade.placeLegacyExitSell(market, true, 0.5);
        }
      } catch {}
    }

    // exits
    for (const market of Object.keys(state.positions)) {
      const p = state.positions[market]!;
      const now = priceBy.get(market) ?? p.entry_price;
      const pnlPct = netPnlPct(p.entry_price, now);
      p.max_pnl_pct = Math.max(p.max_pnl_pct, pnlPct);
      p.current_net_pnl_pct = pnlPct;
      if (now > p.highest_price_after_entry) {
        p.highest_price_after_entry = now;
        state.trades.push({
          timestamp: new Date().toISOString(),
          entry_ts: p.entry_ts,
          market,
          action: "sell",
          order_krw: 0,
          filled_qty: 0,
          avg_buy_price: p.entry_price,
          exit_price: now,
          pnl_krw: 0,
          pnl_pct: pnlPct,
          reason_enter: p.reason_enter,
          reason_exit: "highest_price_update",
          holding_minutes: minutesSince(p.entry_ts),
          signal_strength: p.signal_strength,
          volume_ratio: p.volume_ratio,
          strategy_tag: "live_data_mode_v1",
          strategy_type: p.strategy_type,
          stop_trigger_kind: null,
          current_net_pnl_pct: pnlPct,
          liquidation_reason: "highest_price_update",
          remaining_qty: p.qty,
          highest_price_after_entry: p.highest_price_after_entry,
          trailing_stop_price: p.trailing_stop_price,
          breakeven_armed_at: p.breakeven_armed_at,
          partial_tp_at: p.partial_tp_at,
        });
      }
      const holdMin = minutesSince(p.entry_ts);
      let reasonExit = "";
      let stopTriggerKind: StopTriggerKind | null = null;
      let ratio = 1;
      if (p.strategy_type === "stable") {
        const s = STRATEGY_RISK_CONFIG.stable;
        if (!p.breakeven_armed && pnlPct >= s.breakeven_arm_pct) {
          p.breakeven_armed = true;
          p.breakeven_armed_at = new Date().toISOString();
          state.trades.push({
            timestamp: p.breakeven_armed_at,
            entry_ts: p.entry_ts,
            market,
            action: "buy",
            order_krw: 0,
            filled_qty: 0,
            avg_buy_price: p.entry_price,
            exit_price: now,
            pnl_krw: 0,
            pnl_pct: pnlPct,
            reason_enter: p.reason_enter,
            reason_exit: "breakeven_armed",
            holding_minutes: holdMin,
            signal_strength: p.signal_strength,
            volume_ratio: p.volume_ratio,
            strategy_tag: "live_data_mode_v1",
            strategy_type: p.strategy_type,
            stop_trigger_kind: "breakeven_protect",
            current_net_pnl_pct: pnlPct,
            liquidation_reason: "breakeven_armed",
            remaining_qty: p.qty,
            highest_price_after_entry: p.highest_price_after_entry,
            trailing_stop_price: p.trailing_stop_price,
            breakeven_armed_at: p.breakeven_armed_at,
            partial_tp_at: p.partial_tp_at,
          });
          await opts.onEvent?.({
            timestamp: p.breakeven_armed_at,
            event_type: "breakeven_armed",
            market,
            strategy_type: p.strategy_type,
            market_state: null,
            side: "sell",
            reason: "breakeven_protect",
            balance_krw: null,
            position_qty: p.qty,
            avg_buy_price: p.entry_price,
            current_price: now,
            pnl_net: null,
            pnl_net_pct: pnlPct,
            note: "stable breakeven armed",
          });
        }
        p.trailing_stop_price = p.highest_price_after_entry * (1 - s.trailing_from_peak_pct / 100);
        if (!p.partial_tp_done && pnlPct >= s.partial_take_profit_pct) {
          reasonExit = "partial_take_profit";
          ratio = s.partial_take_profit_ratio;
          stopTriggerKind = null;
        } else if (p.partial_tp_done && now <= p.trailing_stop_price) {
          reasonExit = "trailing_take_profit";
          stopTriggerKind = "time_stop";
        } else if (p.breakeven_armed && pnlPct <= s.breakeven_floor_pct) {
          reasonExit = "breakeven_exit";
          stopTriggerKind = "breakeven_protect";
        } else if (pnlPct <= STRATEGY_RISK_CONFIG.stable.stop_loss_pct) {
          reasonExit = `stable_price_stop_${STRATEGY_RISK_CONFIG.stable.stop_loss_pct}`;
          stopTriggerKind = "price_stop";
        } else if (holdMin >= STRATEGY_RISK_CONFIG.stable.weak_hold_stop_minutes && p.max_pnl_pct < 0.35 && pnlPct < 0) {
          reasonExit = "stable_time_stop_weak_rebound";
          stopTriggerKind = "time_stop";
        }
      } else {
        const m = STRATEGY_RISK_CONFIG.momentum;
        if (!p.breakeven_armed && pnlPct >= m.breakeven_arm_pct) {
          p.breakeven_armed = true;
          p.breakeven_armed_at = new Date().toISOString();
          state.trades.push({
            timestamp: p.breakeven_armed_at,
            entry_ts: p.entry_ts,
            market,
            action: "buy",
            order_krw: 0,
            filled_qty: 0,
            avg_buy_price: p.entry_price,
            exit_price: now,
            pnl_krw: 0,
            pnl_pct: pnlPct,
            reason_enter: p.reason_enter,
            reason_exit: "breakeven_armed",
            holding_minutes: holdMin,
            signal_strength: p.signal_strength,
            volume_ratio: p.volume_ratio,
            strategy_tag: "live_data_mode_v1",
            strategy_type: p.strategy_type,
            stop_trigger_kind: "breakeven_protect",
            current_net_pnl_pct: pnlPct,
            liquidation_reason: "breakeven_armed",
            remaining_qty: p.qty,
            highest_price_after_entry: p.highest_price_after_entry,
            trailing_stop_price: p.trailing_stop_price,
            breakeven_armed_at: p.breakeven_armed_at,
            partial_tp_at: p.partial_tp_at,
          });
          await opts.onEvent?.({
            timestamp: p.breakeven_armed_at,
            event_type: "breakeven_armed",
            market,
            strategy_type: p.strategy_type,
            market_state: null,
            side: "sell",
            reason: "breakeven_protect",
            balance_krw: null,
            position_qty: p.qty,
            avg_buy_price: p.entry_price,
            current_price: now,
            pnl_net: null,
            pnl_net_pct: pnlPct,
            note: "momentum breakeven armed",
          });
        }
        p.trailing_stop_price = p.highest_price_after_entry * (1 - m.trailing_from_peak_pct / 100);
        if (!p.partial_tp_done && pnlPct >= m.partial_take_profit_pct) {
          reasonExit = "partial_take_profit";
          ratio = m.partial_take_profit_ratio;
        } else if (p.partial_tp_done && now <= p.trailing_stop_price) {
          reasonExit = "trailing_take_profit";
          stopTriggerKind = "time_stop";
        } else if (p.breakeven_armed && pnlPct <= m.breakeven_floor_pct) {
          reasonExit = "momentum_breakeven_protect";
          stopTriggerKind = "breakeven_protect";
        } else if (pnlPct <= m.stop_loss_pct) {
          reasonExit = `momentum_price_stop_${m.stop_loss_pct}`;
          stopTriggerKind = "price_stop";
        } else {
          try {
            const c1 = await fetchMinuteCandles(market, 1, 8);
            const last = c1[c1.length - 1];
            const prev = c1[c1.length - 2];
            if (last && prev) {
              const lastNotional = last.candle_acc_trade_volume * last.trade_price;
              const prevNotional = Math.max(1, prev.candle_acc_trade_volume * prev.trade_price);
              const dealDrop = lastNotional / prevNotional < 0.45;
              const range = Math.max(1e-9, last.high_price - last.low_price);
              const closeLow = (last.trade_price - last.low_price) / range < 0.28;
              const upperWickWeak = (last.high_price - last.trade_price) / range > 0.55 && last.trade_price <= last.opening_price;
              const breakoutLowBreak = last.trade_price < prev.low_price;
              if (dealDrop || closeLow || upperWickWeak || breakoutLowBreak) {
                reasonExit = "momentum_pattern_break";
                stopTriggerKind = "pattern_break";
              }
            }
          } catch {}
          if (!reasonExit && holdMin >= m.time_stop_min_minutes && holdMin <= m.time_stop_max_minutes && p.max_pnl_pct < 0.8 && pnlPct <= -0.1) {
            reasonExit = "momentum_time_stop";
            stopTriggerKind = "time_stop";
          }
        }
      }
      if (!reasonExit) continue;

      const beforeQty = p.qty;
      await opts.trade.placeSell(market, true, ratio);
      const after = await opts.trade.status();
      const qtyAfter = Number(after.strategy_positions?.[market]?.qty ?? 0);
      const soldQty = Math.max(0, beforeQty - qtyAfter);
      const grossSell = soldQty * now;
      const principal = soldQty * p.entry_price;
      const buyFee = principal * UPBIT_FEE_RATE;
      const sellFee = grossSell * UPBIT_FEE_RATE;
      const netPnlKrw = grossSell - principal - buyFee - sellFee;
      const netPnlPctValue = principal > 0 ? (netPnlKrw / principal) * 100 : 0;
      const row: StrategyTradeRow = {
        timestamp: new Date().toISOString(),
        entry_ts: p.entry_ts,
        market,
        action: "sell",
        order_krw: Math.round(Math.max(0, soldQty * now)),
        filled_qty: soldQty,
        avg_buy_price: p.entry_price,
        exit_price: now,
        pnl_krw: Math.round(netPnlKrw),
        pnl_pct: netPnlPctValue,
        reason_enter: p.reason_enter,
        reason_exit: reasonExit,
        holding_minutes: holdMin,
        signal_strength: p.signal_strength,
        volume_ratio: p.volume_ratio,
        strategy_tag: "live_data_mode_v1",
        strategy_type: p.strategy_type,
        stop_trigger_kind: stopTriggerKind,
        current_net_pnl_pct: netPnlPctValue,
        liquidation_reason: reasonExit,
        remaining_qty: qtyAfter,
        highest_price_after_entry: p.highest_price_after_entry,
        trailing_stop_price: p.trailing_stop_price,
        breakeven_armed_at: p.breakeven_armed_at,
        partial_tp_at: p.partial_tp_at,
      };
      state.trades.push(row);
      await opts.onEvent?.({
        timestamp: row.timestamp,
        event_type:
          reasonExit === "partial_take_profit"
            ? "partial_take_profit"
            : reasonExit === "trailing_take_profit"
              ? "trailing_take_profit"
              : reasonExit === "breakeven_exit" || reasonExit === "momentum_breakeven_protect"
                ? "breakeven_exit"
                : reasonExit === "momentum_pattern_break"
                  ? "pattern_break_exit"
                  : reasonExit === "momentum_time_stop" || reasonExit === "stable_time_stop_weak_rebound"
                    ? "time_stop_exit"
                    : "stop_loss",
        market,
        strategy_type: p.strategy_type,
        market_state: null,
        side: "sell",
        reason: reasonExit,
        balance_krw: null,
        position_qty: qtyAfter,
        avg_buy_price: p.entry_price,
        current_price: now,
        pnl_net: Math.round(netPnlKrw),
        pnl_net_pct: netPnlPctValue,
        note: null,
      });
      if (netPnlKrw < 0) {
        state.daily.stop_by_market[market] = (state.daily.stop_by_market[market] ?? 0) + 1;
        state.daily.loss_pct -= Math.abs(netPnlPctValue);
        state.safety_guard.consecutive_losses += 1;
      } else {
        state.safety_guard.consecutive_losses = 0;
      }
      if (qtyAfter <= 0) {
        delete state.positions[market];
        const stableStopCooldown =
          p.strategy_type === "stable"
            ? STRATEGY_RISK_CONFIG.stable.reentry_cooldown_minutes_after_stop
            : STRATEGY_RISK_CONFIG.stable.reentry_cooldown_minutes_after_stop;
        state.cooldown_until[market] = new Date(Date.now() + stableStopCooldown * 60_000).toISOString();
      } else {
        if (!p.partial_tp_done && reasonExit === "partial_take_profit") {
          p.partial_tp_done = true;
          p.partial_tp_at = new Date().toISOString();
          p.realized_partial_profit += Math.round(netPnlKrw);
        }
        p.qty = qtyAfter;
        p.remaining_qty = qtyAfter;
      }
    }

    // entries
    if (state.daily.entry_count >= 6) {
      await persist();
      return;
    }
    if (state.daily.loss_pct <= -2.5) {
      state.safety_guard.state = "자동정지";
      state.safety_guard.reason = "daily_pnl_limit_-2.5";
      await opts.trade.setAutoTradeEnabled?.(false);
      await opts.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "safety_guard_stopped",
        market: null,
        strategy_type: null,
        market_state: null,
        side: null,
        reason: "daily_pnl_limit_-2.5",
        balance_krw: Number(tstatus.krw_available ?? 0),
        position_qty: Object.keys(state.positions).length,
        avg_buy_price: null,
        current_price: null,
        pnl_net: Number(summarize().strategy_pnl_krw ?? 0),
        pnl_net_pct: state.daily.loss_pct,
        note: null,
      });
      await persist();
      return;
    }
    if (state.safety_guard.consecutive_losses >= 3) {
      state.safety_guard.state = "자동정지";
      state.safety_guard.reason = "consecutive_losses_3";
      await opts.trade.setAutoTradeEnabled?.(false);
      await opts.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "safety_guard_stopped",
        market: null,
        strategy_type: null,
        market_state: null,
        side: null,
        reason: "consecutive_losses_3",
        balance_krw: Number(tstatus.krw_available ?? 0),
        position_qty: Object.keys(state.positions).length,
        avg_buy_price: null,
        current_price: null,
        pnl_net: Number(summarize().strategy_pnl_krw ?? 0),
        pnl_net_pct: null,
        note: null,
      });
      await persist();
      return;
    }
    const openCount = Object.keys(state.positions).length;
    if (openCount >= state.safety_guard.max_positions) {
      await persist();
      return;
    }

    for (const market of MARKETS) {
      if (Object.keys(state.positions).length >= 2) break;
      if (state.positions[market]) continue;
      const cool = state.cooldown_until[market];
      if (cool && Date.now() < Date.parse(cool)) continue;
      if ((state.daily.stop_by_market[market] ?? 0) >= 2) continue;

      const sig = latestByMarket.get(market);
      if (!sig) continue;
      if (!sig.p.filter_pass) continue; // pass only
      if ((sig.p.signal_type ?? "").toUpperCase() === "LOW") continue;

      const st = await opts.trade.status();
      const currency = market.replace("KRW-", "");
      const existingQty = Number(st.balances?.find((b: any) => b.currency === currency)?.balance ?? 0);
      if (existingQty > 0) continue; // no averaging / no existing hold
      const liveOrderAvailableKrw = Math.max(0, Number(st.live_order_available_krw ?? st.krw_available ?? 0));
      let orderKrw = Math.floor(liveOrderAvailableKrw * 0.2);
      orderKrw = Math.max(5000, Math.min(30000, orderKrw));
      if (orderKrw < 5000) continue;
      if (liveOrderAvailableKrw < orderKrw) continue;
      const strategyType: StrategyType = marketState.market_state === "risk_on" ? "momentum" : "stable";
      try {
        await opts.trade.placeBuy(market, true, orderKrw, strategyType, "strategy", sig.p);
      } catch (e) {
        state.safety_guard.order_fail_count_today += 1;
        if (state.safety_guard.order_fail_count_today >= 3) {
          state.safety_guard.state = "자동정지";
          state.safety_guard.reason = "order_failures";
          await opts.trade.setAutoTradeEnabled?.(false);
          await opts.onEvent?.({
            timestamp: new Date().toISOString(),
            event_type: "safety_guard_stopped",
            market,
            strategy_type: strategyType,
            market_state: marketState.market_state,
            side: "buy",
            reason: "order_failures",
            balance_krw: Number(st.krw_available ?? 0),
            position_qty: null,
            avg_buy_price: null,
            current_price: null,
            pnl_net: null,
            pnl_net_pct: null,
            note: e instanceof Error ? e.message : "buy_failed",
          });
        }
        await persist();
        continue;
      }
      const price = priceBy.get(market) ?? 0;
      const st2 = await opts.trade.status();
      const qty = Number(st2.strategy_positions?.[market]?.qty ?? 0);
      state.positions[market] = {
        market,
        strategy_type: strategyType,
        entry_ts: new Date().toISOString(),
        entry_price: price,
        qty,
        order_krw: orderKrw,
        reason_enter: sig.p.signal_reason ?? "signal_pass",
        signal_strength: sig.p.signal_type ?? "MID",
        volume_ratio: Number(sig.p.volume_ratio ?? 0),
        partial_tp_done: false,
        max_pnl_pct: 0,
        breakeven_armed: false,
        highest_price_after_entry: price,
        trailing_stop_price: 0,
        realized_partial_profit: 0,
        remaining_qty: qty,
        current_net_pnl_pct: 0,
        breakeven_armed_at: null,
        partial_tp_at: null,
      };
      state.daily.entry_count += 1;
      state.cooldown_until[market] = new Date(Date.now() + 30 * 60_000).toISOString();
      state.trades.push({
        timestamp: new Date().toISOString(),
        entry_ts: new Date().toISOString(),
        market,
        action: "buy",
        order_krw: orderKrw,
        filled_qty: qty,
        avg_buy_price: price,
        exit_price: null,
        pnl_krw: 0,
        pnl_pct: 0,
        reason_enter: sig.p.signal_reason ?? "signal_pass",
        reason_exit: "",
        holding_minutes: 0,
        signal_strength: sig.p.signal_type ?? "MID",
        volume_ratio: Number(sig.p.volume_ratio ?? 0),
        strategy_tag: "live_data_mode_v1",
        strategy_type: strategyType,
        stop_trigger_kind: null,
        current_net_pnl_pct: 0,
        liquidation_reason: "",
        remaining_qty: qty,
        highest_price_after_entry: price,
        trailing_stop_price: 0,
        breakeven_armed_at: null,
        partial_tp_at: null,
      });
      await opts.onEvent?.({
        timestamp: new Date().toISOString(),
        event_type: "order_filled",
        market,
        strategy_type: strategyType,
        market_state: marketState.market_state,
        side: "buy",
        reason: sig.p.signal_reason ?? "signal_pass",
        balance_krw: Number(st2.krw_available ?? 0),
        position_qty: qty,
        avg_buy_price: price,
        current_price: price,
        pnl_net: 0,
        pnl_net_pct: 0,
        note: "strategy entry",
      });
    }
    await persist();
  };

  return {
    init: restore,
    tick: runTick,
    status: summarize,
    files: { tradesFile, dailyFile },
  };
}
