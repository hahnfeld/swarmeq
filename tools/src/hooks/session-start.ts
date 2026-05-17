import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
fs.mkdirSync(dir, { recursive: true });
const REG = path.join(dir, "registry.json");
const PORT = path.join(dir, ".port");

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

// Probe forks of agents re-enter this hook on session start. Don't register
// them as separate agents and don't open another browser tab.
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);

async function portReachable(p: number): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: p });
    sock.once("connect", () => { sock.end(); res(true); });
    sock.once("error", () => res(false));
    sock.setTimeout(500, () => { sock.destroy(); res(false); });
  });
}

// Cold-start only: if the daemon is already running, do nothing — the user
// already has the tab open (and reopening on every session restart spams
// tabs on Linux/Windows, where `xdg-open` / `start ""` aren't idempotent).
// When no daemon is detected, spawn `swarmeq dashboard`, which forks the
// daemon and opens the browser to land the user on the dashboard.
async function ensureDashboard() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return;
  const script = path.join(root, "server", "swarmeq.mjs");
  if (!fs.existsSync(script)) return;
  let port = 0;
  try { port = parseInt(fs.readFileSync(PORT, "utf8"), 10); } catch {}
  if (port && (await portReachable(port))) return;
  try {
    const child = spawn("node", [script, "dashboard"], {
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
      model: sanitize(evt.model || process.env.ANTHROPIC_MODEL || "unknown"),
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
