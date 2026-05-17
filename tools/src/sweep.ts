import fs from "node:fs";
import path from "node:path";
import { AGENT_FILE, stateDir } from "./paths.ts";
import { broadcast } from "./sse.ts";
import { readLivingReports } from "./record.ts";
import { snapshotAndBroadcast } from "./sentiment.ts";

const STALE_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 30_000;

let sweepTimer: NodeJS.Timeout | null = null;
// Agents the server has previously broadcast as live. We diff against this
// each sweep so that a missing file (e.g., the session-end hook unlinked it)
// also fires an `agent-removed` event, not just files we delete ourselves.
const lastSeen = new Set<string>();
let primed = false;

function readReportTs(file: string): number {
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
export function sweepStaleAgents(): string[] {
  const dir = stateDir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const now = Date.now();
  const live = new Set<string>();
  const removed: string[] = [];

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
  // the next live report. Living-only: a just-removed agent must not
  // contribute to the very point we're broadcasting because of its removal.
  if (removed.length > 0) snapshotAndBroadcast(readLivingReports());

  return removed;
}

export function startSweepTimer(): void {
  if (sweepTimer) return;
  // Run once promptly so a freshly-bound dashboard reconciles old files,
  // then on a fixed cadence. 10-minute staleness doesn't need sub-second
  // precision.
  sweepStaleAgents();
  sweepTimer = setInterval(sweepStaleAgents, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopSweepTimer(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
