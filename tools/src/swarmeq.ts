import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindDashboardPort, bindState, discoverDashboard, readActivePort } from "./bind.ts";
import { attachRoutes } from "./http.ts";
import { PORT_FILE, PID_FILE, writeAtomic } from "./paths.ts";

const SUB = process.argv[2] || "";

async function ensureBind(knownActive?: number | null) {
  await bindDashboardPort(knownActive);
  attachRoutes();
  return bindState();
}

async function cmdMcp() {
  // Discover the dashboard, never bind one. If we bound 7778 here every
  // Claude Code session would silently spin up its own private dashboard
  // and SSE-broadcast reports into a void the real dashboard isn't reading.
  await discoverDashboard();
  const { startMcp } = await import("./mcp.ts");
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
  //
  // If a previous daemon died via SIGKILL or panic, the SIGTERM/exit
  // cleanup in bind.ts never ran and .port/.pid linger. The /healthz
  // identity check in readActivePort() correctly rejects them, but the
  // files themselves are still on disk; clear them up-front so the
  // bind loop and any concurrent reader see a clean slate.
  const active = await readActivePort();
  if (!active) {
    try { fs.unlinkSync(PORT_FILE()); } catch {}
    try { fs.unlinkSync(PID_FILE()); } catch {}
  }
  const s = await ensureBind(active);
  if (!s.bound) {
    // Lost the race — another daemon already owns the port. Just exit.
    return;
  }
  // Hold the port forever.
  await new Promise(() => {});
}

