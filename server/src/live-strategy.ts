import fs from "node:fs/promises";
import path from "node:path";
import type { SignalLogEntry } from "@orbitalpha/shared";
import {
  companyIdSchema,
  mvpSignalPayloadV2Schema,
  serviceIdSchema,
  signalStrengthScore,
} from "@orbitalpha/shared";
import { tradingDataRoot } from "./paths.js";
import { appendLog } from "./log-store.js";
import { fetchMinuteCandles, fetchTickers, partitionKrwMarketsByUpbitValidity } from "./upbit-public.js";
import {
  LIVE_ENTRY_SIGNAL_GATES,
  RECOVERY_EXIT_CONFIG,
  STRATEGY_RISK_CONFIG,
  STRICT_NEW_POSITION_EXIT,
  UPBIT_FEE_RATE,
  UPBIT_MIN_ORDER_KRW,
  grossPnlPct,
  netPnlPctPerUnit,
  type StopTriggerKind,
  type StrategyType,
} from "./strategy-risk-config.js";
import { ENTRY_PIPELINE_MID_SCORE_FLOOR, evaluateSpotLongEntryPipeline } from "./live-entry-pipeline.js";

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
    btc_5m_trend?: "up" | "down" | "flat";
    btc_15m_trend?: "up" | "down" | "flat";
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
  /** 복원 시 없으면 기존 보유 — 신규만 엄격 손익 곡선 */
  strict_exit?: boolean;
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
  regime?: {
    btc_filter_state: "strong" | "neutral" | "weak";
    conservative_mode: boolean;
    exception_entry_allowed: boolean;
    exception_candidates: Array<{ market: string; reason: string; relative_strength: number; signal_score: number }>;
    exception_slot_market: string | null;
    entry_size_pct: number;
    last_updated_at: string;
  };
};

