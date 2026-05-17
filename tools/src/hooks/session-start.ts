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

// Symlinks, trailing-slash drift, or /var-vs-/private/var on macOS make raw
// string compare of pluginRoot too noisy: a single team can have a parent
// session and N subagents each computing CLAUDE_PLUGIN_ROOT slightly
// differently and tripping the "stale daemon, kill it" path, which kills the
// live daemon and forces every open dashboard tab into "reconnecting" state.
function rootsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

// Cold-start: spawn the daemon if nothing is running. Never the `dashboard`
// subcommand — that would call openBrowser, and team subagents fan out N
// concurrent SessionStart hooks, each racing past the port-file check before
// the first daemon binds. Result: N browser tabs. The browser is opened
// only by the explicit `/swarmeq-dashboard` slash command from now on.
// Upgrade path: if a daemon from a different plugin install is running, kill
// it and respawn ours; existing dashboard tabs reconnect via SSE.
async function ensureDashboard() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return;
  const script = path.join(root, "server", "swarmeq.mjs");
  if (!fs.existsSync(script)) return;
  let port = 0;
  try { port = parseInt(fs.readFileSync(PORT, "utf8"), 10); } catch {}
  if (port) {
    const id = await probeDaemon(port);
    if (id && rootsMatch(id.root, root)) return; // healthy daemon owned by this install
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