function spawnDaemon(): void {
  try {
    const child = spawn(process.execPath, [process.argv[1], "_daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (err) {
    process.stderr.write(`swarmeq dashboard: failed to spawn daemon: ${(err as Error).message}\n`);
  }
}

async function waitForPort(timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await readActivePort();
    if (p) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function openBrowser(url: string): void {
  const plat = os.platform();
  let cmd: string;
  let args: string[];
  if (plat === "darwin") { cmd = "open"; args = [url]; }
  else if (plat === "win32") { cmd = "cmd"; args = ["/c", "start", "", url]; }
  else { cmd = "xdg-open"; args = [url]; }
  // spawnSync, not detached spawn: the slash-command wrapper kills the
  // process tree as soon as the `!node ... dashboard` body returns, and
  // an asynchronously-spawned `open` child gets killed before LaunchServices
  // (or xdg-open/start) actually dispatches the URL. spawnSync keeps us
  // alive for the few ms `open` takes to hand off; by then the browser is
  // owned by a system daemon, not us, so it survives our subsequent exit.
  try {
    const r = spawnSync(cmd, args, { stdio: "ignore" });
    if (r.error) {
      process.stderr.write(`swarmeq dashboard: openBrowser failed (${cmd}): ${r.error.message}\n`);
    } else if (r.status !== null && r.status !== 0) {
      process.stderr.write(`swarmeq dashboard: openBrowser exited ${r.status} (${cmd})\n`);
    }
  } catch (err) {
    // Browser-open is best-effort; never throw.
    process.stderr.write(`swarmeq dashboard: openBrowser threw: ${(err as Error).message}\n`);
  }
}

// Canonical entry written into the user's settings.json. `${CLAUDE_PLUGIN_ROOT}`
// is expanded by Claude Code's plugin loader the same way it is in plugin.json,
// so the entry stays correct across plugin upgrades that change the unpacked
// path. Keeping this in code (rather than reading from plugin.json) means the
// installed entry is bit-identical across runs, which the idempotency check
// below relies on.
function canonicalMcpEntry(): { command: string; args: string[] } {
  return {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs", "mcp"],
  };
}

function userSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

interface Settings { mcpServers?: Record<string, unknown>; [k: string]: unknown }

function entriesEqual(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// Install path: writes user-scope mcpServers.swarmeq so team-subagent
// teammates pick up the swarmeq MCP server. Documented Claude Code rule:
// teammates load skills/MCP servers from project + user settings, not from
// agent-definition frontmatter. Plugin-manifest mcpServers alone is not
// enough — the user-scope settings.json is the only documented escape
// hatch from per-agent-type tool filtering.
async function cmdInstall() {
  const file = userSettingsPath();
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) {
    process.stderr.write(`swarmeq install: cannot create ${dir}: ${(err as Error).message}\n`);
    process.exit(1);
  }
  let existed = false;
  let existing: Settings = {};
  if (fs.existsSync(file)) {
    existed = true;
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (err) {
      process.stderr.write(`swarmeq install: cannot read ${file}: ${(err as Error).message}\n`);
      process.exit(1);
    }
    // Refuse to overwrite a malformed file — the user has handwritten
    // content here we can't safely preserve, and clobbering it would
    // destroy their work.
    try { existing = JSON.parse(raw) as Settings; }
    catch (err) {
      process.stderr.write(`swarmeq install: cannot parse ${file} (${(err as Error).message}). Refusing to overwrite; please fix the file by hand and re-run.\n`);
      process.exit(1);
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      process.stderr.write(`swarmeq install: ${file} is not a JSON object. Refusing to overwrite.\n`);
      process.exit(1);
    }
  }
  const canonical = canonicalMcpEntry();
  const currentMcp = (existing.mcpServers && typeof existing.mcpServers === "object")
    ? existing.mcpServers as Record<string, unknown>
    : {};
  if (entriesEqual(currentMcp.swarmeq, canonical)) {
    process.stdout.write(`swarmeq install: already installed at ${file}\n`);
    return;
  }
  if (existed) {
    const backup = `${file}.bak.${Date.now()}`;
    try { fs.copyFileSync(file, backup); process.stdout.write(`swarmeq install: backup written to ${backup}\n`); }
    catch (err) {
      process.stderr.write(`swarmeq install: cannot back up ${file}: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }
  const next: Settings = { ...existing, mcpServers: { ...currentMcp, swarmeq: canonical } };
  try { writeAtomic(file, JSON.stringify(next, null, 2) + "\n"); }
  catch (err) {
    process.stderr.write(`swarmeq install: cannot write ${file}: ${(err as Error).message}\n`);
    process.exit(1);
  }
  process.stdout.write(`swarmeq install: wrote ${file}. Restart active Claude Code sessions to pick up the new MCP server.\n`);
}

// Exported for tests.
export const _internals = { cmdInstall, canonicalMcpEntry, userSettingsPath, entriesEqual };

async function main() {
  switch (SUB) {
    case "mcp":       return cmdMcp();
    case "dashboard": return cmdDashboard();
    case "install":   return cmdInstall();
    case "_daemon":   return cmdDaemon();
    case "probe": {
      // Internal: invoked by the Stop hook. Forks a Claude session that
      // calls swarmeq.report once and exits. Fire-and-forget from the hook;
      // failures are logged to state/probe.log by startProbe itself, so the
      // outer catch is just to keep this CLI invocation from exiting non-zero
      // and noising up the parent hook.
      const agent = process.argv[3];
      if (!agent) { process.stderr.write("usage: swarmeq probe <agent>\n"); process.exit(2); }
      await discoverDashboard();
      const { startProbe } = await import("./probe.ts");
      try { await startProbe(agent); }
      catch (err) { process.stderr.write(`swarmeq probe: ${(err as Error).message}\n`); }
      return;
    }
    case "stop":      return (await import("./ops.ts")).stopServer();
    case "doctor":    return (await import("./doctor.ts")).runDoctor();
    default:
      process.stderr.write("usage: swarmeq <mcp|dashboard|install|stop|doctor>\n");
      process.exit(2);
  }
}

// Only run as a CLI when this module is the process entry point. Tests
// `import` swarmeq.ts to call _internals.cmdInstall directly; without
// this guard the top-level main() would fire on every import and dump
// the usage hint into the test output (or worse, mutate state).
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]); }
  catch { return false; }
}

if (isEntryPoint()) main().catch((err) => {
  process.stderr.write((err.stack || String(err)) + "\n");
  process.exit(1);
});
