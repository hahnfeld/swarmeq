import fs from "node:fs";
import { feelingsFile } from "./paths.ts";

export interface Feeling {
  label: string;
  intensity: number;
}

// Sparse map of FEVS Intrinsic Work Experience item number (as string key,
// "1" to "5") to a 1-5 integer Likert rating (1 = Strongly Disagree,
// 5 = Strongly Agree). Optional on the report and optional per-item:
// agents skip rather than fabricate. Added in 0.8.0. The items themselves
// are from a U.S. Government work in the public domain (17 U.S.C. § 105);
// see dashboard/iwe.json for the canonical text and OPM 2023 FEVS
// Technical Report p. 13 for the source.
export interface IweRatings { [n: string]: number; }

export interface Report {
  agent: string;
  feelings: Feeling[];
  note: string;
  ts: number;
  iwe?: IweRatings;
}

export type ValidationResult =
  | { ok: true; report: Report }
  | { ok: false; errs: string[] };

let _labels: Set<string> | null = null;
export function allowedLabels(): Set<string> {
  if (_labels) return _labels;
  try {
    const data = JSON.parse(fs.readFileSync(feelingsFile(), "utf8"));
    const set = new Set<string>();
    for (const c of data.cores) {
      set.add(c.label);
      const subs = c.subs || [];
      for (const s of subs) set.add(s);
    }
    _labels = set;
    return set;
  } catch (err) {
    // Empty allow-list — every feelings.label will be rejected with a clear
    // error rather than crashing the MCP at startup.
    process.stderr.write(`swarmeq: cannot load feelings.json: ${(err as Error).message}\n`);
    _labels = new Set();
    return _labels;
  }
}

function num01(x: unknown): x is number { return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1; }
function intInRange(x: unknown, lo: number, hi: number): x is number {
  return typeof x === "number" && Number.isFinite(x) && Number.isInteger(x) && x >= lo && x <= hi;
}
const CTRL = /[\x00-\x1f\x7f]/;

export function validateReport(raw: unknown): ValidationResult {
  const errs: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, errs: ["report must be an object"] };
  const r = raw as Record<string, unknown>;

  if (!(typeof r.agent === "string" && r.agent.length > 0 && r.agent.length <= 64 && !CTRL.test(r.agent))) {
    return { ok: false, errs: ["agent must be a non-empty printable string (<=64 chars, no control characters)"] };
  }
  const agent: string = r.agent;

  const feelings: Feeling[] = [];
  if (!Array.isArray(r.feelings) || r.feelings.length === 0 || r.feelings.length > 6) {
    errs.push("feelings must be an array of 1-6 entries");
  } else {
    const set = allowedLabels();
    for (let i = 0; i < r.feelings.length; i++) {
      const f = r.feelings[i] as Record<string, unknown> | null;
      if (!f || typeof f !== "object") { errs.push(`feelings[${i}] must be an object`); continue; }
      if (typeof f.label !== "string" || !set.has(f.label)) {
        errs.push(`feelings[${i}].label must be one of the 78 Willcox labels (got ${JSON.stringify(f.label)})`);
        continue;
      }
      if (!num01(f.intensity)) {
        errs.push(`feelings[${i}].intensity must be a number in [0,1]`);
        continue;
      }
      feelings.push({ label: f.label, intensity: f.intensity });
    }
  }

  let note = "";
  if (r.note !== undefined) {
    if (typeof r.note !== "string") errs.push("note must be a string");
    else if (r.note.length > 200) errs.push("note must be <=200 chars");
    else if (CTRL.test(r.note)) errs.push("note must not contain control characters");
    else note = r.note;
  }

  // iwe (optional, 0.8.0+): FEVS Intrinsic Work Experience ratings. Sparse
  // object keyed by item number "1"-"5" with integer values 1-5 (Likert:
  // 1 = Strongly Disagree, 5 = Strongly Agree). Missing keys mean the
  // agent skipped that item this round. An empty `{}` is valid; null and
  // arrays are not.
  let iwe: IweRatings | undefined;
  if (r.iwe !== undefined && r.iwe !== null) {
    if (typeof r.iwe !== "object" || Array.isArray(r.iwe)) {
      errs.push("iwe must be an object (sparse map of item-number → 1-5 rating)");
    } else {
      const out: IweRatings = {};
      for (const [k, v] of Object.entries(r.iwe as Record<string, unknown>)) {
        const n = Number(k);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          errs.push(`iwe key ${JSON.stringify(k)} must be an integer in [1,5]`);
          continue;
        }
        if (!intInRange(v, 1, 5)) {
          errs.push(`iwe[${k}] must be an integer in [1,5] (got ${JSON.stringify(v)})`);
          continue;
        }
        out[String(n)] = v;
      }
      if (errs.length === 0) iwe = out;
    }
  }

  if (errs.length) return { ok: false, errs };
  const report: Report = { agent, feelings, note, ts: Date.now() };
  if (iwe) report.iwe = iwe;
  return { ok: true, report };
}
