import fs from "node:fs";
import { feelingsFile } from "./paths.mjs";

let _labels = null;
export function allowedLabels() {
  if (_labels) return _labels;
  try {
    const data = JSON.parse(fs.readFileSync(feelingsFile(), "utf8"));
    const set = new Set();
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
    process.stderr.write(`swarmeq: cannot load feelings.json: ${err.message}\n`);
    _labels = new Set();
    return _labels;
  }
}

function num01(x) { return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1; }
const CTRL = /[\x00-\x1f\x7f]/;

export function validateReport(raw) {
  const errs = [];
  if (!raw || typeof raw !== "object") return { ok: false, errs: ["report must be an object"] };

  let agent = null;
  if (typeof raw.agent === "string" && raw.agent.length > 0 && raw.agent.length <= 64 && !CTRL.test(raw.agent)) {
    agent = raw.agent;
  } else {
    errs.push("agent must be a non-empty printable string (<=64 chars, no control characters)");
  }

  const feelings = [];
  if (!Array.isArray(raw.feelings) || raw.feelings.length === 0 || raw.feelings.length > 6) {
    errs.push("feelings must be an array of 1-6 entries");
  } else {
    const set = allowedLabels();
    for (let i = 0; i < raw.feelings.length; i++) {
      const f = raw.feelings[i];
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
  if (raw.note !== undefined) {
    if (typeof raw.note !== "string") errs.push("note must be a string");
    else if (raw.note.length > 200) errs.push("note must be <=200 chars");
    else if (CTRL.test(raw.note)) errs.push("note must not contain control characters");
    else note = raw.note;
  }

  if (errs.length) return { ok: false, errs };
  return { ok: true, report: { agent, feelings, note, ts: Date.now() } };
}
