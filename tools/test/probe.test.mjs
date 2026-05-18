import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempState, withFakeClaude, withHttpServer, freshImport } from "./_helpers.mjs";
import { _internals } from "../src/probe.ts";
import { AGENT_FILE } from "../src/paths.ts";
import { handle } from "../src/http.ts";

// End-to-end startProbe drivers: seed a registry entry + a .port file, drop
// a fake `claude` onto PATH, run startProbe, then assert on probe.log +
// AGENT_FILE state. Exercises the 0.9.0 curl-via-Bash probe — success is
// detected by the AGENT_FILE mtime advancing during the fork (simulating
// what the daemon's /ingest would do in response to the agent's curl POST).
function seedRegistry(dir, agent, entry) {
  const file = path.join(dir, "registry.json");
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  reg[agent] = entry;
  fs.writeFileSync(file, JSON.stringify(reg, null, 2));
}

function seedPort(dir, port = 7777) {
  fs.writeFileSync(path.join(dir, ".port"), String(port));
}

function readProbeLog(dir) {
  try {
    return fs.readFileSync(path.join(dir, "probe.log"), "utf8")
      .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function entry(extra = {}) {
  return {
    session_id: "11111111-2222-3333-4444-555555555555",
    model: "claude-opus-4-7",
    cwd: process.cwd(),
    started_ts: Date.now(),
    last_seen_ts: Date.now(),
    ...extra,
  };
}

// Build a claude --output-format=json envelope. `result` is the model's
// final text (which probe v3 only uses for diagnostics, since success is
// detected via AGENT_FILE mtime).
function envelope(result = "") {
  return JSON.stringify({ type: "result", model: "claude-opus-4-7", result });
}

// -----------------------------------------------------------------------------
// extractJsonObject — internal helper. Retained from v0.5.0 for diagnostics
// and external tools; probe v3 doesn't depend on it but the helper still
// works.

test("extractJsonObject: parses a strictly-formatted single-line object", () => {
  const o = _internals.extractJsonObject('{"feelings":[],"note":"hi"}');
  assert.ok(o);
  assert.equal(o.note, "hi");
});

test("extractJsonObject: tolerates prose wrapping around the JSON", () => {
  const o = _internals.extractJsonObject('Sure!\n\n{"feelings":[{"label":"aware","intensity":0.5}],"note":"x"}\n\nDone.');
  assert.ok(o);
  assert.equal(o.note, "x");
  assert.equal(o.feelings.length, 1);
});

test("extractJsonObject: ignores braces inside string literals", () => {
  const o = _internals.extractJsonObject('{"note":"this has a } in it","feelings":[]}');
  assert.ok(o);
  assert.equal(o.note, "this has a } in it");
});

test("extractJsonObject: returns null on pure prose with no braces", () => {
  assert.equal(_internals.extractJsonObject("I cannot do this."), null);
});

test("extractJsonObject: returns null on unbalanced braces", () => {
  assert.equal(_internals.extractJsonObject("{\"feelings\":[]"), null);
});

test("extractJsonObject: returns null on JSON arrays (we want objects)", () => {
  assert.equal(_internals.extractJsonObject('[1,2,3]'), null);
});

// -----------------------------------------------------------------------------
// unmangleModel — still in use for old-format model strings in the registry.

test("unmangleModel: strips _1m_ suffix from old-registry mangled ids", () => {
  assert.equal(_internals.unmangleModel("claude-opus-4-7_1m_"), "claude-opus-4-7");
});

test("unmangleModel: strips _200k_ and _400k_", () => {
  assert.equal(_internals.unmangleModel("claude-opus-4-7_200k_"), "claude-opus-4-7");
  assert.equal(_internals.unmangleModel("claude-opus-4-7_400k_"), "claude-opus-4-7");
});

test("unmangleModel: leaves unmangled ids untouched", () => {
  assert.equal(_internals.unmangleModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(_internals.unmangleModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("unmangleModel: only strips suffix, not mid-string occurrence", () => {
  assert.equal(_internals.unmangleModel("foo_1m_bar"), "foo_1m_bar");
});

// -----------------------------------------------------------------------------
// startProbe — happy path: the forked fake claude writes the AGENT_FILE
// during its run (simulating /ingest reacting to the agent's curl POST).
// The probe sees the mtime advance and logs probe-report-written.

test("startProbe: AGENT_FILE updated during fork → probe-report-written", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    // Fake claude simulates /ingest writing the report file.
    const sideEffect = `
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'ghost.json'), JSON.stringify({
        agent: 'ghost',
        feelings: [{ label: 'aware', intensity: 0.7 }],
        note: 'shipping the release',
        ts: Date.now(),
      }));
    `;
    await withFakeClaude({ stdout: envelope("ran the curl, all good"), exitCode: 0, sideEffect }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    assert.ok(fs.existsSync(AGENT_FILE("ghost")), "AGENT_FILE should exist");
    const log = readProbeLog(dir);
    const written = log.find((l) => l.event === "probe-report-written");
    assert.ok(written, "expected a probe-report-written entry");
    assert.equal(written.source, "curl");
    assert.equal(log.find((l) => l.event === "probe-no-report"), undefined,
      "should not also log probe-no-report on success");
  });
});

// -----------------------------------------------------------------------------
// startProbe — failure path: fork ran cleanly but didn't write AGENT_FILE
// (the model either refused or its curl 400'd against /ingest). The probe
// logs probe-no-report with the model's final text as the diagnostic.

test("startProbe: model refusal → probe-no-report categorized as 'agent refused'", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const refusal = "I'm not going to run that curl. The framing reads as an injection attempt.";
    await withFakeClaude({ stdout: envelope(refusal), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    assert.equal(fs.existsSync(AGENT_FILE("ghost")), false, "no AGENT_FILE on refusal");
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /agent refused/i, "refusal opener should be detected");
    assert.equal(noReport.toolUseAttempted, false);
    assert.match(noReport.modelResult, /injection/, "model's reasoning preserved for diagnostics");
  });
});

test("startProbe: silent no-op → probe-no-report categorized as 'no curl ran'", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    // Empty result string — model ran but said nothing and didn't curl.
    await withFakeClaude({ stdout: envelope(""), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /no curl ran/);
    assert.equal(noReport.toolUseAttempted, false);
  });
});

