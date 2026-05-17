import { spawn } from "node:child_process";
import os from "node:os";
import { bindDashboardPort, bindState, discoverDashboard, readActivePort } from "./bind.mjs";
import { attachRoutes } from "./http.mjs";

const SUB = process.argv[2] || "";

async function ensureBind() {
  await bindDashboardPort();
  attachRoutes();
  return bindState();
}

async function cmdMcp() {
  // Discover the dashboard, never bind one. If we bound 7778 here every
  // Claude Code session would silently spin up its own private dashboard
  // and SSE-broadcast reports into a void the real dashboard isn't reading.
  await discoverDashboard();
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
    case "probe-all": {
      // Discover the dashboard so probe-failed broadcasts have a listener,
      // mirroring how cmdMcp avoids binding its own port.
      await discoverDashboard();
      const { startProbeAll } = await import("./probe.mjs");
      const agents = startProbeAll();
      process.stdout.write(`swarmeq probe-all: dispatched ${agents.length} agent${agents.length === 1 ? "" : "s"}${agents.length ? " (" + agents.join(", ") + ")" : ""}\n`);
      return;
    }
    case "poll":      return (await import("./ops.mjs")).configurePoll(process.argv[3]);
    case "stop":      return (await import("./ops.mjs")).stopServer();
    case "doctor":    return (await import("./doctor.mjs")).runDoctor();
    default:
      process.stderr.write("usage: swarmeq <mcp|dashboard|check|probe|probe-all|poll|stop|doctor>\n");
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write((err.stack || String(err)) + "\n");
  process.exit(1);
});
