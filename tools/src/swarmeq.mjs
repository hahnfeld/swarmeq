import { spawn } from "node:child_process";
import os from "node:os";
import { bindDashboardPort, bindState, readActivePort } from "./bind.mjs";
import { attachRoutes } from "./http.mjs";

const SUB = process.argv[2] || "";

async function ensureBind() {
  await bindDashboardPort();
  attachRoutes();
  return bindState();
}

async function cmdMcp() {
  await ensureBind();
  const { startMcp } = await import("./mcp.mjs");
  await startMcp();
  // startMcp() awaits connect() and returns; the stdio transport keeps the
  // process alive via the open stdin/stdout streams. Don't exit.
}

async function cmdDashboard() {
  const active = await readActivePort();
  if (active) {
    const url = `http://127.0.0.1:${active}`;
    process.stdout.write(`swarmeq dashboard: already running at ${url}\n`);
    openBrowser(url);
    return;
  }
  const s = await ensureBind();
  if (!s.bound) {
    process.stdout.write(`swarmeq dashboard: running at ${s.url}\n`);
    openBrowser(s.url);
    return;
  }
  process.stdout.write(`swarmeq dashboard: bound ${s.url}\n`);
  openBrowser(s.url);
  // Keep the foreground process alive.
  await new Promise(() => {});
}

function openBrowser(url) {
  const plat = os.platform();
  let cmd = null, args = [];
  if (plat === "darwin") { cmd = "open"; args = [url]; }
  else if (plat === "win32") { cmd = "cmd"; args = ["/c", "start", "", url]; }
  else { cmd = "xdg-open"; args = [url]; }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Browser-open is best-effort; never throw.
  }
}

async function main() {
  switch (SUB) {
    case "mcp":       return cmdMcp();
    case "dashboard": return cmdDashboard();
    case "check":     return (await import("./check.mjs")).runCheck();
    case "probe": {
      const agent = process.argv[3];
      if (!agent) { process.stderr.write("usage: swarmeq probe <agent>\n"); process.exit(2); }
      const { startProbe } = await import("./probe.mjs");
      return startProbe(agent);
    }
    case "poll":      return (await import("./ops.mjs")).configurePoll(process.argv[3]);
    case "stop":      return (await import("./ops.mjs")).stopServer();
    case "doctor":    return (await import("./doctor.mjs")).runDoctor();
    default:
      process.stderr.write("usage: swarmeq <mcp|dashboard|check|probe|poll|stop|doctor>\n");
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write((err.stack || String(err)) + "\n");
  process.exit(1);
});
