import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AGENT_FILE, PROBE_LOG_FILE, pluginRoot, readRegistry, writeAtomic } from "./paths.ts";
import type { RegistryEntry } from "./paths.ts";
import { bindState, readActivePort } from "./bind.ts";
import { broadcast } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { introspectionPrompt } from "./prompt.ts";

const PROBE_TIMEOUT_MS = 30_000;
const LOG_ROTATE_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 200 * 1024;

// Old session-start hooks (<=0.3.3) mangled bracket-suffix model ids when
// writing to the registry: claude-opus-4-7[1m] became claude-opus-4-7_1m_,
// and `claude --model` 404s on the mangled form. Strip the mangle token so
// the probe can recover even before the user's next session-start hook
// rewrites the entry. Session-start.ts handles the fix-at-storage side.
function unmangleModel(s: string): string {
  return s.replace(/_(1m|200k|400k)_$/i, "");
}

// JSONL line: source of truth for the probe's lifecycle. Always written
// regardless of who's listening on SSE, so post-mortem debugging works
// even when the dashboard never had a live connection.
function rotateIfLarge(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size < LOG_ROTATE_BYTES) return;
    const all = fs.readFileSync(file, "utf8");
    const tail = all.slice(-LOG_KEEP_BYTES);
    const firstNl = tail.indexOf("\n");
    const trimmed = firstNl >= 0 ? tail.slice(firstNl + 1) : tail;
    writeAtomic(file, trimmed);
  } catch { /* file missing or unreadable; next append will create it */ }
}

function logProbe(agent: string, event: SseEvent, data: Record<string, unknown> = {}): void {
  const payload = { ts: Date.now(), agent, event, ...data };
  const file = PROBE_LOG_FILE();
  rotateIfLarge(file);
  try { fs.appendFileSync(file, JSON.stringify(payload) + "\n"); }
  catch { /* best-effort; the broadcast and HTTP forward still run */ }
  broadcast(event, { agent, ...data });
  if (!bindState().bound) {
    // Detached subprocess: broadcast() reaches no one local. Forward to the
    // daemon's /probe-event so its SSE clients see it. record.ts uses the
    // same pattern for report ingest.
    forwardEvent(event, { agent, ...data }).catch(() => {});
  }
}

async function forwardEvent(type: SseEvent, data: Record<string, unknown>): Promise<void> {
  const port = bindState().port || (await readActivePort());
  if (!port) return;
  return new Promise<void>((resolve, reject) => {
    const body = JSON.stringify({ type, data });
    const req = http.request({
      host: "127.0.0.1", port, path: "/probe-event", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); res.once("end", () => resolve()); });
    req.once("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("probe-event timeout")));
    req.write(body);
    req.end();
  });
}

export async function startProbe(agent: string): Promise<void> {
  const entry = lookupAgent(agent);
  if (!entry || !entry.session_id) {
    const reason = `no registered session for agent "${agent}"`;
    logProbe(agent, "probe-failed", { reason });
    throw new Error(reason);
  }
  const sid = entry.session_id;
  const rawModel = entry.model && entry.model !== "unknown"
    ? entry.model
    : (process.env.ANTHROPIC_MODEL || "sonnet");
  const model = unmangleModel(rawModel);

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
  const startedAt = Date.now();
  // `claude --resume <sid>` only finds the JSONL when the spawn's CWD maps
  // to the same project directory that recorded the session. Without this,
  // the probe inherits the daemon's CWD (typically the dir the user ran
  // /swarmeq-dashboard from) and team subagents registered with a different
  // cwd fail with "No conversation found". Fall back to inheriting if the
  // recorded cwd has since been deleted.
  const probeCwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : undefined;
  return new Promise<void>((resolve, reject) => {
    const env = { ...process.env, ANTHROPIC_MODEL: String(model) };
    const child = spawn("claude", args, { env, cwd: probeCwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "", stderr = "";
    let stdoutTrunc = false, stderrTrunc = false;
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < BUF_CAP) { stdout += c.toString(); }
      else if (!stdoutTrunc) { stdoutTrunc = true; }
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < BUF_CAP) { stderr += c.toString(); }
      else if (!stderrTrunc) { stderrTrunc = true; }
    });

    let killHard: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM.
      killHard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      logProbe(agent, "probe-failed", { reason: `probe timeout after ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);

    const cleanup = () => { clearTimeout(timer); if (killHard) clearTimeout(killHard); };

    child.once("error", (err: Error) => {
      cleanup();
      logProbe(agent, "probe-failed", { reason: `spawn failed: ${err.message}` });
      reject(err);
    });

    child.once("close", (code: number | null) => {
      cleanup();
      logProbe(agent, "probe-exit", {
        code,
        stdoutTail: stdout.slice(-500),
        stderrTail: stderr.slice(-500),
        truncated: { stdout: stdoutTrunc, stderr: stderrTrunc },
      });
      if (code !== 0) {
        const tail = stderr.slice(-500) || stdout.slice(-500);
        // Older Claude Code versions (<2.1.117) reject --fork-session /
        // --no-session-persistence as unknown options. Detect that pattern
        // and emit an actionable reason instead of the raw stderr tail.
        const old = /unknown option/i.test(stderr) &&
                    /(--fork-session|--no-session-persistence)/.test(stderr);
        const reason = old
          ? "claude too old: needs >=2.1.117 (--fork-session unsupported)"
          : `claude exited ${code}: ${tail}`;
        logProbe(agent, "probe-failed", { reason });
        return reject(new Error(reason));
      }
      // Parse the JSON envelope once: used for model-pin verification AND
      // for the probe-no-report diagnostic below. Non-JSON output is fine —
      // both branches degrade to "skip the check" silently.
      let envelope: { model?: string; system?: { model?: string }; init?: { model?: string }; result?: unknown } | null = null;
      try { envelope = JSON.parse(stdout); } catch { /* not JSON, that's ok */ }
      if (envelope) {
        const got = envelope.model || envelope.system?.model || envelope.init?.model;
        if (got && got !== model && !got.includes(model) && !model.includes(got)) {
          logProbe(agent, "model-mismatch", { expected: model, got });
        }
      }
      // Bug 2 surface: forked Claude sometimes exits cleanly without ever
      // invoking mcp__swarmeq__report (frozen tool catalog suspected). If
      // AGENT_FILE wasn't touched during this probe, the run was a silent
      // no-op — log it, plus the model's actual prose response, so we can
      // distinguish "didn't see the tool" from "saw the tool but refused".
      if (!reportWrittenSince(agent, startedAt)) {
        const modelResult = typeof envelope?.result === "string"
          ? envelope.result.slice(0, 1000)
          : "";
        logProbe(agent, "probe-no-report", {
          reason: "claude exited 0 but no report was written",
          modelResult,
          stdoutTail: stdout.slice(-500),
        });
      }
      resolve();
    });
  });
}

function reportWrittenSince(agent: string, sinceMs: number): boolean {
  try {
    const stat = fs.statSync(AGENT_FILE(agent));
    return stat.mtimeMs >= sinceMs;
  } catch { return false; }
}

function lookupAgent(agent: string): RegistryEntry | null {
  return readRegistry()[agent] || null;
}

// Exported for tests.
export const _internals = { unmangleModel, logProbe, reportWrittenSince, rotateIfLarge };
