#!/usr/bin/env node
// swarmeq — bundled artifact. DO NOT EDIT BY HAND.
// Source: tools/src/*.ts. Rebuild: `node tools/build.mjs`.


// tools/src/hooks/session-start.ts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
var dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
fs.mkdirSync(dir, { recursive: true });
var REG = path.join(dir, "registry.json");
var PORT = path.join(dir, ".port");
var sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);
async function portReachable(p) {
  return new Promise((res) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: p });
    sock.once("connect", () => {
      sock.end();
      res(true);
    });
    sock.once("error", () => res(false));
    sock.setTimeout(500, () => {
      sock.destroy();
      res(false);
    });
  });
}
async function ensureDashboard() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return;
  const script = path.join(root, "server", "swarmeq.mjs");
  if (!fs.existsSync(script)) return;
  let port = 0;
  try {
    port = parseInt(fs.readFileSync(PORT, "utf8"), 10);
  } catch {
  }
  if (port && await portReachable(port)) return;
  try {
    const child = spawn("node", [script, "dashboard"], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
  } catch {
  }
}
var body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  body += c;
});
process.stdin.on("end", async () => {
  try {
    const evt = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg = {};
    try {
      reg = JSON.parse(fs.readFileSync(REG, "utf8"));
    } catch {
    }
    reg[agent] = {
      session_id: sid,
      model: sanitize(evt.model || process.env.ANTHROPIC_MODEL || "unknown"),
      cwd: evt.cwd || process.cwd(),
      started_ts: Date.now(),
      last_seen_ts: Date.now()
    };
    const tmp = REG + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REG);
  } catch {
  }
  await ensureDashboard();
  process.exit(0);
});
