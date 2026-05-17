import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dir = process.env.SWARMEQ_STATE_DIR || path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
fs.mkdirSync(dir, { recursive: true });
const REG = path.join(dir, "registry.json");
const PORT = path.join(dir, ".port");
const PID = path.join(dir, ".pid");

// Each hook is intentionally standalone (no imports from tools/src/), so these
// types are repeated rather than shared. Hook bundles must remain self-
// contained at runtime.
interface RegistryEntry {
  session_id: string;
  model: string;
  cwd: string;
  started_ts: number;
  last_seen_ts: number;
  last_probe_ts?: number;
}
type Registry = Record<string, RegistryEntry>;
interface HookEvent {
  session_id?: string;
  sessionId?: string;
  agent_name?: string;
  agentName?: string;
  model?: string;
  cwd?: string;
}

const sanitize = (s: unknown): string => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";

// Model ids must be passed verbatim to `claude --model` later. The 1M-context
// Opus variant arrives as `claude-opus-4-7[1m]`; sanitize() would mangle the
// brackets into `_1m_` and the CLI would 404 on the result. Strip a trailing
// `[...]` suffix instead, then keep only chars valid in a model id. Mirrored
// in tools/src/paths.ts:cleanModel; hooks are required to be import-free, so
// the definition is duplicated by design. Tested via paths.cleanModel.
const cleanModel = (s: unknown): string => {
  const raw = String(s || "").trim().replace(/\[[^\]]*\]$/, "");
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return cleaned || "unknown";
};

// Probe forks of agents re-enter this hook on session start. Don't register
// them as separate agents and don't open another browser tab.
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);

// Auto-install: write ~/.claude/settings.json mcpServers.swarmeq on first
// SessionStart that sees it missing. Without this, Agent Teams subagents
// can't see mcp__swarmeq__report (their tool catalog rebuilds from per-
// agent-type definitions and from user settings, not from plugin.json).
// Idempotent — re-runs are a single stat + JSON parse with no write. The
// lead session's plugin.json mcpServers already covers its own catalog;
// this hook covers every subsequent teammate session.
//
// Inlined rather than imported because hooks must be self-contained at
// runtime. The canonical entry shape is duplicated from
// tools/src/swarmeq.ts:canonicalMcpEntry on purpose.
function autoInstall(): void {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  let raw: string | null = null;
  try { raw = fs.readFileSync(file, "utf8"); } catch { /* missing is ok */ }
  let existing: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        existing = obj as Record<string, unknown>;
      } else {
        // Non-object JSON (e.g. an array). Don't touch it — let the user
        // notice via /swarmeq-doctor or the dashboard banner.
        process.stderr.write(`swarmeq: ${file} is not a JSON object; skipping auto-install. Run /swarmeq-install to retry.\n`);
        return;
      }
    } catch {
      // Malformed settings.json — refuse to overwrite the user's content.
      process.stderr.write(`swarmeq: cannot parse ${file}; skipping auto-install. Run /swarmeq-install after fixing.\n`);
      return;
    }
  }
  const mcp = (existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers))
    ? existing.mcpServers as Record<string, unknown>
    : null;
  if (mcp && mcp.swarmeq) return; // already installed; silent no-op
  // First-time install. Back up if the file exists, then atomic write.
  if (raw !== null) {
    const backup = `${file}.bak.${Date.now()}`;
    try { fs.copyFileSync(file, backup); }
    catch (err) {
      process.stderr.write(`swarmeq: cannot back up ${file}: ${(err as Error).message}. Skipping auto-install.\n`);
      return;
    }
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const next = {
    ...existing,
    mcpServers: {
      ...(mcp || {}),
      swarmeq: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs", "mcp"] },
    },
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    process.stderr.write(`swarmeq: cannot write ${file}: ${(err as Error).message}. Run /swarmeq-install to retry.\n`);
    return;
  }
  // One-line confirmation: visible in Claude Code's startup output so the
  // user sees what we did without being prompted.
  process.stderr.write(`swarmeq: auto-installed mcpServers.swarmeq into ${file} so Agent Teams teammates can call mcp__swarmeq__report. Restart sessions started before this point to pick up the change.\n`);
}
try { autoInstall(); } catch { /* never block the hook on install errors */ }

