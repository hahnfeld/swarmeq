import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withTempState } from "./_helpers.mjs";
import { record, readLivingReports, readAllReports } from "../src/record.ts";
import { AGENT_FILE, REGISTRY_FILE } from "../src/paths.ts";

const sample = (agent = "alpha", label = "joyful") => ({
  agent,
  feelings: [{ label, intensity: 0.7 }],
  note: "ok",
});

test("record: persists a valid report to AGENT_FILE", async () => {
  await withTempState(() => {
    return record(sample("alpha")).then(() => {
      const r = JSON.parse(fs.readFileSync(AGENT_FILE("alpha"), "utf8"));
      assert.equal(r.agent, "alpha");
      assert.equal(r.feelings[0].label, "joyful");
      assert.ok(typeof r.ts === "number");
    });
  });
});

test("record: throws with .code='EVALIDATE' on invalid input", async () => {
  await withTempState(async () => {
    await assert.rejects(
      record({ agent: "", feelings: [] }),
      (err) => err.code === "EVALIDATE"
    );
  });
});

test("readLivingReports: only returns agents present in registry.json", async () => {
  // This is the filter that produced the bug-report symptom: 9 sessions in
  // registry but 0 living-reports because no AGENT_FILE was ever written.
  // The inverse case — orphaned AGENT_FILE without a registry entry — must
  // also be filtered out.
  await withTempState(() => {
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify({
      alive: { session_id: "s1", model: "m", cwd: "/", started_ts: 1, last_seen_ts: 2 },
    }));
    fs.writeFileSync(AGENT_FILE("alive"),
      JSON.stringify({ agent: "alive", feelings: [{ label: "happy", intensity: 1 }], note: "", ts: 1 }));
    fs.writeFileSync(AGENT_FILE("orphan"),
      JSON.stringify({ agent: "orphan", feelings: [{ label: "happy", intensity: 1 }], note: "", ts: 1 }));
    const living = readLivingReports();
    assert.deepEqual(Object.keys(living), ["alive"]);
  });
});

test("readAllReports: skips registry.json and non-.json files", async () => {
  await withTempState((dir) => {
    fs.writeFileSync(REGISTRY_FILE(), "{}");
    fs.writeFileSync(path.join(dir, "noise.txt"), "ignore me");
    fs.writeFileSync(AGENT_FILE("real"),
      JSON.stringify({ agent: "real", feelings: [{ label: "happy", intensity: 1 }], note: "", ts: 1 }));
    const all = readAllReports();
    assert.deepEqual(Object.keys(all), ["real"]);
  });
});

test("record: same agent overwrites previous report", async () => {
  await withTempState(async () => {
    await record(sample("alpha", "joyful"));
    await record(sample("alpha", "sad"));
    const r = JSON.parse(fs.readFileSync(AGENT_FILE("alpha"), "utf8"));
    assert.equal(r.feelings[0].label, "sad");
  });
});
