import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTempState } from "./_helpers.mjs";
import { _internals } from "../src/probe.ts";
import { PROBE_LOG_FILE } from "../src/paths.ts";

test("logProbe: appends one JSONL line per call", async () => {
  await withTempState(() => {
    _internals.logProbe("alpha", "probe-failed", { reason: "first" });
    _internals.logProbe("beta", "probe-exit", { code: 0 });
    const lines = fs.readFileSync(PROBE_LOG_FILE(), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.agent, "alpha");
    assert.equal(a.event, "probe-failed");
    assert.equal(a.reason, "first");
    assert.ok(typeof a.ts === "number" && a.ts > 0);
    assert.equal(b.agent, "beta");
    assert.equal(b.event, "probe-exit");
    assert.equal(b.code, 0);
  });
});

test("logProbe: each line is valid JSON with required fields", async () => {
  await withTempState(() => {
    _internals.logProbe("zed", "model-mismatch", { expected: "a", got: "b" });
    const line = fs.readFileSync(PROBE_LOG_FILE(), "utf8").trim();
    const obj = JSON.parse(line);
    assert.deepEqual(Object.keys(obj).sort(), ["agent", "event", "expected", "got", "ts"]);
  });
});

test("rotateIfLarge: trims oversize log to ~200KB on next write", async () => {
  await withTempState(() => {
    const big = "x".repeat(1100 * 1024); // > 1MB
    fs.writeFileSync(PROBE_LOG_FILE(), big + "\n");
    _internals.rotateIfLarge(PROBE_LOG_FILE());
    const size = fs.statSync(PROBE_LOG_FILE()).size;
    assert.ok(size <= 200 * 1024, `expected size <= 200KB after rotate, got ${size}`);
  });
});

test("rotateIfLarge: leaves small log untouched", async () => {
  await withTempState(() => {
    fs.writeFileSync(PROBE_LOG_FILE(), "small\n");
    _internals.rotateIfLarge(PROBE_LOG_FILE());
    assert.equal(fs.readFileSync(PROBE_LOG_FILE(), "utf8"), "small\n");
  });
});

test("rotateIfLarge: missing file is a no-op (no throw)", async () => {
  await withTempState(() => {
    assert.doesNotThrow(() => _internals.rotateIfLarge(PROBE_LOG_FILE()));
  });
});