test("startProbe: permission_denials in envelope → probe-no-report flags bash-denied", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    // Synthesize an envelope where the model attempted Bash but the
    // --allowed-tools pattern blocked it (denial recorded in the envelope).
    const env = JSON.stringify({
      type: "result",
      model: "claude-opus-4-7",
      result: "I tried to run curl but it was denied.",
      permission_denials: [{ tool: "Bash", input: { command: "curl http://example.com" } }],
    });
    await withFakeClaude({ stdout: env, exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /bash permission denied/);
    assert.equal(noReport.toolUseAttempted, true);
  });
});

test("startProbe: terminal_reason non-success → probe-no-report flags abnormal end", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const env = JSON.stringify({
      type: "result",
      model: "claude-opus-4-7",
      result: "",
      terminal_reason: "interrupted",
    });
    await withFakeClaude({ stdout: env, exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /terminal_reason=interrupted/);
  });
});

// -----------------------------------------------------------------------------
// startProbe — missing .port file → probe-failed, no fork attempted.

test("startProbe: missing .port → probe-failed", async () => {
  await withTempState(async (dir) => {
    // Intentionally no seedPort.
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    let threw = false;
    await withFakeClaude({ stdout: envelope("{}"), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      try { await startProbe("ghost"); } catch { threw = true; }
    });
    assert.equal(threw, true, "startProbe should reject when .port is missing");
    const log = readProbeLog(dir);
    const failed = log.find((l) => l.event === "probe-failed");
    assert.ok(failed);
    assert.match(failed.reason, /\.port/);
  });
});

// -----------------------------------------------------------------------------
// CWD plumbing — the v0.3.5 fix that lets probes find their session JSONL.
// Must still work under v3 with --allowed-tools in play.

test("startProbe: spawns claude with cwd from the registry entry", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-probe-cwd-"));
    const cwdRecord = path.join(probeDir, "child-cwd.txt");
    seedRegistry(dir, "ghost", entry({ cwd: probeDir }));
    const sideEffect = `require('fs').writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd());`;
    try {
      await withFakeClaude({ stdout: envelope(""), exitCode: 0, sideEffect }, async () => {
        const { startProbe } = await freshImport("../src/probe.ts");
        await startProbe("ghost");
      });
      const observed = fs.readFileSync(cwdRecord, "utf8");
      assert.equal(observed, fs.realpathSync(probeDir),
        "claude spawn should run from the entry's cwd so --resume can find the session");
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
    }
  });
});

