import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
const REG = path.join(dir, "registry.json");

const sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";

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
    if (reg[agent]) {
      reg[agent].last_seen_ts = Date.now();
      const tmp = REG + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
      fs.renameSync(tmp, REG);
    }
  } catch { /* hooks never block */ }
  process.exit(0);
});
