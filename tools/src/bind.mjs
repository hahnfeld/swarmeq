import fs from "node:fs";
import http from "node:http";
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
//
// When 7777 is held by an unrelated service, the loop walks 7777→7790 until
// it finds a free port; the daemon writes whichever port it actually bound,
// and clients discover that port via `.port` + the /healthz identity check.
export async function bindDashboardPort() {
  if (_state.bound) return bindState();
  // Don't spawn a second swarmeq daemon if one is already healthy somewhere
  // in the range — adopt it as a non-bound peer instead.
  const existing = await readActivePort();
  if (existing) {
    _state.bound = false;
    _state.port = existing;
    _state.url = `http://127.0.0.1:${existing}`;
    return bindState();
  }
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

// Point `record()` at a running dashboard without binding our own port.
// Used by the MCP child process so it forwards reports to the real
// dashboard instead of greedily binding 7778+ and broadcasting into a
// private SSE channel no one is listening to.
export async function discoverDashboard() {
  if (_state.bound) return bindState();
  const active = await readActivePort();
  _state.bound = false;
  _state.port = active || null;
  _state.url = active ? `http://127.0.0.1:${active}` : null;
  return bindState();
}

// Probe the recorded dashboard port and verify it actually serves swarmeq —
// not some unrelated process that grabbed the port after we recorded it.
// Returns the port number on success, null otherwise.
export async function readActivePort() {
  let port = null;
  try { port = parseInt(fs.readFileSync(PORT_FILE(), "utf8"), 10); } catch {}
  if (!port) return null;
  return (await isSwarmeqHealthy(port)) ? port : null;
}

// GET /healthz and confirm the JSON marker. Cheap identity check so we never
// open a browser tab at, or forward MCP ingest to, a foreign service that
// happens to be listening on our port.
export async function isSwarmeqHealthy(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; if (body.length > 256) { req.destroy(); resolve(false); } });
      res.on("end", () => {
        try {
          const obj = JSON.parse(body);
          resolve(!!(obj && obj.service === "swarmeq"));
        } catch { resolve(false); }
      });
    });
    req.once("error", () => resolve(false));
    req.once("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}
