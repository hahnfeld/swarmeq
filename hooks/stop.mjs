#!/usr/bin/env node
// swarmeq — bundled artifact. DO NOT EDIT BY HAND.
// Source: tools/src/*.ts. Rebuild: `node tools/build.mjs`.


// src/hooks/stop.ts
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
var dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
var REG = path.join(dir, "registry.json");
var PORT = path.join(dir, ".port");
var PROBE_MIN_MS = 9e4;
var sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);
function pluginScript() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return null;
  const script = path.join(root, "server", "swarmeq.mjs");
  return fs.existsSync(script) ? script : null;
}
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
async function ensureDaemon(script) {
  let p = 0;
  try {
    p = parseInt(fs.readFileSync(PORT, "utf8"), 10);
  } catch {
  }
  if (p && await portReachable(p)) return;
  try {
    const child = spawn(process.execPath, [script, "_daemon"], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
  } catch {
  }
}
function spawnProbe(script, agent) {
  try {
    const child = spawn(process.execPath, [script, "probe", agent], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SWARMEQ_PROBE: "1" }
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
  const script = pluginScript();
  if (!script) {
    process.exit(0);
  }
  await ensureDaemon(script);
  try {
    const evt = body ? JSON.parse(body) : {};
    const sid = sanitize(evt.session_id || evt.sessionId || "unknown");
    const agent = sanitize(evt.agent_name || evt.agentName || (sid !== "unknown" ? sid.slice(0, 8) : "unknown"));
    let reg = {};
    try {
      reg = JSON.parse(fs.readFileSync(REG, "utf8"));
    } catch {
    }
    const entry = reg[agent];
    if (!entry) {
      process.exit(0);
    }
    const now = Date.now();
    entry.last_seen_ts = now;
    const lastProbe = Number(entry.last_probe_ts) || 0;
    const dueForProbe = now - lastProbe >= PROBE_MIN_MS;
    if (dueForProbe) entry.last_probe_ts = now;
    const tmp = REG + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REG);
    if (dueForProbe) spawnProbe(script, agent);
  } catch {
  }
  process.exit(0);
});
