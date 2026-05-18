import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dashboardFile, feelingsFile, iweFile, pluginRoot, pluginVersion, readRegistry } from "./paths.ts";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon",
};
import { bindState } from "./bind.ts";
import { addClient, broadcast } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { record, readLivingReports } from "./record.ts";
import { startSweepTimer } from "./sweep.ts";
import { computeSentiment, readSentimentHistory } from "./sentiment.ts";

const ALLOWED_PROBE_EVENTS: ReadonlySet<SseEvent> = new Set<SseEvent>([
  "probe-failed", "probe-exit", "probe-no-report", "probe-report-written", "model-mismatch",
]);

// Track which Server instances already have our handler attached, without
// stamping a property onto Node's Server object.
const attached = new WeakSet<Server>();

export function attachRoutes(): void {
  const state = bindState();
  if (!state.bound || !state.server) return;
  if (attached.has(state.server)) return;
  attached.add(state.server);
  state.server.on("request", handle);
  // The bound process is the canonical dashboard host — only it should
  // run the stale-agent sweep so we don't have N MCP children racing on
  // the same state directory.
  startSweepTimer();
}

// Exported as `handle` so the test suite can drive routes against an
// ephemeral HTTP server without going through the bind.ts singleton.
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const pn = u.pathname;
    if (req.method === "GET" && (pn === "/" || pn === "/index.html" || pn === "/team")) return serveFile(res, dashboardFile(), "text/html; charset=utf-8");
    if (req.method === "GET" && pn === "/feelings.json")               return serveFile(res, feelingsFile(), "application/json");
    if (req.method === "GET" && pn === "/iwe.json")                    return serveFile(res, iweFile(), "application/json");
    if (req.method === "GET" && pn === "/events")                      return addClient(req, res);
    if (req.method === "GET" && pn === "/state")                       return serveJSON(res, snapshot());
    if (req.method === "GET" && pn === "/healthz")                     return serveJSON(res, { service: "swarmeq", pid: process.pid, version: pluginVersion(), root: pluginRoot() });
    if (req.method === "GET" && pn === "/history") {
      const lim = Math.max(1, Math.min(2000, parseInt(u.searchParams.get("limit") || "500", 10) || 500));
      return serveJSON(res, { points: readSentimentHistory(lim) });
    }
    if (req.method === "POST" && pn === "/ingest")                     return ingest(req, res);
    if (req.method === "POST" && pn === "/probe-event")                return probeEvent(req, res);
    // Static assets from dashboard/ (logo.png, etc). Path is sanitized: only
    // a single filename with a known image extension, no traversal.
    if (req.method === "GET" && /^\/[a-zA-Z0-9._-]+\.(png|jpe?g|svg|webp|gif|ico)$/.test(pn)) {
      const ext = path.extname(pn).toLowerCase();
      const file = path.join(pluginRoot(), "dashboard", pn.slice(1));
      return serveFile(res, file, MIME[ext] || "application/octet-stream");
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
    }
    res.end(`server error: ${(err as Error).message}\n`);
  }
}

function serveFile(res: ServerResponse, file: string, contentType: string): void {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`cannot read ${file}: ${err.message}\n`);
      return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": buf.length });
    res.end(buf);
  });
}

function serveJSON(res: ServerResponse, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
}

function snapshot() {
  // Living agents only: stale report files for vanished sessions never
  // contribute to the team view or per-agent tabs.
  const agents = readLivingReports();
  return { agents, registry: readRegistry(), sentiment: computeSentiment(agents), ts: Date.now() };
}

// Detached probe subprocesses POST their events here so SSE clients connected
// to the daemon receive them — broadcast() alone only reaches clients of the
// process that calls it, which is never the probe.
function probeEvent(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  let tooBig = false;
  req.setEncoding("utf8");
  req.on("data", (c: string) => {
    if (tooBig) return;
    body += c;
    if (body.length > 8192) {
      tooBig = true;
      if (!res.headersSent) { res.writeHead(413, { "Content-Type": "text/plain" }); res.end("payload too large\n"); }
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return;
    try {
      const obj = JSON.parse(body) as { type?: string; data?: unknown };
      if (!obj || typeof obj.type !== "string" || !ALLOWED_PROBE_EVENTS.has(obj.type as SseEvent)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("invalid event type\n");
        return;
      }
      broadcast(obj.type as SseEvent, obj.data ?? {});
      res.writeHead(204);
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`${(err as Error).message}\n`);
    }
  });
}

function ingest(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  let tooBig = false;
  req.setEncoding("utf8");
  req.on("data", (c: string) => {
    if (tooBig) return;
    body += c;
    if (body.length > 65536) {
      tooBig = true;
      if (!res.headersSent) { res.writeHead(413, { "Content-Type": "text/plain" }); res.end("payload too large\n"); }
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooBig) return;
    try {
      const obj = JSON.parse(body);
      await record(obj);
      res.writeHead(204);
      res.end();
    } catch (err) {
      const e = err as Error & { code?: string };
      const status = e.code === "EVALIDATE" ? 400 : 500;
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "text/plain" });
      }
      res.end(e.message + "\n");
    }
  });
}
