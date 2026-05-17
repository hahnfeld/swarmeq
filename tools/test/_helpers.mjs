import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Allocate a tmp dir, point SWARMEQ_STATE_DIR at it, run the test body, then
// scrub the env var and the directory. Test isolation: every test starts with
// an empty state dir, and never touches ~/.claude/plugins/swarmeq/state.
export async function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-test-"));
  const prev = process.env.SWARMEQ_STATE_DIR;
  process.env.SWARMEQ_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.SWARMEQ_STATE_DIR;
    else process.env.SWARMEQ_STATE_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Drop a fake `claude` executable into a tmp dir, prepend to PATH, run fn.
// The script is told what to print (stdout, JSON-encoded) and what exit code
// to use. Lets us exercise probe.ts end-to-end without the real Claude CLI.
export async function withFakeClaude({ stdout = "{}", exitCode = 0, sideEffect = "" } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-fakeclaude-"));
  const script = path.join(dir, "claude");
  const body = `#!/usr/bin/env node\n`
    + `${sideEffect}\n`
    + `process.stdout.write(${JSON.stringify(stdout)});\n`
    + `process.exit(${Number(exitCode) || 0});\n`;
  fs.writeFileSync(script, body, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath || ""}`;
  try {
    return await fn(dir);
  } finally {
    process.env.PATH = prevPath;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Spin up a plain HTTP server with the given handler on an ephemeral port.
// Easier than wrestling with bind.ts's module-level singleton when all we
// want is to hit a route.
export async function withHttpServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await fn({ port, url: `http://127.0.0.1:${port}`, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Small fetch-like helper: returns {status, headers, body} as strings.
export async function httpRequest(url, { method = "GET", body, headers = {} } = {}) {
  const u = new URL(url);
  const opts = {
    method,
    host: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    headers: { ...headers },
  };
  if (body !== undefined) {
    opts.headers["Content-Length"] = Buffer.byteLength(body);
    if (!opts.headers["Content-Type"]) opts.headers["Content-Type"] = "application/json";
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.once("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Subscribe to /events SSE for up to timeoutMs and collect the first
// matching event payload, then close. Returns null on timeout.
export async function awaitSse(url, eventName, timeoutMs = 1500) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "GET",
      headers: { Accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      let timer = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
      res.on("data", (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = block.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (evLine && evLine.slice(7) === eventName) {
            clearTimeout(timer);
            try { req.destroy(); } catch {}
            try { resolve(dataLine ? JSON.parse(dataLine.slice(6)) : {}); }
            catch (e) { reject(e); }
            return;
          }
        }
      });
    });
    req.once("error", reject);
    req.end();
  });
}

// Drop fresh state-dir cached modules so they pick up a new SWARMEQ_STATE_DIR.
// node:test caches imports per-process; some of our modules read env at first
// call. Use dynamic import with a cache-buster query so each invocation gets
// a fresh module copy.
export async function freshImport(specifier) {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`);
}
