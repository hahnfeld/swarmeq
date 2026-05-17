import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dir = process.env.SWARMEQ_STATE_DIR || path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
const REG = path.join(dir, "registry.json");
const PORT = path.join(dir, ".port");

const PROBE_MIN_MS = 90_000;

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
}

const sanitize = (s: unknown): string => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";

// Bail when we're already inside a probe fork — the forked session fires its
// own Stop hook on completion. Without this guard each probe would chain
// another probe and pin Claude API spend.
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);

function pluginScript(): string | null {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return null;
  const script = path.join(root, "server", "swarmeq.mjs");
  return fs.existsSync(script) ? script : null;
}

async function portReachable(p: number): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: p });
    sock.once("connect", () => { sock.end(); res(true); });
    sock.once("error", () => res(false));
    sock.setTimeout(500, () => { sock.destroy(); res(false); });
  });
}

async function ensureDaemon(script: string): Promise<void> {
  let p = 0;
  try { p = parseInt(fs.readFileSync(PORT, "utf8"), 10); } catch {}
  if (p && (await portReachable(p))) return;
  try {
    const child = spawn(process.execPath, [script, "_daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch { /* best-effort */ }
}

function spawnProbe(script: string, agent: string): void {
  try {
    const child = spawn(process.execPath, [script, "probe", agent], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SWARMEQ_PROBE: "1" },
    });
    child.unref();
  } catch { /* best-effort */ }
}

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => { body += c; });
process.stdin.on("end", async () => {
  const script = pluginScript();
  if (!script) { process.exit(0); }

  await ensureDaemon(script);

  try {
    const evt: HookEvent = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg: Registry = {};
    try { reg = JSON.parse(fs.readFileSync(REG, "utf8")); } catch {}
    const entry = reg[agent];
    if (!entry) { process.exit(0); }

    const now = Date.now();
    entry.last_seen_ts = now;

    const lastProbe = Number(entry.last_probe_ts) || 0;
    const dueForProbe = now - lastProbe >= PROBE_MIN_MS;
    if (dueForProbe) entry.last_probe_ts = now;

    const tmp = REG + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REG);

    if (dueForProbe) spawnProbe(script, agent);
  } catch { /* hooks never block */ }
  process.exit(0);
});
