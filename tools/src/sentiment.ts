import fs from "node:fs";
import { SENTIMENT_FILE, feelingsFile } from "./paths.ts";
import { broadcast } from "./sse.ts";
import type { ReportsByAgent } from "./record.ts";

const POSITIVE_CORES = new Set(["joyful", "powerful", "peaceful"]);
const NEGATIVE_CORES = new Set(["mad", "sad", "scared"]);
const HISTORY_CAP = 1000;

export interface SentimentSummary {
  positive: number;
  negative: number;
  ratio: number | null;
  agentCount: number;
}

export interface SentimentPoint {
  ts: number;
  ratio: number | null;
  agentCount: number;
}

let _labelToCore: Map<string, string> | null = null;

function labelToCore(): Map<string, string> {
  if (_labelToCore) return _labelToCore;
  const m = new Map<string, string>();
  try {
    const data = JSON.parse(fs.readFileSync(feelingsFile(), "utf8"));
    for (const c of data.cores || []) {
      m.set(c.label, c.label);
      for (const sub of c.subs || []) m.set(sub, c.label);
    }
  } catch {
    // No mapping → polarity() returns 0 for every label and computeSentiment
    // produces ratio=null instead of crashing.
  }
  _labelToCore = m;
  return m;
}

// +1 if positive, -1 if negative, 0 if neutral / unknown.
export function polarity(label: string): number {
  const core = labelToCore().get(label);
  if (!core) return 0;
  if (POSITIVE_CORES.has(core)) return 1;
  if (NEGATIVE_CORES.has(core)) return -1;
  return 0;
}

// Sentiment is sum(positive intensities) / sum(positive + negative).
// 0.5 is neutral; >0.5 leans positive; <0.5 leans negative. Returns ratio
// null when no valenced feelings are present (so the dashboard can render
// an honest "—" instead of a misleading 0%).
export function computeSentiment(agents: ReportsByAgent): SentimentSummary {
  let pos = 0, neg = 0;
  const names = Object.keys(agents || {});
  for (const name of names) {
    const r = agents[name];
    if (!r || !Array.isArray(r.feelings)) continue;
    for (const f of r.feelings) {
      const p = polarity(f.label);
      if (p > 0) pos += Number(f.intensity) || 0;
      else if (p < 0) neg += Number(f.intensity) || 0;
    }
  }
  const denom = pos + neg;
  return {
    positive: pos,
    negative: neg,
    ratio: denom > 0 ? pos / denom : null,
    agentCount: names.length,
  };
}

// Append one sentiment sample to the JSONL history, then trim to the cap.
// Trimming is rare-enough (every HISTORY_CAP writes) that we just rewrite
// the file atomically when we hit it.
export function appendSentimentPoint(point: SentimentPoint): void {
  const line = JSON.stringify(point) + "\n";
  try {
    fs.appendFileSync(SENTIMENT_FILE(), line);
  } catch { return; }
  // Cheap cap check: only re-read + trim when the file size suggests we
  // might be over. ~120 bytes/line × 1000 = 120KB safety threshold.
  try {
    const stat = fs.statSync(SENTIMENT_FILE());
    if (stat.size < HISTORY_CAP * 200) return;
    const all = fs.readFileSync(SENTIMENT_FILE(), "utf8").split("\n").filter(Boolean);
    if (all.length <= HISTORY_CAP) return;
    const trimmed = all.slice(-HISTORY_CAP).join("\n") + "\n";
    fs.writeFileSync(SENTIMENT_FILE() + ".tmp", trimmed);
    fs.renameSync(SENTIMENT_FILE() + ".tmp", SENTIMENT_FILE());
  } catch {}
}

// Recompute team sentiment from the given agents map, persist a point to
// history, and SSE-broadcast it. Returns the appended point.
export function snapshotAndBroadcast(agents: ReportsByAgent): SentimentPoint {
  const s = computeSentiment(agents);
  const point: SentimentPoint = { ts: Date.now(), ratio: s.ratio, agentCount: s.agentCount };
  appendSentimentPoint(point);
  broadcast("sentiment", point);
  return point;
}

// Read the last `limit` sentiment points from the JSONL history. Returns
// the points oldest-first so the chart can append new ones to the right.
export function readSentimentHistory(limit = HISTORY_CAP): SentimentPoint[] {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(SENTIMENT_FILE(), "utf8").split("\n").filter(Boolean);
  } catch { return []; }
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const out: SentimentPoint[] = [];
  for (const l of slice) {
    try {
      const p = JSON.parse(l) as SentimentPoint;
      if (Number.isFinite(p.ts)) out.push(p);
    } catch {}
  }
  return out;
}
