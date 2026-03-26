"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";

const apiBase =
  process.env.NEXT_PUBLIC_ORBITALPHA_TRADING_API_BASE?.replace(/\/$/, "") ??
  process.env.NEXT_PUBLIC_ORBITALPHA_API_BASE?.replace(/\/$/, "") ??
  "";

type ReplayEvent = {
  timestamp: string;
  event_type: string;
  market?: string | null;
  strategy_type?: string | null;
  market_state?: string | null;
  side?: string | null;
  reason?: string | null;
  note?: string | null;
  pnl_net?: number | null;
  pnl_net_pct?: number | null;
};

type ReplaySnapshot = {
  timestamp: string;
  market_state?: string | null;
  balance_krw?: number;
  total_asset_krw?: number;
  auto_trade_enabled?: boolean;
  open_markets?: string[];
};

type ReplayItem =
  | { kind: "event"; ts: string; event: ReplayEvent }
  | { kind: "snapshot"; ts: string; snapshot: ReplaySnapshot };

const HIGHLIGHT: Record<string, string> = {
  signal_triggered: "#38bdf8",
  order_attempt: "#f59e0b",
  order_filled: "#22c55e",
  stop_loss: "#ef4444",
  partial_take_profit: "#22c55e",
  trailing_take_profit: "#10b981",
  auto_trade_stopped: "#ef4444",
  api_error: "#ef4444",
};

