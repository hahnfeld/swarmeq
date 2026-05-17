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
  // Foreground command — must never block. The slash command invokes us
  // synchronously via `!node ... dashboard`; if we held the port here we'd
  // stall Claude Code's UI until the user killed the dashboard. So if no
  // daemon is running we fork one detached and exit as soon as it's reachable.
  let active = await readActivePort();
  let spawnedDaemon = false;
  if (!active) {
    spawnDaemon();
    spawnedDaemon = true;
    active = await waitForPort(3000);
  }
  if (!active) {
    process.stderr.write("swarmeq dashboard: daemon did not start within 3s; try `node server/swarmeq.mjs doctor`\n");
    process.exit(1);
  }
  const url = `http://127.0.0.1:${active}`;
  process.stdout.write(`swarmeq dashboard: ${spawnedDaemon ? "started" : "already running"} at ${url}\n`);
  openBrowser(url);
}

async function cmdDaemon() {
  // Internal subcommand — the long-lived background process that actually
  // binds the port and serves the dashboard. Spawned detached from
  // `cmdDashboard` and from the session-start hook.
  const s = await ensureBind();
  if (!s.bound) {
    // Lost the race — another daemon already owns the port. Just exit.
    return;
  }
  // Hold the port forever.
  await new Promise(() => {});
}

function spawnDaemon() {
  try {
    const child = spawn(process.execPath, [process.argv[1], "_daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (err) {
    process.stderr.write(`swarmeq dashboard: failed to spawn daemon: ${err.message}\n`);
  }
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await readActivePort();
    if (p) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
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
    case "_daemon":   return cmdDaemon();
    case "probe": {
      // Internal: invoked by the Stop hook. Forks a Claude session that
      // calls swarmeq.report once and exits. Fire-and-forget from the hook;
      // any failure broadcasts probe-failed to the dashboard.
      const agent = process.argv[3];
      if (!agent) { process.stderr.write("usage: swarmeq probe <agent>\n"); process.exit(2); }
      await discoverDashboard();
      const { startProbe } = await import("./probe.mjs");
      try { await startProbe(agent); } catch { /* error already broadcast */ }
      return;
    }
    case "stop":      return (await import("./ops.mjs")).stopServer();
    case "doctor":    return (await import("./doctor.mjs")).runDoctor();
    default:
      process.stderr.write("usage: swarmeq <mcp|dashboard|stop|doctor>\n");
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write((err.stack || String(err)) + "\n");
  process.exit(1);
});
