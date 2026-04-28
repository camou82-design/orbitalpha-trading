import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

export function atomicWriteJson(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return (raw ? (JSON.parse(raw) as T) : null) ?? null;
  } catch {
    return null;
  }
}

