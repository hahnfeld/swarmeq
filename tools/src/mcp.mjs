import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { record } from "./record.mjs";
import { faceKeys, allowedLabels } from "./validate.mjs";

const TOOL = {
  name: "report",
  description: "Report current functional state (8 facial actions + 1-4 Willcox feelings + optional note) to the swarmeq dashboard.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["agent", "face", "feelings"],
    properties: {
      agent: { type: "string", minLength: 1, maxLength: 64,
        description: "Stable identifier for this agent (Claude Code session_id or agent name)." },
      face: {
        type: "object",
        additionalProperties: false,
        required: faceKeys(),
        properties: Object.fromEntries(faceKeys().map((k) => [k,
          { type: "number", minimum: 0, maximum: 1 }])),
      },
      feelings: {
        type: "array", minItems: 1, maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "intensity"],
          properties: {
            label: { type: "string", enum: Array.from(allowedLabels()) },
            intensity: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
      note: { type: "string", maxLength: 200 },
    },
  },
};

export async function startMcp() {
  const server = new Server(
    { name: "swarmeq", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "report") {
      return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
    }
    try {
      const stored = await record(req.params.arguments);
      return { content: [{ type: "text", text: `recorded ${stored.agent} at ${new Date(stored.ts).toISOString()}` }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });

  await server.connect(new StdioServerTransport());
}
