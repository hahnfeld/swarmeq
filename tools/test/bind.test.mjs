import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempState } from "./_helpers.mjs";
import { tryBind, probeSwarmeq, readActivePort, discoverDashboard } from "../src/bind.ts";

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