const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-SOL", "KRW-XRP", "KRW-TRX"] as const;
const LEADER_MARKETS = new Set<string>(MARKETS as unknown as string[]);
const RISK_OFF_ENTRY_SCALE = 0.5;
const EXISTING_POSITION_MIN_KRW = Math.max(1000, Number(process.env.LIVE_EXISTING_POSITION_MIN_KRW ?? 5000));
const DEBUG_FORCE_BASE_GATE = String(process.env.DEBUG_FORCE_BASE_GATE ?? "").toLowerCase() === "true";
const DEBUG_EXCLUDE_HELD_SYMBOLS = String(process.env.DEBUG_EXCLUDE_HELD_SYMBOLS ?? "").toLowerCase() === "true";
const DEBUG_INCLUDE_UNIVERSE_MARKETS = String(process.env.DEBUG_INCLUDE_UNIVERSE_MARKETS ?? "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s.startsWith("KRW-"));

function classifySignalMonitorErrorSnippet(err: string): { primary_reason: string; classification_tags: string[] } {
  const e = err.toLowerCase();
  const classification_tags: string[] = [];
  if (/429|too many requests/.test(e)) classification_tags.push("volume_filter_failed");
  if (/404|code not found|invalid_market|unknown market|not found/.test(e)) classification_tags.push("invalid_market_data");
  if (/candle|캔들|\[\]|empty|length|too short/.test(e)) classification_tags.push("insufficient_candles");
  if (/ema|indicator|nan|undefined/.test(e)) classification_tags.push("indicator_not_ready");
  let primary_reason = "signal_monitor_scan_failed";
  if (classification_tags.includes("invalid_market_data")) primary_reason = "invalid_market_data";
  else if (classification_tags.includes("insufficient_candles")) primary_reason = "insufficient_candles";
  else if (classification_tags.includes("volume_filter_failed")) primary_reason = "volume_filter_failed";
  else if (classification_tags.includes("indicator_not_ready")) primary_reason = "indicator_not_ready";
  return { primary_reason, classification_tags };
}

/** signal-monitor JSONL에 왜 해당 심볼 신호가 없는지 단계별로 분해 (pump-scanner 피드와는 별도 채널). */
function buildLiveSignalMissingDetail(market: string, logs: SignalLogEntry[]): Record<string, unknown> {
  let rawSignalRows = 0;
  let parsedOkRows = 0;
  let parsedFailRows = 0;
  let newestRawSignalTs: string | null = null;
  let lastZodIssue: string | null = null;

  let scanFailNewestTs: string | null = null;
  let scanFailNewestErr: string | null = null;
  let scanFailCount = 0;
  let cooldownRows = 0;

  for (const row of logs) {
    const msg = String(row.message ?? "");
    if (msg === `market_scan_failed:${market}`) {
      scanFailCount += 1;
      if (!scanFailNewestTs) {
        scanFailNewestTs = row.ts;
        scanFailNewestErr = String((row.payload as { error?: unknown })?.error ?? "").slice(0, 500);
      }
    }
    if (msg === `market_scan_skipped_cooldown:${market}`) {
      cooldownRows += 1;
    }
  }

  for (const row of logs) {
    if (row.kind !== "signal" || !row.payload || typeof row.payload !== "object") continue;
    const pay = row.payload as Record<string, unknown>;
    if (pay.market !== market) continue;
    rawSignalRows += 1;
    if (!newestRawSignalTs) newestRawSignalTs = row.ts;
    const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
    if (p.success) {
      parsedOkRows += 1;
    } else {
      parsedFailRows += 1;
      if (!lastZodIssue && p.error?.issues?.[0]) {
        const iss = p.error.issues[0]!;
        lastZodIssue = `${iss.path.join(".")}: ${iss.message}`;
      }
    }
  }

  const scanClass = scanFailNewestErr
    ? classifySignalMonitorErrorSnippet(scanFailNewestErr)
    : { primary_reason: "signal_monitor_scan_failed", classification_tags: [] as string[] };

  const classification_tags = [...scanClass.classification_tags];
  const hints: string[] = [
    "live_strategy_uses_readLogs_kind_signal_only",
    "pump_scanner_signalFeed_is_not_written_to_this_log_stream",
  ];

  let primary_reason = "not_in_signal_monitor_logs";

  if (parsedOkRows > 0) {
    primary_reason = "unexpected_parsed_ok_but_signal_map_miss";
    hints.push("check_latestAllSignals_fill_order_and_log_window");
  } else if (rawSignalRows > 0) {
    primary_reason = "signal_payload_schema_mismatch";
    if (lastZodIssue) hints.push(`zod_first_issue:${lastZodIssue}`);
  } else if (scanFailNewestErr) {
    primary_reason = scanClass.primary_reason;
  } else if (cooldownRows > 0) {
    primary_reason = "signal_monitor_cooldown_skips";
    hints.push("only_system_cooldown_rows_no_signal_append_in_window");
  }

  return {
    primary_reason,
    signal_source: "signal_monitor_jsonl",
    raw_signal_rows: rawSignalRows,
    parsed_ok_rows: parsedOkRows,
    parsed_fail_rows: parsedFailRows,
    newest_raw_signal_ts: newestRawSignalTs,
    scan_fail_count: scanFailCount,
    last_scan_fail_ts: scanFailNewestTs,
    last_scan_fail_error: scanFailNewestErr,
    cooldown_rows_seen: cooldownRows,
    classification_tags,
    hints,
  };
}

function todayKst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

function minutesSince(ts: string) {
  return Math.max(0, (Date.now() - Date.parse(ts)) / 60_000);
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
    regime: {
      btc_filter_state: "neutral",
      conservative_mode: false,
      exception_entry_allowed: false,
      exception_candidates: [],
      exception_slot_market: null,
      entry_size_pct: 1,
      last_updated_at: new Date().toISOString(),
    },
  };

  const persist = async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(tradesFile, JSON.stringify(state.trades, null, 2), "utf8");
    await fs.writeFile(
      dailyFile,
      JSON.stringify(
        {
          daily: state.daily,
          positions: state.positions,
          cooldown_until: state.cooldown_until,
          safety_guard: state.safety_guard,
          legacy: state.legacy,
          regime: state.regime,
        },
        null,
        2,
      ),
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
      state.regime = d.regime ?? state.regime;
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
      regime: state.regime,
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
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_LOOP_TICK",
        ts: new Date().toISOString(),
        safety_guard_state: state.safety_guard.state,
      }),
    );
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
    if (!tstatus.auto_trade_enabled || !tstatus.api_connected || !tstatus.live_enabled) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_LOOP_SKIP",
          reason: "trade_status_guard",
          auto_trade_enabled: Boolean(tstatus.auto_trade_enabled),
          api_connected: Boolean(tstatus.api_connected),
          live_enabled: Boolean(tstatus.live_enabled),
        }),
      );
      return;
    }
    if (state.safety_guard.state === "자동정지") {
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_LOOP_SKIP",
          reason: "safety_guard_stopped",
          safety_guard_state: state.safety_guard.state,
          safety_guard_reason: state.safety_guard.reason,
        }),
      );
      return;
    }
    const latestByMarket = new Map<string, any>();
    const latestAllSignals = new Map<string, any>();
    const logs = await opts.readLogs(220);
    const marketState = await opts.marketState.evaluate();
    const conservativeMode = marketState.market_state === "risk_off";
    for (const row of logs) {
      if (row.kind !== "signal" || !row.payload) continue;
      const p = mvpSignalPayloadV2Schema.safeParse(row.payload);
      if (!p.success) continue;
      if (!latestAllSignals.has(p.data.market)) latestAllSignals.set(p.data.market, { ts: row.ts, p: p.data });
      if (!MARKETS.includes(p.data.market as any)) continue;
      if (!latestByMarket.has(p.data.market)) latestByMarket.set(p.data.market, { ts: row.ts, p: p.data });
    }

    const includeValidity = await partitionKrwMarketsByUpbitValidity(DEBUG_INCLUDE_UNIVERSE_MARKETS);
    const debugUniverseExtra = includeValidity.skippedBecauseUnknown
      ? [...DEBUG_INCLUDE_UNIVERSE_MARKETS]
      : includeValidity.accepted;
    if (!includeValidity.skippedBecauseUnknown && includeValidity.rejected.length > 0) {
      console.info(
        JSON.stringify({
          tag: "DEBUG_INCLUDE_MARKET_REJECTED_BY_UPBIT_VALIDITY",
          rejected: includeValidity.rejected,
          env_raw: DEBUG_INCLUDE_UNIVERSE_MARKETS,
        }),
      );
    }

    const logMapValidity = await partitionKrwMarketsByUpbitValidity([...latestAllSignals.keys()]);
    if (!logMapValidity.skippedBecauseUnknown) {
      const keepLogMarkets = new Set(logMapValidity.accepted);
      for (const k of [...latestAllSignals.keys()]) {
        if (!keepLogMarkets.has(k)) {
          latestAllSignals.delete(k);
          console.info(
            JSON.stringify({
              tag: "DEBUG_STALE_INVALID_MARKET_PRUNED_FROM_SIGNAL_MAP",
              symbol: k,
              reason: "not_in_upbit_valid_set_or_blacklisted",
              ingress_path: "historical_signal_jsonl_or_delisted_ticker",
            }),
          );
        }
      }
    }

    const exceptionPool = Array.from(latestAllSignals.entries())
      .filter(([m]) => !LEADER_MARKETS.has(m) && m.startsWith("KRW-"))
      .map(([market, sig]) => {
        const gate = opts.marketState.entryGate(sig.p, marketState);
        const signalScore = Number(gate.score ?? 0);
        const vol = Number(sig.p.volume_ratio ?? 0);
        const reasonText = String(sig.p.signal_reason ?? "").toLowerCase();
        const rise3m = Number(sig.p.momentum_3m_pct ?? sig.p.price_change_3m_pct ?? 0);
        const trendOk = reasonText.includes("breakout") || reasonText.includes("trend") || reasonText.includes("reclaim");
        return { market, sig, signalScore, vol, rise3m, trendOk };
      })
      .filter((x) => x.signalScore >= 86 && x.vol >= 1.2 && x.rise3m >= 0.8 && x.trendOk)
      .sort((a, b) => b.signalScore - a.signalScore || b.vol - a.vol);
    const exceptionSlotMarket = exceptionPool[0]?.market ?? null;
    const watchMarkets = Array.from(
      new Set([...MARKETS, ...(exceptionSlotMarket ? [exceptionSlotMarket] : []), ...debugUniverseExtra]),
    );
    const tickerRows = await fetchTickers(watchMarkets);
    const priceBy = new Map(tickerRows.map((r) => [r.market, r.trade_price]));
    const changeRateBy = new Map(tickerRows.map((r) => [r.market, Number(r.signed_change_rate ?? 0)]));
    const btcChange = Number(changeRateBy.get("KRW-BTC") ?? 0);
    const btcTier: "strong" | "neutral" | "weak" =
      conservativeMode || btcChange <= -0.004 ? "weak" : btcChange >= 0.002 ? "strong" : "neutral";
    const entrySizePct = btcTier === "strong" ? 1 : btcTier === "neutral" ? 0.75 : RISK_OFF_ENTRY_SCALE;
    const exceptionCandidates: Array<{ market: string; reason: string; relative_strength: number; signal_score: number }> = [];
    if (exceptionSlotMarket) {
      const x = exceptionPool[0]!;
      const rel = (Number(changeRateBy.get(exceptionSlotMarket) ?? 0) - btcChange) * 100;
      exceptionCandidates.push({
        market: exceptionSlotMarket,
        reason: `exception_slot:rel_${rel.toFixed(2)}:score_${x.signalScore.toFixed(1)}:vol_${x.vol.toFixed(2)}:rise_${x.rise3m.toFixed(2)}`,
        relative_strength: Number(rel.toFixed(3)),
        signal_score: Number(x.signalScore.toFixed(1)),
      });
    }
    exceptionCandidates.sort((a, b) => b.signal_score - a.signal_score || b.relative_strength - a.relative_strength);
    state.regime = {
      btc_filter_state: btcTier,
      conservative_mode: conservativeMode,
      exception_entry_allowed: true,
      exception_candidates: exceptionCandidates.slice(0, 1),
      exception_slot_market: exceptionSlotMarket,
      entry_size_pct: entrySizePct,
      last_updated_at: new Date().toISOString(),
    };

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
      const rawPxL = priceBy.get(market);
      const hasTickerL = typeof rawPxL === "number" && Number.isFinite(rawPxL) && rawPxL > 0;
      const now = hasTickerL ? rawPxL : legacyAvg;
      const pnlGross = grossPnlPct(legacyAvg, now);
      const sig = latestByMarket.get(market);
      const stage = state.legacy.exit_stage[market] ?? 0;
      const dcaCount = state.legacy.dca_count[market] ?? Number(legacy?.dca_count ?? 0);
      const dcaMax = Number(legacy?.dca_max ?? 3);
      const locked = state.legacy.dca_locked[market] ?? !(legacy?.dca_available ?? true);
      const nextDcaAt = state.legacy.next_dca_at[market];
      const dcaCooldownPassed = !nextDcaAt || Date.now() >= Date.parse(nextDcaAt);

      // 손실 구간 레거시 물타기 금지 — 회복 기대 DCA 없음
      if (pnlGross < 0) {
        /* skip legacy DCA */
      } else if (opts.trade.placeLegacyDcaBuy && !locked && dcaCount < dcaMax && dcaCooldownPassed) {
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
      const shouldStage1 = stage < 1 && pnlGross >= 0;
      const shouldStage2 = stage < 2 && pnlGross >= 0.9;
      const shouldTrimWeak = stage >= 1 && pnlGross >= 0.4 && legacySignalWeakening(sig);
      const tryLegacySell = async (ratio: number): Promise<boolean> => {
        if (!hasTickerL) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: "take_profit_blocked: stale mark price",
            payload: { market, bucket: "legacy", blockedReason: "missing ticker trade_price" },
          });
          return false;
        }
        const vol = legacyQty * Math.min(1, Math.max(0.01, ratio));
        if (vol * now < UPBIT_MIN_ORDER_KRW) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: "take_profit_blocked: order value below 5000 KRW",
            payload: {
              market,
              bucket: "legacy",
              intendedSellQty: vol,
              intendedSellValueKRW: vol * now,
              blockedReason: "order value below 5000 KRW",
            },
          });
          return false;
        }
        try {
          await opts.trade.placeLegacyExitSell!(market, true, ratio);
          return true;
        } catch {
          return false;
        }
      };
      try {
        if (shouldStage1) {
          if (await tryLegacySell(0.35)) state.legacy.exit_stage[market] = 1;
        } else if (shouldStage2) {
          if (await tryLegacySell(0.35)) state.legacy.exit_stage[market] = 2;
        } else if (shouldTrimWeak) {
          await tryLegacySell(0.5);
        }
      } catch {}
    }

    // exits — 익절/손절 판단은 업비트 보유 화면과 동일한 평단 대비 가격 변동률(gross) 기준
    for (const market of Object.keys(state.positions)) {
      const p = state.positions[market]!;
      const rawPx = priceBy.get(market);
      const hasTicker = typeof rawPx === "number" && Number.isFinite(rawPx) && rawPx > 0;
      if (!hasTicker) {
        continue;
      }
      const now = rawPx;
      const pnlGross = grossPnlPct(p.entry_price, now);
      p.max_pnl_pct = Math.max(p.max_pnl_pct, pnlGross);
      p.current_net_pnl_pct = pnlGross;
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
          pnl_pct: pnlGross,
          reason_enter: p.reason_enter,
          reason_exit: "highest_price_update",
          holding_minutes: minutesSince(p.entry_ts),
          signal_strength: p.signal_strength,
          volume_ratio: p.volume_ratio,
          strategy_tag: "live_data_mode_v1",
          strategy_type: p.strategy_type,
          stop_trigger_kind: null,
          current_net_pnl_pct: pnlGross,
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
      const weakModeTighterStop = (state.regime?.btc_filter_state ?? "neutral") === "weak" ? -0.9 : null;
      if (weakModeTighterStop !== null && pnlGross <= weakModeTighterStop) {
        reasonExit = "btc_weak_tight_stop";
        stopTriggerKind = "price_stop";
      }
      if (!reasonExit && p.strategy_type === "stable") {
        const xs = p.strict_exit ? STRICT_NEW_POSITION_EXIT.stable : null;
        const s = xs
          ? {
              breakeven_arm_pct: xs.breakeven_arm_pct,
              breakeven_floor_pct: xs.breakeven_floor_pct,
              partial_take_profit_pct: xs.partial_tp_pct,
              partial_take_profit_ratio: xs.partial_tp_ratio,
              trailing_from_peak_pct: xs.trailing_peak_pct,
            }
          : STRATEGY_RISK_CONFIG.stable;
        const weakHoldMin = xs ? xs.weak_hold_stop_minutes : STRATEGY_RISK_CONFIG.stable.weak_hold_stop_minutes;
        const recv = xs
          ? {
              giveup_minutes: xs.giveup_minutes,
              min_peak_pct_to_skip_catastrophic: xs.min_peak_pct_skip_catastrophic,
              catastrophic_exit_pct: xs.catastrophic_exit_pct,
            }
          : RECOVERY_EXIT_CONFIG.stable;

        if (xs) {
          if (holdMin >= xs.hard_stop_min_hold_min && pnlGross <= xs.hard_stop_pct) {
            reasonExit = "strict_hard_stop_loss";
            stopTriggerKind = "price_stop";
          }
          if (!reasonExit && holdMin >= xs.early_cut_minutes && p.max_pnl_pct < xs.early_cut_max_peak_pct && pnlGross <= xs.early_cut_pnl_pct) {
            reasonExit = "strict_early_loss_cut";
            stopTriggerKind = "price_stop";
          }
        }
        if (!reasonExit) {
          if (!p.breakeven_armed && pnlGross >= s.breakeven_arm_pct) {
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
              pnl_pct: pnlGross,
              reason_enter: p.reason_enter,
              reason_exit: "breakeven_armed",
              holding_minutes: holdMin,
              signal_strength: p.signal_strength,
              volume_ratio: p.volume_ratio,
              strategy_tag: "live_data_mode_v1",
              strategy_type: p.strategy_type,
              stop_trigger_kind: "breakeven_protect",
              current_net_pnl_pct: pnlGross,
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
              pnl_net_pct: pnlGross,
              note: p.strict_exit ? "stable breakeven armed (strict_new)" : "stable breakeven armed",
            });
          }
          p.trailing_stop_price = p.highest_price_after_entry * (1 - s.trailing_from_peak_pct / 100);
          if (!p.partial_tp_done && pnlGross >= s.partial_take_profit_pct) {
            reasonExit = p.strict_exit ? "partial_take_profit_1st_strict" : "partial_take_profit";
            ratio = s.partial_take_profit_ratio;
            stopTriggerKind = null;
          } else if (p.partial_tp_done && now <= p.trailing_stop_price) {
            reasonExit = p.strict_exit ? "trailing_runner_exit_strict" : "trailing_take_profit";
            stopTriggerKind = "time_stop";
          } else if (p.breakeven_armed && pnlGross <= s.breakeven_floor_pct) {
            reasonExit = "breakeven_exit";
            stopTriggerKind = "breakeven_protect";
          } else if (
            holdMin >= recv.giveup_minutes &&
            p.max_pnl_pct < recv.min_peak_pct_to_skip_catastrophic &&
            pnlGross <= recv.catastrophic_exit_pct
          ) {
            reasonExit = `stable_catastrophic_exit_${recv.catastrophic_exit_pct}`;
            stopTriggerKind = "price_stop";
          } else if (holdMin >= weakHoldMin && p.max_pnl_pct < 0.35 && pnlGross < 0) {
            reasonExit = "stable_time_stop_weak_rebound";
            stopTriggerKind = "time_stop";
          }
        }
      } else if (!reasonExit) {
        const xm = p.strict_exit ? STRICT_NEW_POSITION_EXIT.momentum : null;
        const m = xm
          ? {
              breakeven_arm_pct: xm.breakeven_arm_pct,
              breakeven_floor_pct: xm.breakeven_floor_pct,
              partial_take_profit_pct: xm.partial_tp_pct,
              partial_take_profit_ratio: xm.partial_tp_ratio,
              trailing_from_peak_pct: xm.trailing_peak_pct,
              time_stop_min_minutes: STRATEGY_RISK_CONFIG.momentum.time_stop_min_minutes,
              time_stop_max_minutes: STRATEGY_RISK_CONFIG.momentum.time_stop_max_minutes,
            }
          : STRATEGY_RISK_CONFIG.momentum;
        const recvM = xm
          ? {
              giveup_minutes: xm.giveup_minutes,
              min_peak_pct_to_skip_catastrophic: xm.min_peak_pct_skip_catastrophic,
              catastrophic_exit_pct: xm.catastrophic_exit_pct,
            }
          : RECOVERY_EXIT_CONFIG.momentum;

        if (xm) {
          if (holdMin >= xm.hard_stop_min_hold_min && pnlGross <= xm.hard_stop_pct) {
            reasonExit = "strict_hard_stop_loss";
            stopTriggerKind = "price_stop";
          }
          if (!reasonExit && holdMin >= xm.early_cut_minutes && p.max_pnl_pct < xm.early_cut_max_peak_pct && pnlGross <= xm.early_cut_pnl_pct) {
            reasonExit = "strict_early_loss_cut";
            stopTriggerKind = "price_stop";
          }
        }
        if (!reasonExit) {
          if (!p.breakeven_armed && pnlGross >= m.breakeven_arm_pct) {
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
              pnl_pct: pnlGross,
              reason_enter: p.reason_enter,
              reason_exit: "breakeven_armed",
              holding_minutes: holdMin,
              signal_strength: p.signal_strength,
              volume_ratio: p.volume_ratio,
              strategy_tag: "live_data_mode_v1",
              strategy_type: p.strategy_type,
              stop_trigger_kind: "breakeven_protect",
              current_net_pnl_pct: pnlGross,
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
              pnl_net_pct: pnlGross,
              note: p.strict_exit ? "momentum breakeven armed (strict_new)" : "momentum breakeven armed",
            });
          }
          p.trailing_stop_price = p.highest_price_after_entry * (1 - m.trailing_from_peak_pct / 100);
          if (!p.partial_tp_done && pnlGross >= m.partial_take_profit_pct) {
            reasonExit = p.strict_exit ? "partial_take_profit_1st_strict" : "partial_take_profit";
            ratio = m.partial_take_profit_ratio;
          } else if (p.partial_tp_done && now <= p.trailing_stop_price) {
            reasonExit = p.strict_exit ? "trailing_runner_exit_strict" : "trailing_take_profit";
            stopTriggerKind = "time_stop";
          } else if (p.breakeven_armed && pnlGross <= m.breakeven_floor_pct) {
            reasonExit = "momentum_breakeven_protect";
            stopTriggerKind = "breakeven_protect";
          } else if (
            holdMin >= recvM.giveup_minutes &&
            p.max_pnl_pct < recvM.min_peak_pct_to_skip_catastrophic &&
            pnlGross <= recvM.catastrophic_exit_pct
          ) {
            reasonExit = `momentum_catastrophic_exit_${recvM.catastrophic_exit_pct}`;
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
            if (!reasonExit && holdMin >= m.time_stop_min_minutes && holdMin <= m.time_stop_max_minutes && p.max_pnl_pct < 0.8 && pnlGross <= -0.1) {
              reasonExit = "momentum_time_stop";
              stopTriggerKind = "time_stop";
            }
          }
        }
      }
      if (!reasonExit) continue;

      const beforeQty = p.qty;
      const ratioClamped = Math.min(1, Math.max(0.01, ratio));
      const intendedSellQty = beforeQty * ratioClamped;
      const intendedSellValueKrw = intendedSellQty * now;
      const pnlNetUnit = netPnlPctPerUnit(p.entry_price, now);

      if (intendedSellQty <= 0) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "take_profit_blocked: quantity zero",
          payload: { market, reason_exit: reasonExit, quantity: beforeQty },
        });
        continue;
      }
      if (intendedSellValueKrw < UPBIT_MIN_ORDER_KRW) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "take_profit_blocked: order value below 5000 KRW",
          payload: {
            market,
            reason_exit: reasonExit,
            avg_buy_price: p.entry_price,
            current_price_used_for_display: now,
            current_price_used_for_sell_decision: now,
            quantity: beforeQty,
            pnl_percent_display: pnlGross,
            pnl_percent_sell_decision: pnlGross,
            net_pnl_percent_after_fees: pnlNetUnit,
            intended_sell_ratio: ratioClamped,
            intended_sell_qty: intendedSellQty,
            intended_sell_value_krw: intendedSellValueKrw,
            blockedReason: "order value below 5000 KRW",
          },
        });
        continue;
      }

      try {
        await opts.trade.placeSell(market, true, ratio);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "take_profit_blocked: sell_failed",
          payload: {
            market,
            reason_exit: reasonExit,
            error: msg.slice(0, 400),
            intended_sell_qty: intendedSellQty,
            intended_sell_value_krw: intendedSellValueKrw,
            blockedReason: "sell_failed",
          },
        });
        continue;
      }
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
          reasonExit === "partial_take_profit" || reasonExit === "partial_take_profit_1st_strict"
            ? "partial_take_profit"
            : reasonExit === "trailing_take_profit" || reasonExit === "trailing_runner_exit_strict"
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
        const cdMin = p.strict_exit
          ? STRICT_NEW_POSITION_EXIT.reentry_cooldown_minutes_after_close
          : STRATEGY_RISK_CONFIG.stable.reentry_cooldown_minutes_after_stop;
        state.cooldown_until[market] = new Date(Date.now() + cdMin * 60_000).toISOString();
      } else {
        if (!p.partial_tp_done && (reasonExit === "partial_take_profit" || reasonExit === "partial_take_profit_1st_strict")) {
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

    const exceptionSlot = state.regime?.exception_slot_market ?? null;
    const baseEntryUniverse = Array.from(
      new Set([...MARKETS, ...(exceptionSlot ? [exceptionSlot] : []), ...debugUniverseExtra]),
    );
    const heldMeaningfulMarkets = new Set<string>();
    if (DEBUG_EXCLUDE_HELD_SYMBOLS) {
      for (const b of Array.isArray(tstatus.balances) ? tstatus.balances : []) {
        const currency = String((b as any).currency ?? "").toUpperCase();
        if (!currency || currency === "KRW") continue;
        const mk = `KRW-${currency}`;
        const qty = Number((b as any).balance ?? 0);
        const px = Number(priceBy.get(mk) ?? (b as any).avg_buy_price ?? 0);
        const valueKrw = qty > 0 && px > 0 ? qty * px : 0;
        if (valueKrw >= EXISTING_POSITION_MIN_KRW) heldMeaningfulMarkets.add(mk);
      }
    }
    const entryUniverse = baseEntryUniverse.filter((m) => !heldMeaningfulMarkets.has(m));
    console.info(
      JSON.stringify({
        tag: "DEBUG_LIVE_CANDIDATE_UNIVERSE",
        debug_exclude_held_symbols: DEBUG_EXCLUDE_HELD_SYMBOLS,
        debug_include_universe_markets_env: DEBUG_INCLUDE_UNIVERSE_MARKETS,
        debug_include_universe_markets_resolved: debugUniverseExtra,
        held_filtered_markets: [...heldMeaningfulMarkets],
        entry_universe: entryUniverse,
      }),
    );
    for (const market of entryUniverse) {
      const emitEval = (tag: string, payload: Record<string, unknown>) => {
        console.info(
          JSON.stringify({
            tag,
            symbol: market,
            ts: new Date().toISOString(),
            ...payload,
          }),
        );
      };
      console.info(
        JSON.stringify({
          tag: "DEBUG_LIVE_SYMBOL_EVAL_START",
          symbol: market,
          ts: new Date().toISOString(),
          open_positions: Object.keys(state.positions).length,
        }),
      );
      if (Object.keys(state.positions).length >= state.safety_guard.max_positions) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "max_positions_reached" });
        break;
      }
      if (state.positions[market]) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "already_has_position" });
        continue;
      }
      const cool = state.cooldown_until[market];
      if (cool && Date.now() < Date.parse(cool)) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "cooldown_active", cooldown_until: cool });
        continue;
      }
      if ((state.daily.stop_by_market[market] ?? 0) >= 2) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "stop_count_limit_reached" });
        continue;
      }
      const isExceptionMarket = !LEADER_MARKETS.has(market);
      const coreOpenCount = Object.keys(state.positions).filter((m) => LEADER_MARKETS.has(m)).length;
      const exceptionOpenCount = Object.keys(state.positions).filter((m) => !LEADER_MARKETS.has(m)).length;
      if (isExceptionMarket && exceptionOpenCount >= 1) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "exception_slot_full" });
        continue;
      }
      if (!isExceptionMarket && coreOpenCount >= 1) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "core_slot_full", note: "max_one_core_symbol" });
        continue;
      }

      const sig = latestAllSignals.get(market);
      if (!sig) {
        const missingDetail = buildLiveSignalMissingDetail(market, logs);
        console.info(
          JSON.stringify({
            tag: "DEBUG_LIVE_SIGNAL_MISSING_DETAIL",
            symbol: market,
            ...missingDetail,
          }),
        );
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: String(missingDetail.primary_reason ?? "signal_missing"),
          signal_missing_detail: true,
        });
        continue;
      }
      const exception = state.regime?.exception_candidates.find((x) => x.market === market) ?? null;
      const rawStrength = signalStrengthScore(sig.p);
      if (rawStrength >= ENTRY_PIPELINE_MID_SCORE_FLOOR) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "candidate_detected",
          payload: {
            symbol: market,
            signal_strength_score: rawStrength,
            filter_pass: Boolean(sig.p.filter_pass),
          },
        });
        emitEval("candidate_detected", {
          signal_strength_score: rawStrength,
          filter_pass: Boolean(sig.p.filter_pass),
        });
      }
      if (rawStrength < ENTRY_PIPELINE_MID_SCORE_FLOOR) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "blocked_low_signal",
          payload: { symbol: market, signal_strength_score: rawStrength, floor: ENTRY_PIPELINE_MID_SCORE_FLOOR },
        });
        emitEval("blocked_low_signal", { signal_strength_score: rawStrength });
        continue;
      }
      if (marketState.market_state === "risk_off") {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_skipped_risk_off",
          payload: { symbol: market, market_state: marketState.market_state, note: "no_exception_entries" },
        });
        emitEval("entry_skipped_risk_off", { symbol: market, market_state: marketState.market_state });
        continue;
      }
      const sigTypeUpper = (sig.p.signal_type ?? "").toUpperCase();
      if (sigTypeUpper === "LOW") {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_blocked_signal_strength",
          payload: { symbol: market, signal_type: sigTypeUpper, reason: "LOW_never_enters" },
        });
        emitEval("entry_blocked_signal_strength", { symbol: market, signal_type: "LOW" });
        continue;
      }
      if (sigTypeUpper === "MID") {
        const gatePrev = opts.marketState.entryGate(sig.p, marketState);
        const composite = Number(gatePrev.score ?? 0);
        if (rawStrength < LIVE_ENTRY_SIGNAL_GATES.mid_min_raw_strength_score || composite < LIVE_ENTRY_SIGNAL_GATES.mid_min_entry_gate_score) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: "entry_blocked_signal_strength",
            payload: {
              symbol: market,
              signal_type: "MID",
              raw_strength: rawStrength,
              composite_score: composite,
              need_raw_gte: LIVE_ENTRY_SIGNAL_GATES.mid_min_raw_strength_score,
              need_composite_gte: LIVE_ENTRY_SIGNAL_GATES.mid_min_entry_gate_score,
            },
          });
          emitEval("entry_blocked_signal_strength", {
            symbol: market,
            signal_type: "MID",
            raw_strength: rawStrength,
            composite_score: composite,
          });
          continue;
        }
      }
      const filterPass = Boolean(sig.p.filter_pass);
      const signalTypeLow = (sig.p.signal_type ?? "").toUpperCase() === "LOW";
      const gate = opts.marketState.entryGate(sig.p, marketState);
      const baseGateOriginalResult = Boolean(gate.ok);
      const gateOk = DEBUG_FORCE_BASE_GATE ? true : baseGateOriginalResult;
      const signalScore = Number(gate.score ?? 0);
      const rel = (Number(changeRateBy.get(market) ?? 0) - btcChange) * 100;
      const vol = Number(sig.p.volume_ratio ?? 0);
      const reasonText = String(sig.p.signal_reason ?? "").toLowerCase();
      const breakout = reasonText.includes("breakout");
      const trendOk = reasonText.includes("breakout") || reasonText.includes("trend") || reasonText.includes("reclaim");
      const openForGate = Object.keys(state.positions).length;
      const minBaseScore = openForGate >= 1 ? 88 : 83;
      const minBaseVol = openForGate >= 1 ? 1.14 : 1.08;
      emitEval("DEBUG_LIVE_SIGNAL_SCORE", {
        score: Number(signalScore.toFixed(2)),
        volume_ratio: Number(vol.toFixed(3)),
        relative_strength: Number(rel.toFixed(3)),
        trend_ok: trendOk,
        breakout,
      });
      const strongSymbolOverride = signalScore >= 80 && rel >= 0.5 && vol >= 1.05 && trendOk;
      let detailedReason: string | null = null;
      if (!gateOk) {
        if (signalTypeLow || signalScore < minBaseScore) detailedReason = "score_below_threshold";
        else if (vol < minBaseVol) detailedReason = "volume_ratio_low";
        else if (!trendOk) detailedReason = "trend_not_ok";
        else if (!breakout) detailedReason = "no_breakout";
        else if (!filterPass || !baseGateOriginalResult) detailedReason = "base_gate_failed";
      }
      emitEval("DEBUG_LIVE_BASE_GATE_RESULT", {
        score: Number(signalScore.toFixed(2)),
        volume_ratio: Number(vol.toFixed(3)),
        relative_strength: Number(rel.toFixed(3)),
        trend_ok: trendOk,
        breakout,
        filter_pass: filterPass,
        signal_type: sig.p.signal_type ?? "MID",
        base_gate_ok: gateOk,
        base_gate_original_result: baseGateOriginalResult,
        base_gate_forced: DEBUG_FORCE_BASE_GATE,
        strong_symbol_override: strongSymbolOverride,
        return_reason: !gateOk && !strongSymbolOverride ? detailedReason ?? "base_gate_failed" : null,
      });
      await appendLog({
        company_id: companyIdSchema.parse(opts.companyId),
        service_id: serviceIdSchema.parse(opts.serviceId),
        ts: new Date().toISOString(),
        kind: "system",
        message: "DEBUG_STRONG_CHECK",
        payload: {
          symbol: market,
          volume_ratio: Number(vol.toFixed(3)),
          score: Number(signalScore.toFixed(2)),
          btc_state: btcTier,
          relative_strength: Number(rel.toFixed(3)),
          trend_ok: trendOk,
          gate_ok: gateOk,
          base_gate_original_result: baseGateOriginalResult,
          base_gate_forced: DEBUG_FORCE_BASE_GATE,
          strong_symbol_override: strongSymbolOverride,
        },
      });
      if (isExceptionMarket && !exception) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "exception_not_selected" });
        continue;
      }
      if (!gateOk && !strongSymbolOverride) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: detailedReason ?? "base_gate_failed" });
        continue;
      }

      let entryPipelineDetail: Record<string, unknown> = {};
      try {
        const candles5 = await fetchMinuteCandles(market, 5, 48);
        const pr = evaluateSpotLongEntryPipeline({
          market,
          payload: sig.p,
          candles5,
          marketState: {
            market_state: marketState.market_state,
            btc_5m_trend: marketState.btc_5m_trend ?? "flat",
            btc_15m_trend: marketState.btc_15m_trend ?? "flat",
          },
          volumeRatio: vol,
        });
        if (!pr.ok) {
          await appendLog({
            company_id: companyIdSchema.parse(opts.companyId),
            service_id: serviceIdSchema.parse(opts.serviceId),
            ts: new Date().toISOString(),
            kind: "system",
            message: pr.message,
            payload: pr.detail,
          });
          emitEval(pr.message, pr.detail);
          continue;
        }
        entryPipelineDetail = pr.detail;
      } catch (e) {
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "blocked_trend_filter",
          payload: {
            symbol: market,
            sub: "candles_fetch_failed",
            error: String(e).slice(0, 400),
          },
        });
        emitEval("blocked_trend_filter", { symbol: market, sub: "candles_fetch_failed" });
        continue;
      }

      const st = await opts.trade.status();
      const currency = market.replace("KRW-", "");
      const existingQty = Number(st.balances?.find((b: any) => b.currency === currency)?.balance ?? 0);
      const markPrice = Number(priceBy.get(market) ?? 0);
      const existingValueKrw = existingQty > 0 && markPrice > 0 ? existingQty * markPrice : 0;
      const meaningfulExistingHold = existingValueKrw >= EXISTING_POSITION_MIN_KRW;
      if (existingQty > 0) {
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: meaningfulExistingHold ? "account_existing_qty" : "account_existing_qty_dust_ignored",
          existing_qty: existingQty,
          existing_value_krw: Number(existingValueKrw.toFixed(2)),
          dust_ignored: !meaningfulExistingHold,
          existing_position_min_krw: EXISTING_POSITION_MIN_KRW,
        });
      }
      if (existingQty > 0 && meaningfulExistingHold) {
        continue; // no averaging / no existing hold
      }
      const liveOrderAvailableKrw = Math.max(0, Number(st.live_order_available_krw ?? st.krw_available ?? 0));
      let orderKrw = Math.floor(liveOrderAvailableKrw * 0.2);
      orderKrw = Math.max(5000, Math.min(30000, orderKrw));
      orderKrw = Math.floor(orderKrw * entrySizePct);
      if (isExceptionMarket) {
        orderKrw = Math.floor(orderKrw * 0.9);
      }
      if (orderKrw < 5000) {
        emitEval("DEBUG_LIVE_PRECHECK", { return_reason: "order_krw_below_min", order_krw: orderKrw });
        continue;
      }
      if (liveOrderAvailableKrw < orderKrw) {
        emitEval("DEBUG_LIVE_PRECHECK", {
          return_reason: "insufficient_live_order_krw",
          live_order_available_krw: liveOrderAvailableKrw,
          order_krw: orderKrw,
        });
        continue;
      }
      const strategyType: StrategyType = marketState.market_state === "risk_on" ? "momentum" : "stable";
      const signalPayloadForBuy = {
        ...sig.p,
        __allow_risk_scaled_entry: true,
        __strong_symbol_override: strongSymbolOverride,
        __risk_off_exception_reason: exception?.reason,
      };
      try {
        await opts.trade.placeBuy(market, true, orderKrw, strategyType, "strategy", signalPayloadForBuy);
        await appendLog({
          company_id: companyIdSchema.parse(opts.companyId),
          service_id: serviceIdSchema.parse(opts.serviceId),
          ts: new Date().toISOString(),
          kind: "system",
          message: "entry_opened",
          payload: {
            symbol: market,
            order_krw: orderKrw,
            strategy_type: strategyType,
            entry_pipeline: entryPipelineDetail,
          },
        });
        emitEval("entry_opened", { symbol: market, order_krw: orderKrw });
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
      const qty = Number(st2.balances?.find((b: any) => b.currency === currency)?.balance ?? 0);
      state.positions[market] = {
        market,
        strategy_type: strategyType,
        entry_ts: new Date().toISOString(),
        entry_price: price,
        qty,
        order_krw: orderKrw,
        reason_enter: exception
          ? `exception_slot_entry:${exception.reason}`
          : entrySizePct < 1
            ? `${sig.p.signal_reason ?? "signal_pass"}:btc_risk_scaled_${entrySizePct}`
            : sig.p.signal_reason ?? "signal_pass",
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
        strict_exit: true,
      };
      state.daily.entry_count += 1;
      state.cooldown_until[market] = new Date(Date.now() + (isExceptionMarket ? 28 : 18) * 60_000).toISOString();
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
        reason: exception ? exception.reason : sig.p.signal_reason ?? "signal_pass",
        balance_krw: Number(st2.krw_available ?? 0),
        position_qty: qty,
        avg_buy_price: price,
        current_price: price,
        pnl_net: 0,
        pnl_net_pct: 0,
        note: [
          "strategy entry",
          `btc_risk_scaled:${entrySizePct}`,
          strongSymbolOverride ? "strong_symbol_override" : null,
          exception ? "selective_entry_allowed" : null,
        ]
          .filter(Boolean)
          .join("|"),
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