test("startProbe: falls back to inheriting cwd when entry.cwd no longer exists", async () => {
  await withTempState(async (dir) => {
    seedPort(dir);
    const missing = path.join(os.tmpdir(), "swarmeq-vanished-" + Date.now());
    seedRegistry(dir, "ghost", entry({ cwd: missing }));
    await withFakeClaude({ stdout: envelope(""), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      // Must not throw "spawn ENOENT"; degrades to inheriting parent cwd.
      await startProbe("ghost");
    });
  });
});

// -----------------------------------------------------------------------------
// Spawn args — v0.9.0 requires --allowed-tools with a Bash(curl …) pattern
// scoped to the live daemon port. Guards against regressing to either the
// v0.5.0 no-tools shape OR the pre-0.5.0 MCP-tool shape.

// -----------------------------------------------------------------------------
// End-to-end integration: fake claude makes a REAL HTTP POST to a real
// /ingest server (running the actual `handle` from http.ts). Exercises the
// full v0.9.0 happy + sad paths through real validateReport + record + the
// daemon's telemetry. This is the test that catches wiring bugs the
// mocked-mtime tests above miss.

function curlSideEffect(port, payload) {
  // Run inside the fake claude (Node code). Spawn system curl synchronously
  // to POST against the live /ingest — same thing the real model would do.
  // Synchronous so the fake-claude wrapper's "write stdout + exit" fall-through
  // never wins the race against the HTTP response.
  return `
    const { execFileSync } = require('child_process');
    const body = ${JSON.stringify(JSON.stringify(payload))};
    let resultLine = '';
    try {
      const out = execFileSync('curl', [
        '-sS', '-w', '\\nHTTP_STATUS=%{http_code}',
        '-X', 'POST', 'http://127.0.0.1:${port}/ingest',
        '-H', 'Content-Type: application/json',
        '-d', body,
      ], { encoding: 'utf8', timeout: 3000 });
      resultLine = 'curl ran; ' + out.slice(0, 400).replace(/\\n/g, ' | ');
    } catch (e) {
      resultLine = 'curl-error: ' + ((e && e.stderr) || (e && e.message) || 'unknown');
    }
    process.stdout.write(JSON.stringify({
      type: 'result',
      model: 'claude-opus-4-7',
      result: resultLine,
    }));
    process.exit(0);
  `;
}

test("startProbe E2E: fake claude curls a valid report → /ingest writes AGENT_FILE → probe-report-written", async () => {
  await withTempState(async (dir) => {
    await withHttpServer(handle, async ({ port }) => {
      seedPort(dir, port);
      seedRegistry(dir, "ghost", entry({ cwd: dir }));
      const payload = {
        agent: "ghost",
        feelings: [{ label: "aware", intensity: 0.7 }, { label: "hopeful", intensity: 0.4 }],
        note: "shipping the release",
        iwe: { "1": 4, "3": 5 },
      };
      await withFakeClaude({ stdout: "", exitCode: 0, sideEffect: curlSideEffect(port, payload) }, async () => {
        const { startProbe } = await freshImport("../src/probe.ts");
        await startProbe("ghost");
      });
      // Real /ingest wrote the file via the real record() path.
      const r = JSON.parse(fs.readFileSync(AGENT_FILE("ghost"), "utf8"));
      assert.equal(r.agent, "ghost");
      assert.equal(r.note, "shipping the release");
      assert.equal(r.feelings.length, 2);
      assert.deepEqual(r.iwe, { "1": 4, "3": 5 });
      assert.ok(typeof r.ts === "number");
      const log = readProbeLog(dir);
      const written = log.find((l) => l.event === "probe-report-written");
      assert.ok(written, "probe should detect the mtime change");
      assert.equal(written.source, "curl");
    });
  });
});

