import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 동일 머신에서 trading 서버 프로세스가 두 개 떠서 스캔·로그가 두 배가 되는 것을 막는다.
 * `ORBITALPHA_TRADING_DISABLE_MONITOR_LOCK=1` 이면 비활성화 (테스트·특수 포트 병행 시).
 */
const LOCK_DIR = path.join(os.tmpdir(), "orbitalpha-trading");
const LOCK_FILE = path.join(LOCK_DIR, "signal-server.lock");

export type ProcessLockHandle = { release: () => void };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSignalServerProcessLock(): ProcessLockHandle | null {
  if (process.env.ORBITALPHA_TRADING_DISABLE_MONITOR_LOCK === "1") {
    return { release: () => {} };
  }

  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  } catch {
    return null;
  }

  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf8").trim();
      const oldPid = Number(raw);
      if (Number.isFinite(oldPid) && oldPid > 0 && isPidAlive(oldPid)) {
        return null;
      }
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* stale */
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
  } catch {
    return null;
  }

  const release = () => {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const cur = fs.readFileSync(LOCK_FILE, "utf8").trim();
        if (cur === String(process.pid)) fs.unlinkSync(LOCK_FILE);
      }
    } catch {
      /* noop */
    }
  };

  process.once("exit", release);
  return { release };
}
