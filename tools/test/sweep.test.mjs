import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTempState } from "./_helpers.mjs";
import { sweepStaleAgents } from "../src/sweep.ts";
import { AGENT_FILE, REGISTRY_FILE } from "../src/paths.ts";

const STALE_THRESHOLD_MS = 10 * 60 * 1000;

function writeReport(agent, tsMs) {
  fs.writeFileSync(AGENT_FILE(agent),
    JSON.stringify({ agent, feelings: [{ label: "happy", intensity: 1 }], note: "", ts: tsMs }));
}

test("sweepStaleAgents: unlinks reports older than STALE_MS", async () => {
  await withTempState(() => {
    const old = Date.now() - STALE_THRESHOLD_MS - 60_000;
    writeReport("dead", old);
    const removed = sweepStaleAgents();
    assert.ok(removed.includes("dead"));
    assert.equal(fs.existsSync(AGENT_FILE("dead")), false);
  });
});

test("sweepStaleAgents: leaves fresh reports alone", async () => {
  await withTempState(() => {
    writeReport("alive", Date.now());
    const removed = sweepStaleAgents();
    assert.equal(removed.includes("alive"), false);
    assert.ok(fs.existsSync(AGENT_FILE("alive")));
  });
});

test("sweepStaleAgents: ignores registry.json", async () => {
  await withTempState(() => {
    fs.writeFileSync(REGISTRY_FILE(), "{}");
    const removed = sweepStaleAgents();
    assert.equal(removed.includes("registry"), false);
    assert.ok(fs.existsSync(REGISTRY_FILE()));
  });
});

test("sweepStaleAgents: returns empty array when state dir has nothing", async () => {
  await withTempState(() => {
    const removed = sweepStaleAgents();
    assert.deepEqual(removed, []);
  });
});

test("sweepStaleAgents: keeps file with ts=0 (sweep needs a valid ts to act)", async () => {
  await withTempState(() => {
    writeReport("nots", 0);
    const removed = sweepStaleAgents();
    // ts=0 means "unknown" → not stale by the readReportTs logic
    assert.equal(removed.includes("nots"), false);
    assert.ok(fs.existsSync(AGENT_FILE("nots")));
  });
});
