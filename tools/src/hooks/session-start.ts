import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

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
  // Display metadata (0.6.0+). Optional — leads in a non-team context have
  // only display_name set; teammates have all four. Populated from the
  // parent claude process's argv at SessionStart time, since Claude Code
  // doesn't surface --agent-id / --agent-name / --team-name through the
  // SessionStart event payload itself.
  display_name?: string;
  agent_type?: string;
  team_name?: string;
  parent_session_id?: string;
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

// Read the parent process's command line so we can mine --agent-name /
// --team-name / --agent-type / --parent-session-id out of the claude
// invocation. Claude Code doesn't surface these through the SessionStart
// stdin event, but they're right there on argv. /proc is Linux's fast
// path (NUL-separated cmdline). ps is the cross-platform fallback.
// Returns the empty string on any failure — we always fall back to a
// reasonable display_name derived from cwd.
interface ParentArgs {
  agentName?: string;
  teamName?: string;
  agentType?: string;
  parentSessionId?: string;
}

function readParentCommandLine(): string {
  const ppid = process.ppid;
  if (!ppid || ppid < 2) return "";
  try {
    const f = `/proc/${ppid}/cmdline`;
    if (fs.existsSync(f)) {
      return fs.readFileSync(f, "utf8").replace(/\0/g, " ").trim();
    }
  } catch { /* fall through to ps */ }
  try {
    return execSync(`ps -wwp ${ppid} -o command=`, { encoding: "utf8", timeout: 200 }).trim();
  } catch { return ""; }
}

function parseClaudeArgs(cmdline: string): ParentArgs {
  const out: ParentArgs = {};
  if (!cmdline) return out;
  const tokens = cmdline.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i++) {
    const flag = tokens[i];
    const val = tokens[i + 1];
    if (!val || val.startsWith("--")) continue;
    if (flag === "--agent-name") out.agentName = val;
    else if (flag === "--team-name") out.teamName = val;
    else if (flag === "--agent-type") out.agentType = val;
    else if (flag === "--parent-session-id") out.parentSessionId = val;
  }
  return out;
}

// Display name: `<agent-name>@<team-name>` for teammates, `lead@<cwd-basename>`
// for parent sessions (which don't have --agent-id on argv). Mirrors the
// `name@team` shape Claude Code itself uses for teammate IDs so the dashboard
// reads consistently. Falls back to `lead@unknown` only if both argv parse
// and cwd resolution fail.
function deriveDisplayName(parsed: ParentArgs, cwd: string): string {
  if (parsed.agentName && parsed.teamName) return `${parsed.agentName}@${parsed.teamName}`;
  if (parsed.agentName) return parsed.agentName;
  let base = "";
  try { base = path.basename(cwd) || ""; } catch { base = ""; }
  return `lead@${base || "unknown"}`;
}

// Exposed via this single function so the SessionStart hook body stays
// straight-line. Failures are non-fatal — we always return *something*
// the dashboard can render.
function gatherIdentity(cwd: string): {
  displayName: string;
  agentType?: string;
  teamName?: string;
  parentSessionId?: string;
} {
  let parsed: ParentArgs = {};
  try { parsed = parseClaudeArgs(readParentCommandLine()); } catch { /* swallow */ }
  return {
    displayName: deriveDisplayName(parsed, cwd),
    agentType: parsed.agentType,
    teamName: parsed.teamName,
    parentSessionId: parsed.parentSessionId,
  };
}

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
    const cwd = evt.cwd || process.cwd();
    const identity = gatherIdentity(cwd);
    let reg: Registry = {};
    try { reg = JSON.parse(fs.readFileSync(REG, "utf8")); } catch {}
    reg[agent] = {
      session_id: sid,
      model: cleanModel(evt.model || process.env.ANTHROPIC_MODEL || "unknown"),
      cwd,
      started_ts: Date.now(),
      last_seen_ts: Date.now(),
      display_name: identity.displayName,
      ...(identity.agentType && { agent_type: identity.agentType }),
      ...(identity.teamName && { team_name: identity.teamName }),
      ...(identity.parentSessionId && { parent_session_id: identity.parentSessionId }),
    };
    const tmp = REG + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REG);
  } catch { /* hooks never block */ }
  await ensureDashboard();
  process.exit(0);
});
