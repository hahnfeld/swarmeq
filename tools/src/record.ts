import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AGENT_FILE, readRegistry, stateDir, writeAtomic } from "./paths.ts";
import { bindState, readActivePort } from "./bind.ts";
import { broadcast } from "./sse.ts";
import { validateReport } from "./validate.ts";
import type { Report } from "./validate.ts";
import { snapshotAndBroadcast } from "./sentiment.ts";

export type ReportsByAgent = Record<string, Report>;

interface CodedError extends Error { code?: string }

// Single chokepoint: persist + broadcast (or forward to dashboard host).
// Throws Error with code=EVALIDATE on schema failure.
export async function record(raw: unknown): Promise<Report> {
  const v = validateReport(raw);
  if (!v.ok) {
    const e: CodedError = new Error(`invalid report: ${v.errs.join("; ")}`);
    e.code = "EVALIDATE";
    throw e;
  }
  const report = v.report;
  try {
    writeAtomic(AGENT_FILE(report.agent), JSON.stringify(report, null, 2));
  } catch (err) {
    process.stderr.write(`swarmeq record: cannot write state for ${report.agent}: ${(err as Error).message}\n`);
  }

  const state = bindState();
  if (state.bound) {
    broadcast("report", report);
    // Only the bound process owns sentiment.jsonl. MCP children forward to
    // /ingest, which calls record() again in the bound process — so we land
    // in this branch exactly once per logical report.
    snapshotAndBroadcast(readLivingReports());
  } else {
    // Re-read .port each time so a long-lived MCP child finds the dashboard
    // whenever it appears (or moves). readActivePort() validates via /healthz
    // so we never forward to a foreign service that happened to grab the port.
    const port = state.port || (await readActivePort());
    if (port) forwardToDashboard(port, report).catch(() => {});
  }
  return report;
}

// Team-view rule: only "living" agents (those present in registry.json,
// maintained by SessionStart/SessionEnd hooks) may contribute to team
// aggregates. Drops report files left behind when SessionEnd didn't run
// before the sweep reaped them.
export function readLivingReports(): ReportsByAgent {
  const reg = readRegistry();
  const all = readAllReports();
  const out: ReportsByAgent = {};
  for (const name of Object.keys(all)) {
    if (Object.prototype.hasOwnProperty.call(reg, name)) out[name] = all[name];
  }
  return out;
}


function forwardToDashboard(port: number, report: Report): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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

export function readAllReports(): ReportsByAgent {
  const out: ReportsByAgent = {};
  const dir = stateDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "registry.json") continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Report;
        if (r && r.agent) out[r.agent] = r;
      } catch {}
    }
  } catch {}
  return out;
}