export default function ReplayPage() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const today = now.toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState(`${hh}:${mm}`);
  const [market, setMarket] = useState("ALL");
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [snapshots, setSnapshots] = useState<ReplaySnapshot[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 5 | 10>(1);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  const items = useMemo(() => {
    const merged: ReplayItem[] = [];
    for (const e of events) merged.push({ kind: "event", ts: e.timestamp, event: e });
    for (const s of snapshots) merged.push({ kind: "snapshot", ts: s.timestamp, snapshot: s });
    return merged.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }, [events, snapshots]);

  const current = items[idx] ?? null;
  const currentSnapshot = useMemo(() => {
    if (!items.length) return null;
    for (let i = idx; i >= 0; i--) {
      const it = items[i];
      if (it?.kind === "snapshot") return it.snapshot;
    }
    return null;
  }, [items, idx]);

  const loadReplay = async () => {
    setBusy(true);
    try {
      const start = `${date}T${startTime}:00`;
      const end = `${date}T${endTime}:59`;
      const q = new URLSearchParams({ start, end, market });
      const res = await fetch(`${apiBase}/api/v1/replay/query?${q.toString()}`, {
        cache: "no-store",
        credentials: "include",
      });
      const body = await res.json();
      if (!res.ok || body?.ok !== true) throw new Error(body?.error ?? "replay query failed");
      setEvents((body.events ?? []) as ReplayEvent[]);
      setSnapshots((body.snapshots ?? []) as ReplaySnapshot[]);
      setIdx(0);
      setPlaying(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  const stepNext = () => {
    setIdx((prev) => Math.min(prev + 1, Math.max(0, items.length - 1)));
  };

  const togglePlay = () => {
    const next = !playing;
    setPlaying(next);
    if (!next) {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setIdx((prev) => {
        if (prev >= items.length - 1) return prev;
        return prev + 1;
      });
    }, Math.max(150, 1000 / speed));
  };

  const recentEvents = useMemo(
    () =>
      events
        .filter((e) => Date.parse(e.timestamp) <= Date.parse(current?.ts ?? "9999-01-01"))
        .slice(-12)
        .reverse(),
    [events, current],
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "radial-gradient(1200px 700px at 20% -10%, #1d4ed833 0%, #070d1b 48%, #02050d 100%)",
        color: "#d6e7ff",
        padding: "1rem",
      }}
    >
      <section style={{ maxWidth: 1240, margin: "0 auto", background: "linear-gradient(180deg, #0b1428 0%, #081125 100%)", border: "1px solid #2b4d7a", borderRadius: 14, padding: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 900, color: "#f1f7ff" }}>수동 리플레이 테스트</div>
          <Link href="/trading" style={{ color: "#67e8f9", fontSize: "0.84rem", textDecoration: "none" }}>
            /trading 돌아가기
          </Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 8, marginBottom: 12 }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            <option value="ALL">전체</option>
            <option value="KRW-BTC">BTC</option>
            <option value="KRW-ETH">ETH</option>
            <option value="KRW-XRP">XRP</option>
            <option value="KRW-TRX">TRX</option>
          </select>
          <button onClick={() => void loadReplay()} disabled={busy}>{busy ? "조회중..." : "구간 불러오기"}</button>
          <button onClick={togglePlay} disabled={!items.length}>{playing ? "일시정지" : "재생"}</button>
          <button onClick={stepNext} disabled={!items.length}>다음 이벤트</button>
          <select value={String(speed)} onChange={(e) => setSpeed(Number(e.target.value) as 1 | 5 | 10)}>
            <option value="1">1x</option>
            <option value="5">5x</option>
            <option value="10">10x</option>
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 12 }}>
          <article style={{ border: "1px solid #1f3c63", borderRadius: 10, padding: "0.8rem", background: "#0f2240" }}>
            <div style={{ fontSize: "0.82rem", color: "#8ea9d1", marginBottom: 6 }}>현재 시점</div>
            <div style={{ fontSize: "0.96rem", fontWeight: 800, marginBottom: 8 }}>{current?.ts ?? "-"}</div>
            <div style={{ fontSize: "0.82rem", color: "#8ea9d1" }}>시장 상태</div>
            <div style={{ marginBottom: 6 }}>{currentSnapshot?.market_state ?? "-"}</div>
            <div style={{ fontSize: "0.82rem", color: "#8ea9d1" }}>보유 KRW / 총자산</div>
            <div style={{ marginBottom: 6 }}>
              {Math.round(currentSnapshot?.balance_krw ?? 0).toLocaleString()} / {Math.round(currentSnapshot?.total_asset_krw ?? 0).toLocaleString()}
            </div>
            <div style={{ fontSize: "0.82rem", color: "#8ea9d1" }}>현재 이벤트</div>
            {current?.kind === "event" ? (
              <div>
                <div style={{ color: HIGHLIGHT[current.event.event_type] ?? "#d6e7ff", fontWeight: 800 }}>{current.event.event_type}</div>
                <div>종목: {current.event.market ?? "-"}</div>
                <div>전략: {current.event.strategy_type ?? "-"}</div>
                <div>사유: {current.event.reason ?? "-"}</div>
                <div>순손익률: {typeof current.event.pnl_net_pct === "number" ? `${current.event.pnl_net_pct.toFixed(2)}%` : "-"}</div>
              </div>
            ) : (
              <div>snapshot</div>
            )}
          </article>

          <article style={{ border: "1px solid #1f3c63", borderRadius: 10, padding: "0.8rem", background: "#0f2240" }}>
            <div style={{ fontSize: "0.82rem", color: "#8ea9d1", marginBottom: 6 }}>
              이벤트 타임라인 ({idx + 1}/{Math.max(1, items.length)})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 520, overflow: "auto" }}>
              {recentEvents.map((e, i) => (
                <div key={`${e.timestamp}-${i}`} style={{ border: "1px solid #28456f", borderRadius: 6, padding: "0.4rem 0.5rem", background: "#102241" }}>
                  <div style={{ fontSize: "0.74rem", color: "#8ea9d1" }}>{new Date(e.timestamp).toLocaleString("ko-KR", { hour12: false })}</div>
                  <div style={{ color: HIGHLIGHT[e.event_type] ?? "#d6e7ff", fontWeight: 800 }}>{e.event_type}</div>
                  <div style={{ fontSize: "0.78rem" }}>
                    {e.market ?? "-"} / {e.strategy_type ?? "-"} / {e.reason ?? "-"}
                  </div>
                  <div style={{ fontSize: "0.76rem", color: "#9fb6d8" }}>{e.note ?? ""}</div>
                </div>
              ))}
              {!recentEvents.length ? <div style={{ color: "#8ea9d1" }}>선택 구간 이벤트 없음</div> : null}
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}

