import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withTempState } from "./_helpers.mjs";
import {
  sanitizeAgent, writeAtomic, readRegistry,
  stateDir, REGISTRY_FILE, PROBE_LOG_FILE, PORT_FILE, PID_FILE,
} from "../src/paths.ts";

test("sanitizeAgent: replaces bad chars with underscore, caps at 64", () => {
  assert.equal(sanitizeAgent("a/b c[1]"), "a_b_c_1_");
  assert.equal(sanitizeAgent("x".repeat(100)).length, 64);
});

test("sanitizeAgent: empty / nullish input returns '_'", () => {
  assert.equal(sanitizeAgent(""), "_");
  assert.equal(sanitizeAgent(undefined), "_");
});

test("writeAtomic: creates the target file and removes the tmp file", async () => {
  await withTempState((dir) => {
    const target = path.join(dir, "sample.json");
    writeAtomic(target, '{"x":1}');
    assert.equal(fs.readFileSync(target, "utf8"), '{"x":1}');
    const tmps = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.equal(tmps.length, 0, "tmp file should be renamed away, not left behind");
  });
});

test("readRegistry: returns {} for missing file", async () => {
  await withTempState(() => {
    assert.deepEqual(readRegistry(), {});
  });
});

test("readRegistry: returns {} for malformed JSON", async () => {
  await withTempState(() => {
    fs.writeFileSync(REGISTRY_FILE(), "not json {");
    assert.deepEqual(readRegistry(), {});
  });
});

test("readRegistry: parses valid registry", async () => {
  await withTempState(() => {
    const reg = { alpha: { session_id: "s1", model: "m", cwd: "/", started_ts: 1, last_seen_ts: 2 } };
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify(reg));
    const got = readRegistry();
    assert.equal(Object.keys(got).length, 1);
    assert.equal(got.alpha.session_id, "s1");
  });
});

test("SWARMEQ_STATE_DIR env override is honored by all path helpers", async () => {
  await withTempState((dir) => {
    assert.equal(stateDir(), dir);
    assert.equal(path.dirname(PROBE_LOG_FILE()), dir);
    assert.equal(path.dirname(PORT_FILE()), dir);
    assert.equal(path.dirname(PID_FILE()), dir);
    assert.equal(path.dirname(REGISTRY_FILE()), dir);
  });
});

test("stateDir falls back to default when env var is unset", async () => {
  // Don't actually mutate the real state dir — just confirm the helper
  // returns SOMETHING when SWARMEQ_STATE_DIR is absent and the default
  // path includes ~/.claude.
  const prev = process.env.SWARMEQ_STATE_DIR;
  delete process.env.SWARMEQ_STATE_DIR;
  try {
    const d = stateDir();
    assert.match(d, /\.claude\/plugins\/swarmeq\/state$/);
  } finally {
    if (prev !== undefined) process.env.SWARMEQ_STATE_DIR = prev;
  }
});
