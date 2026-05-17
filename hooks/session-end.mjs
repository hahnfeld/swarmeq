#!/usr/bin/env node
// swarmeq — bundled artifact. DO NOT EDIT BY HAND.
// Source: tools/src/*.ts. Rebuild: `node tools/build.mjs`.


// tools/src/hooks/session-end.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var dir = process.env.SWARMEQ_STATE_DIR || path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
var REG = path.join(dir, "registry.json");
var sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);
var body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  body += c;
});
process.stdin.on("end", () => {
  try {
    const evt = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg = {};
    try {
      reg = JSON.parse(fs.readFileSync(REG, "utf8"));
    } catch {
    }
    if (reg[agent]) {
      delete reg[agent];
      const tmp = REG + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
      fs.renameSync(tmp, REG);
    }
    const reportFile = path.join(dir, `${agent}.json`);
    try {
      fs.unlinkSync(reportFile);
    } catch {
    }
  } catch {
  }
  process.exit(0);
});
