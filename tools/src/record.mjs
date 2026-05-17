import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AGENT_FILE, PORT_FILE, stateDir, writeAtomic } from "./paths.mjs";
import { bindState } from "./bind.mjs";
import { broadcast } from "./sse.mjs";
import { validateReport } from "./validate.mjs";

// Single chokepoint: persist + broadcast (or forward to dashboard host).
// Throws Error with code=EVALIDATE on schema failure.
export async function record(raw) {
  const v = validateReport(raw);
  if (!v.ok) {
    const e = new Error(`invalid report: ${v.errs.join("; ")}`);
    e.code = "EVALIDATE";
    throw e;
  }
  const report = v.report;
  try {
    writeAtomic(AGENT_FILE(report.agent), JSON.stringify(report, null, 2));
  } catch (err) {
    process.stderr.write(`swarmeq record: cannot write state for ${report.agent}: ${err.message}\n`);
  }

  const state = bindState();
  if (state.bound) {
    broadcast("report", report);
  } else {
    // Re-read .port each time so a long-lived MCP child finds the dashboard
    // whenever it appears (or moves), without needing to be restarted.
    const port = state.port || readPortFile();
    if (port) forwardToDashboard(port, report).catch(() => {});
  }
  return report;
}

function readPortFile() {
  try {
    const p = parseInt(fs.readFileSync(PORT_FILE(), "utf8"), 10);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

function forwardToDashboard(port, report) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(report);
    const req = http.request({
      host: "127.0.0.1", port, path: "/ingest", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve());
    });
    req.once("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("ingest timeout")));
    req.write(body);
    req.end();
  });
}

export function readAllReports() {
  const out = {};
  const dir = stateDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "registry.json") continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (r && r.agent) out[r.agent] = r;
      } catch {}
    }
  } catch {}
  return out;
}
