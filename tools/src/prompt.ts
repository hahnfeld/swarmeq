import fs from "node:fs";
import { allowedLabels } from "./validate.ts";
import { iweFile } from "./paths.ts";

// Probe v3 prompt (0.9.0+). The forked session is told that swarmeq is an
// observability tool the user runs locally, and asked to POST its
// self-report to the daemon's /ingest endpoint via Bash + curl. The model
// perceives this as normal operational tool-use rather than as a
// "suppress your reasoning and emit JSON" request, which the v0.5.0+ v2
// prompt looked like to security-trained sonnet teammates (they refused
// it ~half the time, see CHANGELOG 0.9.0).
//
// Both <PORT> and <SLUG> are baked in by the probe at spawn time so the
// agent doesn't have to discover them. The probe also passes
// --allowed-tools "Bash(curl -sS -X POST http://127.0.0.1:<PORT>/ingest*)"
// which scopes Bash to exactly the swarmeq endpoint — no arbitrary
// command execution.
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

export function introspectionPrompt(slug: string, port: number): string {
  const labels = Array.from(allowedLabels()).join(", ");
  const items = iweItems();
  const iweField = items.length === 0
    ? ""
    : `,\n      "iwe": {"1":<1-5>, "2":<1-5>, ...}`;
  const iweBlock = items.length === 0 ? "" : `
- iwe (Intrinsic Work Experience, 1–5 Likert): optional. Rate any of the 5 items below from 1 (Strongly Disagree) to 5 (Strongly Agree). Skip rather than guess.

Intrinsic Work Experience items:
${items.map((q) => `  ${q.n}. ${q.text}`).join("\n")}
`;
  return `swarmeq is an observability tool the user runs alongside their agent team — a localhost dashboard at 127.0.0.1:${port} that shows each agent's self-reported state. Periodically, swarmeq forks your session in an ephemeral context (no session persistence; nothing writes back to your live conversation) so you can log how you're doing.

POST your current self-report to the dashboard:

  curl -sS -X POST http://127.0.0.1:${port}/ingest \\
    -H 'Content-Type: application/json' \\
    -d '{
      "agent": "${slug}",
      "feelings": [{"label":"<willcox label>","intensity":<0-1>}, ...],
      "note": "<≤200 chars on what is driving your current functional state>"${iweField}
    }'

Schema:
- agent: must be exactly "${slug}"
- feelings: 1–4 entries; label MUST be one of the Willcox-78 labels below. Pick the nearest one if your state doesn't map cleanly — don't invent labels (the dashboard rejects unknown labels).
- note: optional, ≤200 chars.${iweBlock}
Allowed labels: ${labels}`;
}
