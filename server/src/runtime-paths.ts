import path from "node:path";

export function runtimeDir(): string {
  return path.join(process.cwd(), "data", "runtime");
}

export function surgeCandidatesRuntimePath(): string {
  return path.join(runtimeDir(), "surge-candidates.json");
}

export function liveExecutionStateRuntimePath(): string {
  return path.join(runtimeDir(), "live-execution-state.json");
}

