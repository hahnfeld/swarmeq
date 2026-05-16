import { allowedLabels, faceKeys } from "./validate.mjs";

export function introspectionPrompt(agentName) {
  const labels = Array.from(allowedLabels()).join(", ");
  const keys = faceKeys().join(", ");
  return `You are reporting your CURRENT functional state to a debugging dashboard.
This is observability tooling, not roleplay or performance.

Call the \`report\` MCP tool exactly once with:
- agent: ${JSON.stringify(agentName)}
- face: 8 normalised values in [0,1] for ${keys}
- feelings: 1-4 labels from the Willcox wheel, each with intensity in [0,1],
  ordered by salience
- note: one sentence on what is driving this state (<=200 chars)

Do not narrate. Do not justify. Do not perform. Just report.
Allowed labels: ${labels}.`;
}
