import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempState } from "./_helpers.mjs";
import { tryBind, probeSwarmeq, readActivePort, discoverDashboard, _internals } from "../src/bind.ts";
import { pluginVersion } from "../src/paths.ts";

test("tryBind: returns a Server on free port, null on collision", async () => {
  const a = await tryBind(0);
  assert.ok(a, "expected a Server instance on port 0");
  const port = a.address().port;
  const b = await tryBind(port);
  assert.equal(b, null, "second bind to same port should return null");
  await new Promise((res) => a.close(res));
});

test("probeSwarmeq: returns null for a non-listening port", async () => {
  // Pick a high port unlikely to be in use.
  const id = await probeSwarmeq(54321, 200);
  assert.equal(id, null);
});

test("readActivePort: returns null when .port file is missing", async () => {
  await withTempState(async () => {
    const p = await readActivePort();
    assert.equal(p, null);
  });
});

test("discoverDashboard: populates null state when no daemon present", async () => {
  await withTempState(async () => {
    const state = await discoverDashboard();
    assert.equal(state.bound, false);
    assert.equal(state.port, null);
    assert.equal(state.url, null);
  });
});

// Identity comparison: regression coverage for the v0.3.6 fix. Pre-0.3.6 the
// daemon was considered stale whenever id.root !== pluginRoot(), which broke
// every team-subagent scenario because Claude Code unpacks the plugin into a
// per-session /tmp dir. The check now compares version only.
test("isStaleIdentity: same version + different root → not stale (the regression)", () => {
  const local = pluginVersion();
  assert.ok(local, "plugin.json must expose a version for this test to be meaningful");
  // Both roots are plausible per-session tmp dirs; their being unequal must
  // no longer count against the daemon.
  const stale = _internals.isStaleIdentity({
    pid: 999,
    version: local,
    root: "/tmp/claude-plugin-session-deadbeef/inline-0-url-0-swarmeq-v0-3-6",
  });
  assert.equal(stale, false);
});

test("isStaleIdentity: version drift → stale (legit upgrade path stays live)", () => {
  const stale = _internals.isStaleIdentity({
    pid: 999,
    version: "0.0.0-not-ours",
    root: "/anywhere",
  });
  assert.equal(stale, true);
});

test("isStaleIdentity: empty version (pre-0.3.3 daemon) → stale", () => {
  const stale = _internals.isStaleIdentity({ pid: 999, version: "", root: "/anywhere" });
  assert.equal(stale, true);
});
