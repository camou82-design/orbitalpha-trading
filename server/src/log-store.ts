import fs from "node:fs/promises";
import path from "node:path";
import type { SignalLogEntry } from "@orbitalpha/shared";
import { signalLogEntrySchema } from "@orbitalpha/shared";
import { tradingDataRoot } from "./paths.js";

/**
 * 모든 JSONL 행에 `company_id` + `service_id` 포함. `readRecentLogs`는 **항상 두 키로만** 스코프한다.
 * shopping 등 다른 서비스 라인과 레코드를 섞지 않는다.
 */

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function appendLog(entry: SignalLogEntry): Promise<void> {
  const parsed = signalLogEntrySchema.parse(entry);
  const day = parsed.ts.slice(0, 10);
  const dir = path.join(
    tradingDataRoot(),
    "logs",
    safeSegment(parsed.company_id),
    safeSegment(parsed.service_id),
  );
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${day}.jsonl`);
  await fs.appendFile(file, `${JSON.stringify(parsed)}\n`, "utf8");
}

export async function readRecentLogs(
  companyId: string,
  serviceId: string,
  limit: number,
): Promise<SignalLogEntry[]> {
  const dir = path.join(
    tradingDataRoot(),
    "logs",
    safeSegment(companyId),
    safeSegment(serviceId),
  );
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const out: SignalLogEntry[] = [];
  for (const name of names) {
    if (out.length >= limit) break;
    const text = await fs.readFile(path.join(dir, name), "utf8");
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const row = JSON.parse(lines[i]!) as unknown;
        out.push(signalLogEntrySchema.parse(row));
      } catch {
        continue;
      }
    }
  }
  return out;
}
