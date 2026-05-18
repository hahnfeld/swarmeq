import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTempState } from "./_helpers.mjs";
import { sweepStaleAgents, sweepStaleRegistry } from "../src/sweep.ts";
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

// Registry sweep (0.7.2+): catches sessions that exited abruptly without
// firing SessionEnd, so the registry stops growing unbounded over time
// and the dashboard stops rendering stale slug-only entries as UUIDs.
test("sweepStaleRegistry: drops entries whose last_seen_ts is older than STALE_MS", async () => {
  await withTempState(() => {
    const now = Date.now();
    const old = now - STALE_THRESHOLD_MS - 60_000;
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify({
      alive: { session_id: "a", model: "m", cwd: "/", started_ts: now, last_seen_ts: now },
      dead:  { session_id: "d", model: "m", cwd: "/", started_ts: old, last_seen_ts: old },
    }));
    const removed = sweepStaleRegistry(now);
    assert.deepEqual(removed, ["dead"]);
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE(), "utf8"));
    assert.ok(reg.alive, "fresh entry must survive");
    assert.equal(reg.dead, undefined, "stale entry must be removed");
  });
});

test("sweepStaleRegistry: returns empty when registry.json is missing", async () => {
  await withTempState(() => {
    const removed = sweepStaleRegistry(Date.now());
    assert.deepEqual(removed, []);
  });
});

test("sweepStaleRegistry: defensively skips entries with no last_seen_ts", async () => {
  await withTempState(() => {
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify({
      orphan: { session_id: "o", model: "m", cwd: "/", started_ts: 0 },
    }));
    const removed = sweepStaleRegistry(Date.now());
    assert.deepEqual(removed, [], "no last_seen_ts → not stale by this check");
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE(), "utf8"));
    assert.ok(reg.orphan, "entry without last_seen_ts must be left alone");
  });
});

test("sweepStaleAgents: registry sweep runs alongside the file sweep", async () => {
  await withTempState(() => {
    const now = Date.now();
    const old = now - STALE_THRESHOLD_MS - 60_000;
    writeReport("dead", old);
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify({
      dead: { session_id: "d", model: "m", cwd: "/", started_ts: old, last_seen_ts: old },
    }));
    const removed = sweepStaleAgents();
    assert.ok(removed.includes("dead"));
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE(), "utf8"));
    assert.equal(reg.dead, undefined, "stale registry entry must also be reaped");
  });
});