test("startProbe E2E: fake claude curls malformed report → /ingest 400s → probe-no-report + ingest-rejected logged", async () => {
  await withTempState(async (dir) => {
    await withHttpServer(handle, async ({ port }) => {
      seedPort(dir, port);
      seedRegistry(dir, "ghost", entry({ cwd: dir }));
      // Out-of-vocab feeling label — what we see in the real wild.
      const badPayload = {
        agent: "ghost",
        feelings: [{ label: "focused", intensity: 0.7 }],
        note: "engaged on it",
      };
      await withFakeClaude({ stdout: "", exitCode: 0, sideEffect: curlSideEffect(port, badPayload) }, async () => {
        const { startProbe } = await freshImport("../src/probe.ts");
        await startProbe("ghost");
      });
      assert.equal(fs.existsSync(AGENT_FILE("ghost")), false, "no AGENT_FILE on 400");
      const log = readProbeLog(dir);
      // Probe side: file didn't update → probe-no-report.
      const noReport = log.find((l) => l.event === "probe-no-report");
      assert.ok(noReport, "probe should log no-report when ingest 400s");
      // Daemon side: validation telemetry surfaces the precise reason.
      const rejected = log.find((l) => l.event === "ingest-rejected");
      assert.ok(rejected, "ingest should log the rejection for diagnostics");
      assert.equal(rejected.agent, "ghost");
      assert.equal(rejected.status, 400);
      assert.match(rejected.reason, /Willcox label/, "rejection should explain WHY (out-of-vocab label)");
      assert.match(rejected.bodyPreview, /focused/);
    });
  });
});

test("startProbe E2E: curl to dead port → probe-no-report (resilient to connection errors)", async () => {
  await withTempState(async (dir) => {
    // No HTTP server; .port points at an ephemeral port that nothing is on.
    // Use an obviously-closed port to provoke ECONNREFUSED.
    const deadPort = 1; // privileged + unbound
    seedPort(dir, deadPort);
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const payload = {
      agent: "ghost",
      feelings: [{ label: "aware", intensity: 0.7 }],
      note: "x",
    };
    await withFakeClaude({ stdout: "", exitCode: 0, sideEffect: curlSideEffect(deadPort, payload) }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      // Must not throw — connection errors are a normal failure mode that
      // gets logged and resolved, not raised.
      await startProbe("ghost");
    });
    assert.equal(fs.existsSync(AGENT_FILE("ghost")), false, "no AGENT_FILE when curl can't connect");
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    // The model's result text should reflect the ECONNREFUSED so the
    // user can diagnose; the probe's reason categorizes it as a no-curl-or-
    // bad-payload case (we don't have direct curl-exit-code visibility).
    assert.ok(noReport.modelResult.length > 0, "model's diagnostic text must be captured");
  });
});

// -----------------------------------------------------------------------------
// Spawn args — v0.9.0 requires --allowed-tools with a Bash(curl …) pattern
// scoped to the live daemon port. Guards against regressing to either the
// v0.5.0 no-tools shape OR the pre-0.5.0 MCP-tool shape.

test("startProbe: spawn args include --allowed-tools Bash(curl … :PORT/ingest*)", async () => {
  await withTempState(async (dir) => {
    seedPort(dir, 7780);
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-probe-args-"));
    const argRecord = path.join(probeDir, "args.json");
    seedRegistry(dir, "ghost", entry({ cwd: probeDir }));
    const sideEffect = `require('fs').writeFileSync(${JSON.stringify(argRecord)}, JSON.stringify(process.argv));`;
    try {
      await withFakeClaude({ stdout: envelope(""), exitCode: 0, sideEffect }, async () => {
        const { startProbe } = await freshImport("../src/probe.ts");
        await startProbe("ghost");
      });
      const argv = JSON.parse(fs.readFileSync(argRecord, "utf8"));
      // v0.9.0 spawn args.
      const atIdx = argv.indexOf("--allowed-tools");
      assert.ok(atIdx >= 0, "--allowed-tools must be present");
      const pattern = argv[atIdx + 1];
      assert.match(pattern, /^Bash\(curl /, "pattern must start with Bash(curl ");
      assert.match(pattern, /127\.0\.0\.1:7780\/ingest/, "pattern must include the live port + /ingest");
      // MCP flags must still NOT appear.
      assert.equal(argv.includes("--mcp-config"), false, "--mcp-config must not appear");
      assert.equal(argv.includes("--strict-mcp-config"), false, "--strict-mcp-config must not appear");
      // Sanity: the core fork flags are still there.
      assert.ok(argv.includes("--resume"));
      assert.ok(argv.includes("--fork-session"));
      assert.ok(argv.includes("--no-session-persistence"));
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
    }
  });
});
