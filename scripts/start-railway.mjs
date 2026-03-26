import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const port = process.env.PORT || "3000";
const apiPort = process.env.ORBITALPHA_TRADING_PORT || "8787";

const children = [];

function run(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: true,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
}

function shutdown(code = 0) {
  for (const c of children) {
    if (!c.killed) c.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("server", "npm", ["run", "start", "-w", "@orbitalpha/server"], {
  ORBITALPHA_TRADING_PORT: apiPort,
});
run("dashboard", "npm", ["run", "start", "-w", "@orbitalpha/dashboard"], {
  PORT: port,
});
