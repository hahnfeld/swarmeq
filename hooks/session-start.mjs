#!/usr/bin/env node
// swarmeq — bundled artifact. DO NOT EDIT BY HAND.
// Source: tools/src/*.ts. Rebuild: `node tools/build.mjs`.


// tools/src/hooks/session-start.ts
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
var dir = process.env.SWARMEQ_STATE_DIR || path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
fs.mkdirSync(dir, { recursive: true });
var REG = path.join(dir, "registry.json");
var PORT = path.join(dir, ".port");
var PID = path.join(dir, ".pid");
var sanitize = (s) => String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
var cleanModel = (s) => {
  const raw = String(s || "").trim().replace(/\[[^\]]*\]$/, "");
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return cleaned || "unknown";
};
if (process.env.SWARMEQ_PROBE === "1") process.exit(0);
async function probeDaemon(p) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: p,
      path: "/healthz",
      method: "GET",
      timeout: 500
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body2 = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body2 += c;
        if (body2.length > 1024) {
          req.destroy();
          resolve(null);
        }
      });
      res.on("end", () => {
        try {
          const obj = JSON.parse(body2);
          if (!obj || obj.service !== "swarmeq") return resolve(null);
          resolve({ pid: Number(obj.pid) || 0, root: String(obj.root || ""), version: String(obj.version || "") });
        } catch {
          resolve(null);
        }
      });
    });
    req.once("error", () => resolve(null));
    req.once("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
async function portReleased(p) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: p });
    sock.once("connect", () => {
      sock.end();
      resolve(false);
    });
    sock.once("error", () => resolve(true));
    sock.setTimeout(200, () => {
      sock.destroy();
      resolve(true);
    });
  });
}
function readLocalVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}
function sameInstall(id, root) {
  const localVersion = readLocalVersion(root);
  if (!localVersion) return true;
  if (!id.version) return false;
  return id.version === localVersion;
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
  if (port) {
    const id = await probeDaemon(port);
    if (id && sameInstall(id, root)) return;
    if (id) {
      if (id.pid > 0) {
        try {
          process.kill(id.pid, "SIGTERM");
        } catch {
        }
      }
      for (let i = 0; i < 30; i++) {
        if (await portReleased(port)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        fs.unlinkSync(PORT);
      } catch {
      }
      try {
        fs.unlinkSync(PID);
      } catch {
      }
    }
  }
  try {
    const child = spawn("node", [script, "_daemon"], {
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
      model: cleanModel(evt.model || process.env.ANTHROPIC_MODEL || "unknown"),
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
