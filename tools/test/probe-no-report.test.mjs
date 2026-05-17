import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTempState } from "./_helpers.mjs";
import { _internals } from "../src/probe.ts";
import { AGENT_FILE } from "../src/paths.ts";

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
