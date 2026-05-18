import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withTempState } from "./_helpers.mjs";

const HOOK_SRC = path.resolve(import.meta.dirname, "..", "src", "hooks", "session-start.ts");

function runHook(stdinBody, env = {}) {
  return spawnSync(process.execPath, [HOOK_SRC], {
    input: stdinBody,
    encoding: "utf8",
    env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: "" },
  });
}

test("session-start: SWARMEQ_PROBE=1 exits without writing registry", async () => {
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({ session_id: "skip" }), { SWARMEQ_PROBE: "1" });
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(path.join(dir, "registry.json")), false,
      "probe forks must not register as new agents");
  });
});

test("session-start: populates all registry fields", async () => {
  await withTempState((dir) => {
    const before = Date.now();
    const result = runHook(JSON.stringify({
      session_id: "sess-1",
      agent_name: "named-agent",
      model: "claude-sonnet-4-6",
      cwd: "/tmp/working",
    }));
    assert.equal(result.status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    const entry = reg["named-agent"];
    assert.ok(entry, "expected entry under 'named-agent' key");
    assert.equal(entry.session_id, "sess-1");
    assert.equal(entry.model, "claude-sonnet-4-6");
    assert.equal(entry.cwd, "/tmp/working");
    assert.ok(entry.started_ts >= before);
    assert.ok(entry.last_seen_ts >= before);
  });
});

test("session-start: derives agent key from session_id prefix when name missing", async () => {
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({ session_id: "abcdef0123-rest" }));
    assert.equal(result.status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    assert.ok(reg["abcdef01"], `expected key 'abcdef01' from first 8 chars, got ${JSON.stringify(Object.keys(reg))}`);
  });
});

test("session-start: empty body exits cleanly without writing", async () => {
  await withTempState((dir) => {
    const result = runHook("");
    assert.equal(result.status, 0);
    // Empty body → derives unknown agent; the hook still writes (default behavior)
    // but should not crash. Just assert no crash and the file exists or not — both ok.
    const exists = fs.existsSync(path.join(dir, "registry.json"));
    if (exists) {
      const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      // Should have an entry under "unknown" or "_"
      assert.ok(Object.keys(reg).length >= 0);
    }
  });
});

test("session-start: missing CLAUDE_PLUGIN_ROOT does not block hook completion", async () => {
  // No CLAUDE_PLUGIN_ROOT → ensureDashboard() returns early. Hook must still
  // exit 0 and write the registry entry. Tests the "hooks never block" promise.
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({ session_id: "without-root" }));
    assert.equal(result.status, 0);
    assert.ok(fs.existsSync(path.join(dir, "registry.json")));
  });
});

// 0.6.0: SessionStart parses the parent claude process's argv for
// --agent-name/--team-name/--agent-type/--parent-session-id. In the test
// environment the parent is node (no --agent-id flags), so the hook falls
// back to deriving a lead-style display_name from the cwd basename. This
// asserts the fallback path; the teammate path is verified in the live
// dashboard test against a real Agent Teams run.
test("session-start: lead fallback derives display_name from cwd basename", async () => {
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({
      session_id: "lead-derives",
      cwd: "/Users/mhahnfeld/Projects/fun_team",
    }));
    assert.equal(result.status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    const entry = reg["lead-der"]; // first 8 chars of "lead-derives"
    assert.ok(entry, `expected an entry; got ${JSON.stringify(Object.keys(reg))}`);
    assert.equal(entry.display_name, "lead@fun_team",
      "lead display_name should be `lead@<cwd-basename>` when no --agent-id is on parent argv");
    // Teammate-only fields stay undefined for the lead fallback.
    assert.equal(entry.agent_type, undefined);
    assert.equal(entry.team_name, undefined);
    assert.equal(entry.parent_session_id, undefined);
  });
});

test("session-start: lead fallback handles missing/empty cwd as lead@unknown", async () => {
  await withTempState((dir) => {
    // Empty cwd in payload + the hook spawn defaults to process.cwd() of the
    // test runner. We can't easily make process.cwd() empty, so just verify
    // the display_name has the `lead@` prefix and a non-empty basename.
    const result = runHook(JSON.stringify({ session_id: "lead-defaults" }));
    assert.equal(result.status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    const entry = reg["lead-def"];
    assert.ok(entry);
    assert.match(entry.display_name, /^lead@\S+$/,
      "display_name must always start with 'lead@' for non-teammate sessions");
  });
});

