import fs from "node:fs";
import path from "node:path";
import { AGENT_FILE, stateDir } from "./paths.mjs";
import { broadcast } from "./sse.mjs";
import { readAllReports } from "./record.mjs";
import { snapshotAndBroadcast } from "./sentiment.mjs";

const STALE_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 30_000;

let sweepTimer = null;
// Agents the server has previously broadcast as live. We diff against this
// each sweep so that a missing file (e.g., the session-end hook unlinked it)
// also fires an `agent-removed` event, not just files we delete ourselves.
const lastSeen = new Set();
let primed = false;

function readReportTs(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const ts = Number(r?.ts);
    return Number.isFinite(ts) ? ts : 0;
  } catch { return 0; }
}

// Delete per-agent reports older than STALE_MS and SSE-broadcast each
// removal. Also broadcasts removals for agents whose files disappeared
// between sweeps (the session-end hook unlinks the per-agent file when a
// session deregisters, so we only need to *notice* it's gone). Returns the
// list of agent names removed this pass.
export function sweepStaleAgents() {
  const dir = stateDir();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const now = Date.now();
  const live = new Set();
  const removed = [];

  for (const f of entries) {
    if (!f.endsWith(".json") || f === "registry.json") continue;
    const agent = f.slice(0, -5);
    const fp = path.join(dir, f);
    const ts = readReportTs(fp);
    if (ts > 0 && now - ts > STALE_MS) {
      try { fs.unlinkSync(AGENT_FILE(agent)); } catch {}
      if (primed && lastSeen.has(agent)) {
        broadcast("agent-removed", { agent, reason: "stale", ts: now });
      }
      removed.push(agent);
      continue;
    }
    live.add(agent);
  }

  // Catch externally-removed files (session-end hook deletes the per-agent
  // report when the session deregisters; we just need to broadcast it).
  if (primed) {
    for (const agent of lastSeen) {
      if (!live.has(agent) && !removed.includes(agent)) {
        broadcast("agent-removed", { agent, reason: "deregistered", ts: now });
        removed.push(agent);
      }
    }
  }

  lastSeen.clear();
  for (const a of live) lastSeen.add(a);
  primed = true;

  // If anything actually changed, refresh the sentiment chart so removing
  // a sad agent (etc.) shows up immediately on /team without waiting for
  // the next live report.
  if (removed.length > 0) snapshotAndBroadcast(readAllReports());

  return removed;
}

export function startSweepTimer() {
  if (sweepTimer) return;
  // Run once promptly so a freshly-bound dashboard reconciles old files,
  // then on a fixed cadence. 10-minute staleness doesn't need sub-second
  // precision.
  sweepStaleAgents();
  sweepTimer = setInterval(sweepStaleAgents, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopSweepTimer() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
