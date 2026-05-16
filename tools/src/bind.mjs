import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { PORT_FILE, PID_FILE } from "./paths.mjs";

const PORT_RANGE = { start: 7777, end: 7790 };

const _state = {
  bound: false,
  port: null,
  server: null,
  url: null,
};

export function bindState() { return { ..._state }; }

async function tryBind(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", (err) => {
      if (err && err.code !== "EADDRINUSE") {
        process.stderr.write(`swarmeq bind: port ${port} unbindable (${err.code}): ${err.message}\n`);
      }
      resolve(null);
    });
    srv.once("listening", () => {
      resolve(srv);
    });
    srv.listen(port, "127.0.0.1");
  });
}

// Attempt to bind the dashboard port. Returns { bound: true, server, port, url }
// on success, or { bound: false, port, url } when another process owns the port.
// If `.port` is stale (winner crashed), the next caller retries the bind.
export async function bindDashboardPort() {
  if (_state.bound) return bindState();
  for (let p = PORT_RANGE.start; p <= PORT_RANGE.end; p++) {
    const srv = await tryBind(p);
    if (srv) {
      _state.bound = true;
      _state.port = p;
      _state.server = srv;
      _state.url = `http://127.0.0.1:${p}`;
      try { fs.writeFileSync(PORT_FILE(), String(p)); } catch {}
      try { fs.writeFileSync(PID_FILE(), String(process.pid)); } catch {}
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { fs.unlinkSync(PID_FILE()); } catch {}
        try { fs.unlinkSync(PORT_FILE()); } catch {}
      };
      process.once("SIGTERM", () => { cleanup(); process.exit(0); });
      process.once("SIGINT",  () => { cleanup(); process.exit(0); });
      process.once("exit", cleanup);
      return bindState();
    }
  }
  // Couldn't bind any port. Check if a winner is actually reachable.
  const active = await readActivePort();
  if (active) {
    _state.bound = false;
    _state.port = active;
    _state.url = `http://127.0.0.1:${active}`;
  } else {
    // Stale .port from a crashed previous run; clear it so a later retry can re-bind.
    try { fs.unlinkSync(PORT_FILE()); } catch {}
    try { fs.unlinkSync(PID_FILE()); } catch {}
    _state.bound = false;
    _state.port = null;
    _state.url = null;
  }
  return bindState();
}

// Probe an existing dashboard host. Returns null if nothing alive on the
// recorded port.
export async function readActivePort() {
  let port = null;
  try { port = parseInt(fs.readFileSync(PORT_FILE(), "utf8"), 10); } catch {}
  if (!port) return null;
  const reachable = await new Promise((res) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => { sock.end(); res(true); });
    sock.once("error", () => res(false));
    sock.setTimeout(500, () => { sock.destroy(); res(false); });
  });
  return reachable ? port : null;
}
