import fs from "node:fs";
import path from "node:path";
import { dashboardFile, feelingsFile, pluginRoot, REGISTRY_FILE, stateDir } from "./paths.mjs";

// Mime types for the few static asset extensions we serve from dashboard/.
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon",
};
import { bindState } from "./bind.mjs";
import { addClient } from "./sse.mjs";
import { record, readLivingReports } from "./record.mjs";
import { startSweepTimer } from "./sweep.mjs";
import { computeSentiment, readSentimentHistory } from "./sentiment.mjs";

// Wire HTTP routes onto the bound server (if any). Idempotent on the same
// server instance.
export function attachRoutes() {
  const state = bindState();
  if (!state.bound || !state.server) return;
  if (state.server._swarmeqAttached) return;
  state.server._swarmeqAttached = true;
  state.server.on("request", handle);
  // The bound process is the canonical dashboard host — only it should
  // run the stale-agent sweep so we don't have N MCP children racing on
  // the same state directory.
  startSweepTimer();
}

async function handle(req, res) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const pn = u.pathname;
    if (req.method === "GET" && (pn === "/" || pn === "/index.html" || pn === "/team")) return serveFile(res, dashboardFile(), "text/html; charset=utf-8");
    if (req.method === "GET" && pn === "/feelings.json")               return serveFile(res, feelingsFile(), "application/json");
    if (req.method === "GET" && pn === "/events")                      return addClient(req, res);
    if (req.method === "GET" && pn === "/state")                       return serveJSON(res, snapshot());
    if (req.method === "GET" && pn === "/healthz")                     return serveJSON(res, { service: "swarmeq", pid: process.pid });
    if (req.method === "GET" && pn === "/history") {
      const lim = Math.max(1, Math.min(2000, parseInt(u.searchParams.get("limit") || "500", 10) || 500));
      return serveJSON(res, { points: readSentimentHistory(lim) });
    }
    if (req.method === "POST" && pn === "/ingest")                     return ingest(req, res);
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
    res.end(`server error: ${err.message}\n`);
  }
}

function serveFile(res, file, contentType) {
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

function serveJSON(res, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
  res.end(body);
}

function snapshot() {
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE(), "utf8")); } catch {}
  // Living agents only: stale report files for vanished sessions never
  // contribute to the team view or per-agent tabs.
  const agents = readLivingReports();
  return { agents, registry, sentiment: computeSentiment(agents), ts: Date.now() };
}

function ingest(req, res) {
  let body = "";
  let tooBig = false;
  req.setEncoding("utf8");
  req.on("data", (c) => {
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
      const status = err.code === "EVALIDATE" ? 400 : 500;
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "text/plain" });
      }
      res.end(err.message + "\n");
    }
  });
}

