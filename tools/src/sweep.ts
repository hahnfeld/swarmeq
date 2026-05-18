import fs from "node:fs";
import path from "node:path";
import { AGENT_FILE, REGISTRY_FILE, readRegistry, stateDir, writeAtomic } from "./paths.ts";
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

  // Registry sweep (0.7.2+): the SessionEnd hook is supposed to remove
  // entries when a session deregisters, but sessions that exit abruptly
  // (terminal closed, parent crash, kill -9) skip it. Without this step
  // the registry grows unbounded and stale entries — including those
  // predating any v0.6.0+ identity capture, so they render as raw slugs
  // on the dashboard — linger forever. Reap any entry whose last_seen_ts
  // is older than STALE_MS; that's the same "no Stop has fired in 10 min"
  // signal we use for files, just applied to the registry side.
  const regRemoved = sweepStaleRegistry(now);
  for (const agent of regRemoved) {
    if (!removed.includes(agent)) {
      // Only broadcast if the file-sweep didn't already (e.g., registry-only
      // stragglers with no surviving report file).
      if (primed) broadcast("agent-removed", { agent, reason: "registry-stale", ts: now });
      removed.push(agent);
    }
  }

  // If anything actually changed, refresh the sentiment chart so removing
  // a sad agent (etc.) shows up immediately on /team without waiting for
  // the next live report. Living-only: a just-removed agent must not
  // contribute to the very point we're broadcasting because of its removal.
  if (removed.length > 0) snapshotAndBroadcast(readLivingReports());

  return removed;
}

// Drop registry entries whose last_seen_ts is older than STALE_MS. Returns
// the names removed. No-op if registry can't be read; best-effort write —
// if the atomic write fails the next sweep retries. Exported for tests.
export function sweepStaleRegistry(now: number): string[] {
  let reg: ReturnType<typeof readRegistry>;
  try { reg = readRegistry(); } catch { return []; }
  const removed: string[] = [];
  for (const [agent, entry] of Object.entries(reg)) {
    const lastSeen = Number(entry?.last_seen_ts) || 0;
    if (lastSeen === 0) continue; // never updated → leave alone (defensive)
    if (now - lastSeen > STALE_MS) {
      delete reg[agent];
      removed.push(agent);
    }
  }
  if (removed.length > 0) {
    try { writeAtomic(REGISTRY_FILE(), JSON.stringify(reg, null, 2)); }
    catch { return []; }
  }
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
