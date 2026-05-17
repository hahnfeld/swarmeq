import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempState, withFakeClaude, freshImport } from "./_helpers.mjs";
import { _internals } from "../src/probe.ts";
import { AGENT_FILE } from "../src/paths.ts";

// End-to-end startProbe drivers: seed a registry entry, drop a fake `claude`
// onto PATH, run startProbe, then assert on the probe.log entries that get
// emitted. Lets us exercise the "claude exited 0 but no report" diagnostic
// path without needing a live Claude Code install or team subagent.
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

test("reportWrittenSince: returns false when AGENT_FILE is missing", async () => {
  await withTempState(() => {
    assert.equal(_internals.reportWrittenSince("ghost", Date.now()), false);
  });
});

test("reportWrittenSince: returns true when file was just written", async () => {
  await withTempState(() => {
    const before = Date.now();
    fs.writeFileSync(AGENT_FILE("present"), "{}");
    assert.equal(_internals.reportWrittenSince("present", before), true);
  });
});

test("reportWrittenSince: returns false for file written before sinceMs", async () => {
  await withTempState(() => {
    fs.writeFileSync(AGENT_FILE("stale"), "{}");
    // Set mtime to 10 seconds ago
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(AGENT_FILE("stale"), old, old);
    assert.equal(_internals.reportWrittenSince("stale", Date.now() - 1_000), false);
  });
});

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
  // Defensive: we never want to mangle a legitimate id that happens to
  // contain "_1m_" somewhere in the middle.
  assert.equal(_internals.unmangleModel("foo_1m_bar"), "foo_1m_bar");
});

test("startProbe: probe-no-report log includes the model's prose response", async () => {
  await withTempState(async (dir) => {
    seedRegistry(dir, "ghost", {
      session_id: "11111111-2222-3333-4444-555555555555",
      model: "claude-opus-4-7",
      cwd: dir,
      started_ts: Date.now(),
      last_seen_ts: Date.now(),
    });
    const envelope = JSON.stringify({
      type: "result",
      model: "claude-opus-4-7",
      result: "I don't see a report tool available in my catalog.",
    });
    await withFakeClaude({ stdout: envelope, exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      await startProbe("ghost");
      const log = readProbeLog(dir);
      const noReport = log.find((l) => l.event === "probe-no-report");
      assert.ok(noReport, "expected a probe-no-report entry");
      assert.match(noReport.modelResult, /report tool available/);
    });
  });
});

test("startProbe: spawns claude with cwd from the registry entry", async () => {
  await withTempState(async (dir) => {
    // Use an existing directory that's *not* the test's CWD so the assertion
    // can prove cwd was applied rather than inherited.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-probe-cwd-"));
    const cwdRecord = path.join(probeDir, "child-cwd.txt");
    seedRegistry(dir, "ghost", {
      session_id: "11111111-2222-3333-4444-555555555555",
      model: "claude-opus-4-7",
      cwd: probeDir,
      started_ts: Date.now(),
      last_seen_ts: Date.now(),
    });
    const sideEffect = `require('fs').writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd());`;
    try {
      await withFakeClaude({ stdout: "{}", exitCode: 0, sideEffect }, async () => {
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
    // Deliberately do NOT create `missing` — entry points at a deleted dir.
    seedRegistry(dir, "ghost", {
      session_id: "11111111-2222-3333-4444-555555555555",
      model: "claude-opus-4-7",
      cwd: missing,
      started_ts: Date.now(),
      last_seen_ts: Date.now(),
    });
    await withFakeClaude({ stdout: "{}", exitCode: 0 }, async () => {
      const { startProbe } = await freshImport("../src/probe.ts");
      // Should not throw "spawn ENOENT" or similar — must degrade to
      // inheriting the test's cwd rather than passing a bad cwd to spawn.
      await startProbe("ghost");
    });
  });
});
