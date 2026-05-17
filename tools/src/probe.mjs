import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REGISTRY_FILE, pluginRoot } from "./paths.mjs";
import { broadcast } from "./sse.mjs";
import { introspectionPrompt } from "./prompt.mjs";

const PROBE_TIMEOUT_MS = 30_000;

export async function startProbe(agent) {
  const entry = lookupAgent(agent);
  if (!entry || !entry.session_id) {
    const reason = `no registered session for agent "${agent}"`;
    broadcast("probe-failed", { agent, reason });
    throw new Error(reason);
  }
  const sid = entry.session_id;
  const model = entry.model && entry.model !== "unknown"
    ? entry.model
    : (process.env.ANTHROPIC_MODEL || "sonnet");

  const mcpConfig = JSON.stringify({
    mcpServers: {
      swarmeq: {
        command: "node",
        args: [path.join(pluginRoot(), "server", "swarmeq.mjs"), "mcp"],
      },
    },
  });
  const settingsJson = JSON.stringify({ model });

  const args = [
    "--resume", sid,
    "--fork-session",
    "--no-session-persistence",
    "--print",
    "--model", model,
    "--output-format", "json",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--allowed-tools", "mcp__swarmeq__report",
    "--settings", settingsJson,
    "-p", introspectionPrompt(agent),
  ];

  const BUF_CAP = 128 * 1024; // 128KB per stream — plenty for a single probe result, prevents OOM
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ANTHROPIC_MODEL: String(model) };
    const child = spawn("claude", args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "", stderr = "";
    let stdoutTrunc = false, stderrTrunc = false;
    child.stdout.on("data", (c) => {
      if (stdout.length < BUF_CAP) { stdout += c.toString(); }
      else if (!stdoutTrunc) { stdoutTrunc = true; }
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < BUF_CAP) { stderr += c.toString(); }
      else if (!stderrTrunc) { stderrTrunc = true; }
    });

    let killHard = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM.
      killHard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      broadcast("probe-failed", { agent, reason: `probe timeout after ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);

    const cleanup = () => { clearTimeout(timer); if (killHard) clearTimeout(killHard); };

    child.once("error", (err) => {
      cleanup();
      broadcast("probe-failed", { agent, reason: `spawn failed: ${err.message}` });
      reject(err);
    });

    child.once("close", (code) => {
      cleanup();
      if (code !== 0) {
        const tail = stderr.slice(-500) || stdout.slice(-500);
        broadcast("probe-failed", { agent, reason: `claude exited ${code}: ${tail}` });
        return reject(new Error(`claude exit ${code}: ${tail}`));
      }
      // Model-pin verification: parse the JSON envelope and confirm.
      try {
        const r = JSON.parse(stdout);
        const got = r?.model || r?.system?.model || r?.init?.model;
        if (got && got !== model && !got.includes(model) && !model.includes(got)) {
          broadcast("model-mismatch", { agent, expected: model, got });
        }
      } catch {
        // Non-JSON output is fine when --output-format=json wraps the result;
        // the actual report has already been delivered via the MCP tool path.
      }
      // No SSE emit here: the report itself broadcasts via record() when the
      // MCP tool fires inside the forked session.
      resolve();
    });
  });
}

function lookupAgent(agent) {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE(), "utf8"));
    return reg[agent] || null;
  } catch {
    return null;
  }
}
