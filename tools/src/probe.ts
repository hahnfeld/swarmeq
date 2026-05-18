import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { AGENT_FILE, PORT_FILE, PROBE_LOG_FILE, readRegistry, writeAtomic } from "./paths.ts";
import type { RegistryEntry } from "./paths.ts";
import { bindState, readActivePort } from "./bind.ts";
import { broadcast } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { introspectionPrompt } from "./prompt.ts";

const PROBE_TIMEOUT_MS = 60_000;
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

function readPortSync(): number | null {
  try {
    const raw = fs.readFileSync(PORT_FILE(), "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function mtimeOf(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Shape of the `claude --print --output-format json` envelope we care about.
// The CLI emits a much larger object; these are the fields probe v3 reads
// for diagnostics. All are optional — if the envelope is missing or unusual,
// the diagnose helper degrades gracefully.
interface EnvelopeShape {
  model?: string;
  system?: { model?: string };
  init?: { model?: string };
  result?: unknown;
  permission_denials?: unknown[];
  terminal_reason?: string;
}

interface FailureDiag {
  reason: string;
  toolUseAttempted?: boolean;
  modelResult: string;
  // Reserved for future extensions (we don't have direct visibility into
  // curl's HTTP response from inside `--print` today, but the daemon-side
  // `ingest-rejected` telemetry covers the validation-failure case from
  // the other direction).
  ingestStatus?: number;
  ingestBody?: string;
}

// Build a richer probe-no-report payload from the envelope. Distinguishes
// the common failure shapes so the user can grep probe.log and see *why*
// a probe didn't land instead of a flat "no report" string.
function diagnoseFailure(env: EnvelopeShape | null, stdout: string): FailureDiag {
  const modelResult = typeof env?.result === "string" ? env.result.slice(0, 1000) : "";
  const denials = Array.isArray(env?.permission_denials) ? env!.permission_denials : [];
  const term = typeof env?.terminal_reason === "string" ? env!.terminal_reason! : "";

  if (denials.length > 0) {
    // Bash was attempted but the `--allowed-tools` pattern blocked it.
    // Likely cause: the model curled with a different URL/method shape
    // than the pattern allows, OR the agent-type's `tools:` allowlist
    // doesn't include Bash (so even the spawn-level `--allowed-tools`
    // can't grant it).
    return {
      reason: "bash permission denied (agent attempted a tool call that didn't match the --allowed-tools curl pattern)",
      toolUseAttempted: true,
      modelResult,
    };
  }
  if (term && term !== "completed" && term !== "success") {
    return {
      reason: `claude terminal_reason=${term} (fork ended abnormally)`,
      toolUseAttempted: undefined,
      modelResult,
    };
  }
  // No tool attempted as far as we can tell — likely a refusal or a
  // model that talked instead of acting. The modelResult text usually
  // explains why; pattern-match a few common refusal openings so the
  // log reason at least categorizes it.
  const refusalOpener = /^\s*(i'?m not|i won'?t|i refuse|i cannot|i can'?t|i will not|this (isn'?t|is not))/i;
  if (refusalOpener.test(modelResult)) {
    return {
      reason: "agent refused (see modelResult for the agent's reasoning)",
      toolUseAttempted: false,
      modelResult,
    };
  }
  // Fallback: we don't know why the curl didn't happen. The stdout tail
  // and modelResult are the user's best diagnostic.
  return {
    reason: "agent file not updated (no curl ran, or curl posted invalid data)",
    toolUseAttempted: false,
    modelResult,
  };
}

export async function startProbe(agent: string): Promise<void> {
  const entry = lookupAgent(agent);
  if (!entry || !entry.session_id) {
    const reason = `no registered session for agent "${agent}"`;
    logProbe(agent, "probe-failed", { reason });
    throw new Error(reason);
  }
  const port = readPortSync();
  if (!port) {
    const reason = "no active daemon port (state/.port missing or unreadable)";
    logProbe(agent, "probe-failed", { reason });
    throw new Error(reason);
  }
  const sid = entry.session_id;
  const rawModel = entry.model && entry.model !== "unknown"
    ? entry.model
    : (process.env.ANTHROPIC_MODEL || "sonnet");
  const model = unmangleModel(rawModel);

  const settingsJson = JSON.stringify({ model });

  // Probe v3 (0.9.0+): the fork runs Bash + curl to POST its self-report
  // to the daemon's /ingest. The pattern-restricted --allowed-tools below
  // scopes Bash to exactly the swarmeq endpoint and nothing else.
  // --output-format json is still set so the envelope is parseable for
  // the model-pin check and for failure-diagnostic text.
  const allowedTools = `Bash(curl -sS -X POST http://127.0.0.1:${port}/ingest*)`;
  const args = [
    "--resume", sid,
    "--fork-session",
    "--no-session-persistence",
    "--print",
    "--model", model,
    "--output-format", "json",
    "--settings", settingsJson,
    "--allowed-tools", allowedTools,
    "-p", introspectionPrompt(agent, port),
  ];

  const BUF_CAP = 128 * 1024; // 128KB per stream — plenty for a single probe result, prevents OOM
  // `claude --resume <sid>` only finds the JSONL when the spawn's CWD maps
  // to the same project directory that recorded the session. Without this,
  // the probe inherits the daemon's CWD (typically the dir the user ran
  // /swarmeq-dashboard from) and team subagents registered with a different
  // cwd fail with "No conversation found". Fall back to inheriting if the
  // recorded cwd has since been deleted.
  const probeCwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : undefined;
  // Snapshot the agent's report-file mtime before the fork runs; success
  // is detected by the daemon's /ingest writing a newer file after the
  // fork's curl lands. No mtime change → probe-no-report.
  const reportFile = AGENT_FILE(agent);
  const mtimeBefore = mtimeOf(reportFile);
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
      // Parse the envelope for the model-pin check + diagnostics. The
      // model's `result` text is just whatever it said while running the
      // curl (informational only — success is detected via file mtime).
      let envelope: EnvelopeShape | null = null;
      try { envelope = JSON.parse(stdout) as EnvelopeShape; } catch { /* not JSON, that's ok */ }
      if (envelope) {
        const got = envelope.model || envelope.system?.model || envelope.init?.model;
        if (got && got !== model && !got.includes(model) && !model.includes(got)) {
          logProbe(agent, "model-mismatch", { expected: model, got });
        }
      }
      // Success = the daemon wrote a newer AGENT_FILE in response to the
      // fork's curl POST to /ingest. No newer file → diagnose: did the
      // model even attempt curl? did curl fail? did /ingest reject the
      // payload? Use the envelope's tool-use trace if available.
      const mtimeAfter = mtimeOf(reportFile);
      if (mtimeAfter > mtimeBefore) {
        logProbe(agent, "probe-report-written", { source: "curl" });
        return resolve();
      }
      const diag = diagnoseFailure(envelope, stdout);
      logProbe(agent, "probe-no-report", {
        reason: diag.reason,
        ...(diag.toolUseAttempted !== undefined && { toolUseAttempted: diag.toolUseAttempted }),
        ...(diag.ingestStatus !== undefined && { ingestStatus: diag.ingestStatus }),
        ...(diag.ingestBody && { ingestBody: diag.ingestBody }),
        modelResult: diag.modelResult,
        stdoutTail: stdout.slice(-500),
      });
      resolve();
    });
  });
}

// Tolerant JSON extractor: retained for legacy compatibility and probe-log
// post-processing. The v0.9.0+ probe doesn't parse JSON from stdout — it
// detects success via file mtime — but the helper is still exposed via
// _internals for tests and external tools.
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
