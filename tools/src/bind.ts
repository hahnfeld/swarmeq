import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { Server } from "node:http";
import { PORT_FILE, PID_FILE, pluginRoot, pluginVersion } from "./paths.ts";

const PORT_RANGE = { start: 7777, end: 7790 };

export interface BindState {
  bound: boolean;
  port: number | null;
  server: Server | null;
  url: string | null;
}

const _state: BindState = {
  bound: false,
  port: null,
  server: null,
  url: null,
};

export function bindState(): BindState { return { ..._state }; }

export async function tryBind(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => {
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
export async function bindDashboardPort(knownActive?: number | null): Promise<BindState> {
  if (_state.bound) return bindState();
  // Don't spawn a second swarmeq daemon if one is already healthy somewhere
  // in the range — adopt it as a non-bound peer instead. Callers that
  // already probed /healthz can pass the result in via knownActive to skip
  // the second roundtrip.
  const existing = knownActive ?? (await readActivePort());
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
        // Only unlink if the files still point at us. If another daemon
        // already took ownership (cold-start race winner), nuking its
        // state would orphan it.
        try {
          const ownerPid = parseInt(fs.readFileSync(PID_FILE(), "utf8"), 10);
          if (ownerPid === process.pid) fs.unlinkSync(PID_FILE());
        } catch {}
        try {
          const ownerPort = parseInt(fs.readFileSync(PORT_FILE(), "utf8"), 10);
          if (ownerPort === _state.port) fs.unlinkSync(PORT_FILE());
        } catch {}
      };
      process.once("SIGTERM", () => { cleanup(); process.exit(0); });
      process.once("SIGINT",  () => { cleanup(); process.exit(0); });
      process.once("exit", cleanup);
      // Self-termination heartbeat: latest .pid writer is the canonical
      // owner. Losers of a cold-start race notice within ~5s and yield.
      // If .pid/.port go missing (e.g., a yielding daemon's cleanup raced
      // ahead of ours), reclaim ownership by re-writing them.
      setInterval(() => {
        let recordedPid = 0;
        try { recordedPid = parseInt(fs.readFileSync(PID_FILE(), "utf8"), 10); } catch {}
        if (!recordedPid) {
          try { fs.writeFileSync(PID_FILE(), String(process.pid)); } catch {}
          try { fs.writeFileSync(PORT_FILE(), String(_state.port ?? "")); } catch {}
          return;
        }
        if (recordedPid !== process.pid) {
          try { process.kill(process.pid, "SIGTERM"); } catch {}
        }
      }, 5_000).unref();
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
export async function discoverDashboard(): Promise<BindState> {
  if (_state.bound) return bindState();
  const active = await readActivePort();
  _state.bound = false;
  _state.port = active || null;
  _state.url = active ? `http://127.0.0.1:${active}` : null;
  return bindState();
}

// Probe the recorded dashboard port and verify it actually serves swarmeq —
// not some unrelated process that grabbed the port after we recorded it, and
// not a daemon left behind by a previous plugin install whose cached
// pluginRoot points at a temp dir the loader has already GC'd. Returns the
// port number on success, null otherwise. Stale-but-swarmeq daemons are
// SIGTERM'd in-line so the next caller can bind a fresh one.
export async function readActivePort(): Promise<number | null> {
  let port: number | null = null;
  try { port = parseInt(fs.readFileSync(PORT_FILE(), "utf8"), 10); } catch {}
  if (!port) return null;
  const id = await probeSwarmeq(port);
  if (!id) return null;
  if (isStaleIdentity(id)) {
    await evictStaleDaemon(port, id);
    return null;
  }
  return port;
}

export interface DaemonIdentity {
  pid: number;
  version: string;
  root: string;
}

// GET /healthz and parse the identity envelope. Returns identity on a valid
// swarmeq daemon; null on timeout, foreign service, or malformed payload.
// Cheap identity check so we never open a browser tab at, or forward MCP
// ingest to, a foreign service that happens to be listening on our port.
export async function probeSwarmeq(port: number, timeoutMs = 800): Promise<DaemonIdentity | null> {
  return new Promise<DaemonIdentity | null>((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; if (body.length > 1024) { req.destroy(); resolve(null); } });
      res.on("end", () => {
        try {
          const obj = JSON.parse(body);
          if (!obj || obj.service !== "swarmeq") return resolve(null);
          resolve({
            pid: Number(obj.pid) || 0,
            version: String(obj.version || ""),
            root: String(obj.root || ""),
          });
        } catch { resolve(null); }
      });
    });
    req.once("error", () => resolve(null));
    req.once("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// A daemon is stale when its pluginRoot differs from ours, or when /healthz
// doesn't expose a root at all (pre-0.3.3 daemons). Version drift is also
// stale even within the same root — `npm i -g`-style reinstalls reuse paths
// but bump the version, and the daemon's bundled code is frozen at start.
//
// Defensive: if we can't resolve our own pluginRoot (e.g., this module is
// loaded outside the plugin), do nothing — better to keep serving than to
// kill a working daemon based on bad input.
function isStaleIdentity(id: DaemonIdentity): boolean {
  let localRoot: string;
  try { localRoot = pluginRoot(); } catch { return false; }
  if (!id.root) return true;
  if (id.root !== localRoot) return true;
  if (id.version && id.version !== pluginVersion()) return true;
  return false;
}

async function evictStaleDaemon(port: number, id: DaemonIdentity): Promise<void> {
  if (id.pid > 0) {
    try { process.kill(id.pid, "SIGTERM"); } catch {}
  }
  // Wait briefly for the daemon to release the port. Its SIGTERM handler in
  // bindDashboardPort() above unlinks .port/.pid synchronously before exit.
  for (let i = 0; i < 30; i++) {
    if (!(await isPortListening(port))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Belt-and-suspenders: if the old process was SIGKILL'd or frozen and
  // never ran its own cleanup, clear the state files ourselves so the next
  // bind attempt sees a clean slate.
  try { fs.unlinkSync(PORT_FILE()); } catch {}
  try { fs.unlinkSync(PID_FILE()); } catch {}
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => { sock.end(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.setTimeout(200, () => { sock.destroy(); resolve(false); });
  });
}
