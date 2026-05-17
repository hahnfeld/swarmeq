import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
fs.mkdirSync(dir, { recursive: true });
const REG = path.join(dir, "registry.json");

const sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";

// Detached-spawn `swarmeq dashboard`. If nothing's bound, it binds 7777 and
// opens the browser. If something IS bound, it sees the active port, opens
// the browser, and exits — `open <url>` is idempotent on macOS (focuses
// the existing tab). Either way the user lands on the dashboard the moment
// their session starts.
function ensureDashboard() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return;
  const script = path.join(root, "server", "swarmeq.mjs");
  if (!fs.existsSync(script)) return;
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
process.stdin.on("data", (c) => { body += c; });
process.stdin.on("end", () => {
  try {
    const evt = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg = {};
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
  ensureDashboard();
  process.exit(0);
});
