import type { SignalLogEntry } from "@orbitalpha/shared";
import { UI } from "../ui-constants";

export function SignalHistorySection<TParsed extends { p: { market: string; filter_pass?: boolean; signal_type?: string } }>(props: {
  recentFillRows: SignalLogEntry[];
  latestCycleRows: Array<{ entry: SignalLogEntry; parsed: TParsed }>;
  parseSignalPayload: (row: SignalLogEntry) => TParsed | null;
  isPass: (parsed: TParsed) => boolean;
  isNearMissFiveOfSix: (parsed: TParsed) => boolean;
  getCardFailReason: (parsed: TParsed | null | undefined) => string;
  formatTsLocal: (ts: string) => string;
  paperStats?: unknown[];
  autoTradeEnabled?: boolean;
}) {
  const { recentFillRows, latestCycleRows, parseSignalPayload, isPass, isNearMissFiveOfSix, getCardFailReason, formatTsLocal, paperStats, autoTradeEnabled } = props;

  const renderSignalRow = (entry: SignalLogEntry, parsed: TParsed | null, isLatest: boolean) => {
    if (!parsed) return null;

    const pass = isPass(parsed);
    const near = !pass && isNearMissFiveOfSix(parsed);
    const status = pass ? "통과" : near ? "관찰" : "탈락";
    const statusColor = pass ? "#4ade80" : near ? "#facc15" : "#f87171";
    const market = parsed.p.market ? parsed.p.market.replace("KRW-", "") : "UNK";
    const reason = !pass ? getCardFailReason(parsed) : "정상";

    // 원형 필터 통과 여부
    const circularPass = parsed.p.filter_pass === true;
    const circularColor = circularPass ? UI.pass : UI.fail;

    // 실거래 ON 상태
    const isLive = autoTradeEnabled;

    // 경험치 참고 및 Live 판단 (Best effort matching)
    // Surge 신호(spot_mvp_v1)인 경우에만 표시
    const isSurge = parsed.p.signal_type === "spot_mvp_v1";
    let liveLabel = "-";
    let liveColor: string = UI.mutedSoft;
    let hasRef = false;

    if (isSurge && paperStats && paperStats.length > 0) {
      hasRef = true;
      liveLabel = "관찰"; 
      liveColor = UI.muted;
    }

    return (
      <div
        key={`${entry.ts}-${isLatest ? "latest" : "fill"}-${market}`}
        style={{
          display: "grid",
          gridTemplateColumns: "142px 42px 52px 100px 30px 40px 1fr",
          gap: 10,
          alignItems: "center",
          padding: "0.38rem 0.48rem",
          background: UI.cardSoftBg,
          borderRadius: 6,
          fontSize: "0.78rem",
          border: "1px solid #28456f",
        }}
      >
        <span style={{ color: UI.mutedSoft }}>{formatTsLocal(entry.ts)}</span>
        <strong style={{ color: UI.title, fontWeight: 800 }}>{market}</strong>
        <span style={{ color: statusColor, fontWeight: 800 }}>{status}</span>
        
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ color: circularColor, fontSize: "0.65rem", border: `1px solid ${circularColor}`, padding: "0 3px", borderRadius: 3 }}>원형{circularPass ? "O" : "X"}</span>
          {hasRef && <span style={{ color: UI.accent, fontSize: "0.65rem", border: `1px solid ${UI.accent}`, padding: "0 3px", borderRadius: 3 }}>Ref</span>}
        </div>

        <span style={{ color: liveColor, fontWeight: 700, fontSize: "0.65rem" }}>{liveLabel}</span>
        
        {isLive ? (
          <span style={{ color: UI.pass, fontSize: "0.65rem", fontWeight: 900 }}>LIVE</span>
        ) : (
          <span style={{ color: UI.mutedSoft, fontSize: "0.65rem" }}>OFF</span>
        )}

        <span style={{ color: UI.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.72rem" }}>{reason}</span>
      </div>
    );
  };

  return (
    <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem", marginBottom: "0.9rem" }}>
      <article
        style={{
          background: UI.cardBg,
          border: `1px solid ${UI.border}`,
          borderRadius: 12,
          padding: "0.8rem 1rem",
          boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.32)",
        }}
      >
        <div style={{ height: 1, marginBottom: "0.55rem", background: "linear-gradient(90deg, #38bdf8, transparent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.55rem" }}>
          <div style={{ fontSize: "0.88rem", color: UI.title, fontWeight: 800, letterSpacing: "0.02em" }}>최근 통과 신호</div>
          <div style={{ fontSize: "0.74rem", color: UI.mutedSoft }}>통과 기준</div>
        </div>
        {recentFillRows.length === 0 ? (
          <p style={{ color: "#94a3b8", margin: 0, fontSize: "0.84rem" }}>최근 통과 없음</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recentFillRows.map((entry) => renderSignalRow(entry, parseSignalPayload(entry), false))}
          </div>
        )}
      </article>

      <article
        style={{
          background: UI.cardBg,
          border: `1px solid ${UI.border}`,
          borderRadius: 12,
          padding: "0.8rem 1rem",
          boxShadow: "0 0 0 1px #1b3558 inset, 0 10px 24px rgba(2, 6, 23, 0.32)",
        }}
      >
        <div style={{ height: 1, marginBottom: "0.55rem", background: "linear-gradient(90deg, #60a5fa, transparent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.55rem" }}>
          <div style={{ fontSize: "0.88rem", color: UI.title, fontWeight: 800, letterSpacing: "0.02em" }}>최근 전체 신호</div>
          <div style={{ fontSize: "0.74rem", color: UI.mutedSoft }}>최신순</div>
        </div>
        {latestCycleRows.length === 0 ? (
          <p style={{ color: "#94a3b8", margin: 0, fontSize: "0.84rem" }}>신호 로그 없음</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {latestCycleRows.map(({ entry, parsed }) => renderSignalRow(entry, parsed, true))}
          </div>
        )}
      </article>
    </section>
  );
}

