import path from "node:path";

export function runtimeRoot(): string {
  const envRoot = String(process.env.ORBITALPHA_TRADING_RUNTIME_ROOT ?? "").trim();
  if (envRoot) return path.resolve(envRoot);
  const cwd = process.cwd();
  const serverRoot = path.basename(cwd).toLowerCase() === "server" ? cwd : path.join(cwd, "server");
  return path.join(serverRoot, "data", "runtime");
}

export function runtimeDir(): string {
  return runtimeRoot();
}

export function surgeCandidatesRuntimePath(): string {
  return path.join(runtimeDir(), "surge-candidates.json");
}

export function liveExecutionStateRuntimePath(): string {
  return path.join(runtimeDir(), "live-execution-state.json");
}