interface DaemonIdentity { pid: number; root: string; version: string }

async function probeDaemon(p: number): Promise<DaemonIdentity | null> {
  return new Promise<DaemonIdentity | null>((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: p, path: "/healthz", method: "GET", timeout: 500,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; if (body.length > 1024) { req.destroy(); resolve(null); } });
      res.on("end", () => {
        try {
          const obj = JSON.parse(body);
          if (!obj || obj.service !== "swarmeq") return resolve(null);
          resolve({ pid: Number(obj.pid) || 0, root: String(obj.root || ""), version: String(obj.version || "") });
        } catch { resolve(null); }
      });
    });
    req.once("error", () => resolve(null));
    req.once("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function portReleased(p: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: p });
    sock.once("connect", () => { sock.end(); resolve(false); });
    sock.once("error", () => resolve(true));
    sock.setTimeout(200, () => { sock.destroy(); resolve(true); });
  });
}

// Root-based daemon identity was retired in 0.3.6 — Claude Code unpacks each
// session's plugin into its own /tmp/claude-plugin-session-<hash>/ directory,
// so a parent and its N team subagents all compute different CLAUDE_PLUGIN_ROOT
// values pointing at the same plugin install. Comparing roots made every
// subagent treat the running daemon as foreign, SIGTERM it, and respawn —
// the dashboard's SSE connection drops on every cycle, ending in "reconnecting"
// forever. Version match is the durable signal: a real upgrade bumps it,
// per-session unpack does not. Hooks stay zero-import, so read plugin.json
// inline rather than calling the helper exported from paths.ts.
function readLocalVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
    return String(pkg.version || "");
  } catch { return ""; }
}

function sameInstall(id: DaemonIdentity, root: string): boolean {
  const localVersion = readLocalVersion(root);
  if (!localVersion) return true;  // can't read our version, fail safe — don't kill a working daemon
  if (!id.version) return false;    // pre-0.3.3 daemon, no identity — let the upgrade path evict it
  return id.version === localVersion;
}

// Cold-start: spawn the daemon if nothing is running. Never the `dashboard`
// subcommand — that would call openBrowser, and team subagents fan out N
// concurrent SessionStart hooks, each racing past the port-file check before
// the first daemon binds. Result: N browser tabs. The browser is opened
// only by the explicit `/swarmeq-dashboard` slash command from now on.
// Upgrade path: if a daemon at a different version is running, kill it and
// respawn ours; existing dashboard tabs reconnect via SSE.
async function ensureDashboard() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return;
  const script = path.join(root, "server", "swarmeq.mjs");
  if (!fs.existsSync(script)) return;
  let port = 0;
  try { port = parseInt(fs.readFileSync(PORT, "utf8"), 10); } catch {}
  if (port) {
    const id = await probeDaemon(port);
    if (id && sameInstall(id, root)) return; // healthy daemon at our version
    if (id) {
      // Stale daemon from an earlier install (or pre-identity build that
      // didn't expose root). Evict; the bind attempt below will succeed.
      if (id.pid > 0) { try { process.kill(id.pid, "SIGTERM"); } catch {} }
      for (let i = 0; i < 30; i++) {
        if (await portReleased(port)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      try { fs.unlinkSync(PORT); } catch {}
      try { fs.unlinkSync(PID); } catch {}
    }
  }
  try {
    const child = spawn("node", [script, "_daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch { /* best-effort; never block the hook */ }
}

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => { body += c; });
process.stdin.on("end", async () => {
  try {
    const evt: HookEvent = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg: Registry = {};
    try { reg = JSON.parse(fs.readFileSync(REG, "utf8")); } catch {}
    reg[agent] = {
      session_id: sid,
      model: cleanModel(evt.model || process.env.ANTHROPIC_MODEL || "unknown"),
      cwd: evt.cwd || process.cwd(),
      started_ts: Date.now(),
      last_seen_ts: Date.now(),
    };
    const tmp = REG + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REG);
  } catch { /* hooks never block */ }
  await ensureDashboard();
  process.exit(0);
});
