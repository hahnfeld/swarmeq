import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempState, withFakeClaude, freshImport } from "./_helpers.mjs";
import { _internals } from "../src/probe.ts";
import { AGENT_FILE } from "../src/paths.ts";

// End-to-end startProbe drivers: seed a registry entry, drop a fake `claude`
// onto PATH, run startProbe, then assert on probe.log + AGENT_FILE state.
// Exercises the 0.5.0 JSON-only fork probe without needing a live Claude.
function seedRegistry(dir, agent, entry) {
  const file = path.join(dir, "registry.json");
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  reg[agent] = entry;
  fs.writeFileSync(file, JSON.stringify(reg, null, 2));
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

// Build a claude --output-format=json envelope whose `result` is the given
// model-reply text. This mirrors the structure the real CLI produces.
function envelope(result) {
  return JSON.stringify({ type: "result", model: "claude-opus-4-7", result });
}

// -----------------------------------------------------------------------------
// extractJsonObject — internal helper

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
// unmangleModel — still in use for old-format model strings in the registry

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
// startProbe — the happy path: model emits valid JSON, report is written.

test("startProbe: strict JSON in envelope.result writes AGENT_FILE and logs probe-report-written", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const reply = '{"feelings":[{"label":"aware","intensity":0.7},{"label":"hopeful","intensity":0.4}],"note":"shipping the release"}';
    await withFakeClaude({ stdout: envelope(reply), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    const file = AGENT_FILE("ghost");
    assert.ok(fs.existsSync(file), "AGENT_FILE must be written");
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(report.agent, "ghost", "agent must be injected from probe context, not echoed by the model");
    assert.equal(report.note, "shipping the release");
    assert.equal(report.feelings.length, 2);
    assert.ok(typeof report.ts === "number" && report.ts > 0, "ts must be injected by validateReport");

    const log = readProbeLog(dir);
    const written = log.find((l) => l.event === "probe-report-written");
    assert.ok(written, "expected a probe-report-written entry");
    assert.equal(written.source, "json");
    assert.equal(log.find((l) => l.event === "probe-no-report"), undefined,
      "should not also log probe-no-report on success");
  });
});

test("startProbe: tolerant-extracts JSON that the model wrapped in prose anyway", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const reply = 'Sure, here is my state:\n\n{"feelings":[{"label":"thoughtful","intensity":0.6}],"note":"reasoning through edge cases"}\n\nLet me know.';
    await withFakeClaude({ stdout: envelope(reply), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    assert.ok(fs.existsSync(AGENT_FILE("ghost")), "tolerant extractor must still recover the report");
    const log = readProbeLog(dir);
    assert.ok(log.some((l) => l.event === "probe-report-written"));
  });
});

// -----------------------------------------------------------------------------
// startProbe — failure modes: probe-no-report with a useful reason.

test("startProbe: pure prose response logs probe-no-report with modelResult", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const reply = "I don't have a report tool available in my toolset.";
    await withFakeClaude({ stdout: envelope(reply), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    assert.equal(fs.existsSync(AGENT_FILE("ghost")), false, "no AGENT_FILE on non-JSON response");
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /no parseable JSON/);
    assert.match(noReport.modelResult, /report tool available/);
  });
});

test("startProbe: invalid feeling label logs probe-no-report with validation reason", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const reply = '{"feelings":[{"label":"not_a_real_label","intensity":0.5}],"note":"x"}';
    await withFakeClaude({ stdout: envelope(reply), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    assert.equal(fs.existsSync(AGENT_FILE("ghost")), false);
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /validation failed/);
    assert.match(noReport.reason, /Willcox label/);
  });
});

test("startProbe: intensity out of [0,1] logs probe-no-report", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const reply = '{"feelings":[{"label":"aware","intensity":1.5}],"note":""}';
    await withFakeClaude({ stdout: envelope(reply), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    const log = readProbeLog(dir);
    const noReport = log.find((l) => l.event === "probe-no-report");
    assert.ok(noReport);
    assert.match(noReport.reason, /intensity/);
  });
});

test("startProbe: empty feelings array logs probe-no-report", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", entry({ cwd: dir }));
    const reply = '{"feelings":[],"note":"nothing to report"}';
    await withFakeClaude({ stdout: envelope(reply), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
    });
    const log = readProbeLog(dir);
    assert.ok(log.find((l) => l.event === "probe-no-report"));
  });
});

// -----------------------------------------------------------------------------
// CWD plumbing — unchanged from prior releases; the JSON-only switch must not
// regress the v0.3.5 fix that let probes find their session JSONL.

test("startProbe: spawns claude with cwd from the registry entry", async () => {
  await withTempState(async (dir) => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-probe-cwd-"));
    const cwdRecord = path.join(probeDir, "child-cwd.txt");
    seedRegistry(dir, "ghost", entry({ cwd: probeDir }));
    const sideEffect = `require('fs').writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd());`;
    try {
      await withFakeClaude({ stdout: envelope("{}"), exitCode: 0, sideEffect }, async () => {
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
    const missing = path.join(os.tmpdir(), "swarmeq-vanished-" + Date.now());
    seedRegistry(dir, "ghost", entry({ cwd: missing }));
    await withFakeClaude({ stdout: envelope("{}"), exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      // Must not throw "spawn ENOENT"; degrades to inheriting parent cwd.
      await startProbe("ghost");
    });
  });
});

// -----------------------------------------------------------------------------
// Spawn args — explicit guard against accidentally re-introducing the MCP
// flags that broke teammates pre-0.5.0.

test("startProbe: spawn args do NOT include --mcp-config / --strict-mcp-config / --allowed-tools", async () => {
  await withTempState(async (dir) => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-probe-args-"));
    const argRecord = path.join(probeDir, "args.json");
    seedRegistry(dir, "ghost", entry({ cwd: probeDir }));
    const sideEffect = `require('fs').writeFileSync(${JSON.stringify(argRecord)}, JSON.stringify(process.argv));`;
    try {
      await withFakeClaude({ stdout: envelope("{}"), exitCode: 0, sideEffect }, async () => {
        const { startProbe } = await freshImport("../src/probe.ts");
        await startProbe("ghost");
      });
      const argv = JSON.parse(fs.readFileSync(argRecord, "utf8"));
      assert.equal(argv.includes("--mcp-config"), false, "--mcp-config must not appear");
      assert.equal(argv.includes("--strict-mcp-config"), false, "--strict-mcp-config must not appear");
      assert.equal(argv.includes("--allowed-tools"), false, "--allowed-tools must not appear");
      // Sanity: the flags we DO want must still be present.
      assert.ok(argv.includes("--resume"));
      assert.ok(argv.includes("--fork-session"));
      assert.ok(argv.includes("--no-session-persistence"));
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
    }
  });
});
