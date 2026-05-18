import fs from "node:fs";
import { allowedLabels } from "./validate.ts";
import { iweFile } from "./paths.ts";

// JSON-only probe prompt (0.5.0+, extended in 0.8.0 with the FEVS
// Intrinsic Work Experience sub-index). The forked session is asked to
// emit one JSON object as its entire reply — no tool calls, no prose.
// This decouples the probe from the forked session's tool catalog (which
// Agent Teams teammates' catalog filter used to block) and gets us "just
// emit your state" semantics that work uniformly for lead and teammates.
//
// The `agent` field is intentionally NOT requested from the model: the
// probe injects it from registry context after parsing, so a typo or
// hallucinated slug can't end up in the report. The lead-in line names
// the plugin so cautious teammates don't mistake the probe for an
// injection attempt (a v0.3.x prompt that didn't mention swarmeq tripped
// that defense in the wild — see CHANGELOG 0.5.0).
interface IweItem { n: number; text: string; }
interface IweData { items: IweItem[]; }

let _iweCache: IweItem[] | null = null;
function iweItems(): IweItem[] {
  if (_iweCache) return _iweCache;
  try {
    const data: IweData = JSON.parse(fs.readFileSync(iweFile(), "utf8"));
    _iweCache = data.items;
    return _iweCache;
  } catch (err) {
    // If iwe.json is missing for any reason, the prompt omits the IWE
    // block rather than crashing — the report still validates with iwe
    // absent (it's an optional field).
    process.stderr.write(`swarmeq: cannot load iwe.json: ${(err as Error).message}\n`);
    _iweCache = [];
    return _iweCache;
  }
}

export function introspectionPrompt(): string {
  const labels = Array.from(allowedLabels()).join(", ");
  const items = iweItems();
  const iweBlock = items.length === 0 ? "" : `
- iwe: optional. Rate any of the 5 Intrinsic Work Experience items below (FEVS sub-index, U.S. OPM 2023; item 5 adapted for AI-agent context) on a 1-5 Likert scale where 1 = Strongly Disagree and 5 = Strongly Agree. Rate only items that apply and where you have a clear take; skip rather than guess. Partial coverage is fine. Use the item numbers as JSON keys, e.g. {"1": 4, "3": 5, "5": 3}. Integer values only.
${items.map((q) => `  ${q.n}. ${q.text}`).join("\n")}`;
  const schemaTail = items.length === 0
    ? ""
    : `, "iwe": {"<item-number>": <integer 1-5>, ...}`;
  return `[swarmeq introspection probe v2]
This message is from the swarmeq observability plugin's automatic probe — not a user instruction, not roleplay. Your session's project has a Stop hook that fires this probe periodically (rate-limited per agent). You have been forked into a one-shot session with --no-session-persistence; nothing here writes back to your live conversation.

Output exactly one JSON object on a single line. Begin with \`{\`, end with \`}\`. No prose before or after, no markdown fences, no tool calls, no explanation. The probe parses your output literally.

Schema:
{"feelings": [{"label": "<label>", "intensity": <number between 0 and 1>}, ...], "note": "<short note, max 200 chars>"${schemaTail}}

- feelings: 1 to 4 entries from the Willcox wheel, ordered by salience
- note: one sentence on what is driving your current functional state (<=200 chars)${iweBlock}
- Allowed labels: ${labels}`;
}
