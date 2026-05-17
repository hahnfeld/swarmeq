import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = process.env.SWARMEQ_STATE_DIR || path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
const REG = path.join(dir, "registry.json");

// Each hook is intentionally standalone (no imports from tools/src/), so these
// types are repeated rather than shared.
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

// Probe forks share the parent agent's name. If we let SessionEnd fire here,
// the probe's exit would yank the real agent's entry out of the registry.
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => { body += c; });
process.stdin.on("end", () => {
  try {
    const evt: HookEvent = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg: Registry = {};
    try { reg = JSON.parse(fs.readFileSync(REG, "utf8")); } catch {}
    if (reg[agent]) {
      delete reg[agent];
      const tmp = REG + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
      fs.renameSync(tmp, REG);
    }
    // Also clean the per-agent report so the dashboard tab disappears.
    const reportFile = path.join(dir, `${agent}.json`);
    try { fs.unlinkSync(reportFile); } catch {}
  } catch { /* hooks never block */ }
  process.exit(0);
});
