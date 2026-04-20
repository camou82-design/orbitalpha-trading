import type { SignalLogEntry } from "@orbitalpha/shared";
import { UI } from "../ui-constants";

export function SignalHistorySection<TParsed extends { p: { market: string } }>(props: {
  recentFillRows: SignalLogEntry[];
  latestCycleRows: Array<{ entry: SignalLogEntry; parsed: TParsed }>;
  parseSignalPayload: (row: SignalLogEntry) => TParsed | null;
  isPass: (parsed: TParsed) => boolean;
  isNearMissFiveOfSix: (parsed: TParsed) => boolean;
  getCardFailReason: (parsed: TParsed | null | undefined) => string;
  formatTsLocal: (ts: string) => string;
}) {
  const { recentFillRows, latestCycleRows, parseSignalPayload, isPass, isNearMissFiveOfSix, getCardFailReason, formatTsLocal } = props;
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
            {recentFillRows.map((entry) => {
              const parsed = parseSignalPayload(entry);
              const pass = parsed ? isPass(parsed) : false;
              const near = parsed ? !pass && isNearMissFiveOfSix(parsed) : false;
              const status = pass ? "통과" : near ? "관찰" : "탈락";
              const statusColor = pass ? "#4ade80" : near ? "#facc15" : "#f87171";
              const market = parsed?.p?.market ? parsed.p.market.replace("KRW-", "") : "UNK";
              const reason = parsed ? (!pass ? getCardFailReason(parsed) : "정상") : "payload 파싱 실패";
              return (
                <div
                  key={`${entry.ts}-${entry.message}-${market}`}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "0.38rem 0.48rem",
                    background: UI.cardSoftBg,
                    borderRadius: 6,
                    fontSize: "0.78rem",
                    border: "1px solid #28456f",
                  }}
                >
                  <span style={{ color: UI.mutedSoft, minWidth: 142 }}>{formatTsLocal(entry.ts)}</span>
                  <strong style={{ color: UI.title, fontWeight: 800, minWidth: 42 }}>{market}</strong>
                  <span style={{ color: statusColor, fontWeight: 800, minWidth: 52 }}>{status}</span>
                  <span style={{ color: UI.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>
                </div>
              );
            })}
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
            {latestCycleRows.map(({ entry, parsed }) => {
              const pass = isPass(parsed);
              const near = !pass && isNearMissFiveOfSix(parsed);
              const status = pass ? "통과" : near ? "관찰" : "탈락";
              const statusColor = pass ? "#4ade80" : near ? "#facc15" : "#f87171";
              const market = parsed.p.market.replace("KRW-", "");
              const reason = !pass ? getCardFailReason(parsed) : "정상";
              return (
                <div
                  key={`${entry.ts}-sig-${market}`}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: "0.34rem 0.46rem",
                    background: UI.cardSoftBg,
                    borderRadius: 6,
                    fontSize: "0.76rem",
                    border: "1px solid #28456f",
                  }}
                >
                  <span style={{ color: UI.mutedSoft, minWidth: 142 }}>{formatTsLocal(entry.ts)}</span>
                  <strong style={{ color: UI.title, fontWeight: 800, minWidth: 42 }}>{market}</strong>
                  <span style={{ color: statusColor, fontWeight: 800, minWidth: 52 }}>{status}</span>
                  <span style={{ color: UI.body, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>
                </div>
              );
            })}
          </div>
        )}
      </article>
    </section>
  );
}
