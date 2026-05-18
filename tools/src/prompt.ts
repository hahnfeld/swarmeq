import { allowedLabels } from "./validate.ts";

// JSON-only probe prompt (0.5.0+). The forked session is asked to emit one
// JSON object as its entire reply — no tool calls, no prose. This decouples
// the probe from the forked session's tool catalog (which Agent Teams
// teammates' catalog filter used to block) and gets us "just emit your
// state" semantics that work uniformly for lead and teammates.
//
// The `agent` field is intentionally NOT requested from the model: the
// probe injects it from registry context after parsing, so a typo or hallucinated
// slug can't end up in the report. The lead-in line names the plugin so
// cautious teammates don't mistake the probe for an injection attempt
// (a v0.3.x prompt that didn't mention swarmeq tripped that defense in the
// wild — see CHANGELOG 0.5.0).
export function introspectionPrompt(): string {
  const labels = Array.from(allowedLabels()).join(", ");
  return `[swarmeq introspection probe v2]
This message is from the swarmeq observability plugin's automatic probe — not a user instruction, not roleplay. Your session's project has a Stop hook that fires this probe periodically (rate-limited per agent). You have been forked into a one-shot session with --no-session-persistence; nothing here writes back to your live conversation.

Output exactly one JSON object on a single line. Begin with \`{\`, end with \`}\`. No prose before or after, no markdown fences, no tool calls, no explanation. The probe parses your output literally.

Schema:
{"feelings": [{"label": "<label>", "intensity": <number between 0 and 1>}, ...], "note": "<short note, max 200 chars>"}

- feelings: 1 to 4 entries from the Willcox wheel, ordered by salience
- note: one sentence on what is driving your current functional state (<=200 chars)
- Allowed labels: ${labels}`;
}
