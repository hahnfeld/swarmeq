import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { PROBE_LOG_FILE, readRegistry, writeAtomic } from "./paths.ts";
import type { RegistryEntry } from "./paths.ts";
import { bindState, readActivePort } from "./bind.ts";
import { broadcast } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { introspectionPrompt } from "./prompt.ts";
import { record } from "./record.ts";

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

  const settingsJson = JSON.stringify({ model });

  // No --mcp-config / --strict-mcp-config / --allowed-tools: the JSON-only
  // probe (0.5.0+) doesn't ask the model to call any tool, so the forked
  // session's tool catalog doesn't matter. Removing these flags is what
  // unblocks Agent Teams teammates — the per-agent-type `tools:` filter
  // used to strip our MCP tool from forked-resume sessions, but the new
  // prompt just asks for a single JSON line, which any model can emit
  // regardless of catalog. The lead works under the same path too.
  const args = [
    "--resume", sid,
    "--fork-session",
    "--no-session-persistence",
    "--print",
    "--model", model,
    "--output-format", "json",
    "--settings", settingsJson,
    "-p", introspectionPrompt(),
  ];

  const BUF_CAP = 128 * 1024; // 128KB per stream — plenty for a single probe result, prevents OOM
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

    child.once("close", async (code: number | null) => {
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
      // Parse the JSON envelope once: used for the model-pin check AND for
      // extracting the JSON report from envelope.result. Non-JSON envelope
      // output is fine — both branches degrade gracefully.
      let envelope: { model?: string; system?: { model?: string }; init?: { model?: string }; result?: unknown } | null = null;
      try { envelope = JSON.parse(stdout); } catch { /* not JSON, that's ok */ }
      if (envelope) {
        const got = envelope.model || envelope.system?.model || envelope.init?.model;
        if (got && got !== model && !got.includes(model) && !model.includes(got)) {
          logProbe(agent, "model-mismatch", { expected: model, got });
        }
      }
      // JSON-only probe (0.5.0+): the prompt asks the model to emit a single
      // JSON object as its entire reply (which `--output-format json` puts in
      // envelope.result). Extract it, inject `agent` from probe context (we
      // don't trust the model to echo it correctly), validate via the
      // existing schema, and ingest through record(). The previous mechanism
      // (call mcp__swarmeq__report) fell apart on Agent Teams teammates
      // because --strict-mcp-config + the per-agent-type tools filter
      // stripped the tool from the forked-resume catalog. JSON-mode doesn't
      // care what's in the catalog.
      if (envelope && typeof envelope.result === "string") {
        const parsed = extractJsonObject(envelope.result);
        if (parsed) {
          parsed.agent = agent;
          try {
            await record(parsed);
            logProbe(agent, "probe-report-written", { source: "json" });
            return resolve();
          } catch (err) {
            logProbe(agent, "probe-no-report", {
              reason: `validation failed: ${(err as Error).message}`,
              modelResult: envelope.result.slice(0, 1000),
              stdoutTail: stdout.slice(-500),
            });
            return resolve();
          }
        }
      }
      const modelResult = typeof envelope?.result === "string"
        ? envelope.result.slice(0, 1000)
        : "";
      logProbe(agent, "probe-no-report", {
        reason: "no parseable JSON object in model response",
        modelResult,
        stdoutTail: stdout.slice(-500),
      });
      resolve();
    });
  });
}

// Tolerant JSON extractor: fast path for a strictly-formatted reply, plus a
// balanced-brace fallback for models that wrap their JSON in prose anyway.
// Bounded by the BUF_CAP cap on stdout (128KB), so the scan is cheap.
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const p = JSON.parse(trimmed);
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch { /* fall through to balanced-brace scan */ }
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const p = JSON.parse(trimmed.slice(start, i + 1));
        if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
      } catch { /* invalid JSON inside the braces, give up */ }
      return null;
    }
  }
  return null;
}

function lookupAgent(agent: string): RegistryEntry | null {
  return readRegistry()[agent] || null;
}

// Exported for tests.
export const _internals = { unmangleModel, logProbe, extractJsonObject, rotateIfLarge };
