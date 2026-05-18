import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTempState, withHttpServer, httpRequest, awaitSse } from "./_helpers.mjs";
import { handle } from "../src/http.ts";
import { REGISTRY_FILE, AGENT_FILE } from "../src/paths.ts";

const validReport = (agent = "alpha") => ({
  agent,
  feelings: [{ label: "joyful", intensity: 0.5 }],
  note: "ok",
});

test("GET /healthz returns identity envelope", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/healthz`);
      assert.equal(res.status, 200);
      const obj = JSON.parse(res.body);
      assert.equal(obj.service, "swarmeq");
      assert.ok(obj.pid > 0);
      assert.ok(typeof obj.version === "string");
      assert.ok(typeof obj.root === "string");
    });
  });
});

test("GET /state returns {agents, registry, sentiment, ts}", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/state`);
      assert.equal(res.status, 200);
      const obj = JSON.parse(res.body);
      assert.deepEqual(Object.keys(obj).sort(), ["agents", "registry", "sentiment", "ts"]);
    });
  });
});

test("POST /ingest accepts a valid report and writes AGENT_FILE", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/ingest`, {
        method: "POST", body: JSON.stringify(validReport("from-ingest")),
      });
      assert.equal(res.status, 204);
      const r = JSON.parse(fs.readFileSync(AGENT_FILE("from-ingest"), "utf8"));
      assert.equal(r.agent, "from-ingest");
    });
  });
});

test("POST /ingest 400s an invalid report with EVALIDATE message", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/ingest`, {
        method: "POST", body: JSON.stringify({ agent: "", feelings: [] }),
      });
      assert.equal(res.status, 400);
      assert.match(res.body, /invalid report/);
    });
  });
});

test("POST /ingest 413s oversize bodies", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const big = JSON.stringify({ agent: "a", feelings: [], note: "x".repeat(70 * 1024) });
      const res = await httpRequest(`${url}/ingest`, { method: "POST", body: big });
      assert.equal(res.status, 413);
    });
  });
});

test("POST /probe-event 204s and broadcasts to /events", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      // Start the SSE subscriber, then fire the event.
      const wait = awaitSse(`${url}/events`, "probe-failed", 2000);
      // tiny delay so the subscriber registers before we POST
      await new Promise((r) => setTimeout(r, 50));
      const res = await httpRequest(`${url}/probe-event`, {
        method: "POST",
        body: JSON.stringify({ type: "probe-failed", data: { agent: "x", reason: "test" } }),
      });
      assert.equal(res.status, 204);
      const ev = await wait;
      assert.ok(ev, "expected probe-failed event on SSE");
      assert.equal(ev.agent, "x");
      assert.equal(ev.reason, "test");
    });
  });
});

test("POST /probe-event 400s an unknown event type", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/probe-event`, {
        method: "POST",
        body: JSON.stringify({ type: "report", data: {} }), // report not in allowlist
      });
      assert.equal(res.status, 400);
    });
  });
});

test("POST /probe-event 413s oversize body", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const big = JSON.stringify({ type: "probe-exit", data: { x: "x".repeat(9000) } });
      const res = await httpRequest(`${url}/probe-event`, { method: "POST", body: big });
      assert.equal(res.status, 413);
    });
  });
});

test("/state.agents excludes orphaned reports without a registry entry", async () => {
  await withTempState(async () => {
    fs.writeFileSync(REGISTRY_FILE(), JSON.stringify({
      alive: { session_id: "s1", model: "m", cwd: "/", started_ts: 1, last_seen_ts: 2 },
    }));
    fs.writeFileSync(AGENT_FILE("alive"), JSON.stringify({
      agent: "alive", feelings: [{ label: "happy", intensity: 1 }], note: "", ts: 1,
    }));
    fs.writeFileSync(AGENT_FILE("orphan"), JSON.stringify({
      agent: "orphan", feelings: [{ label: "happy", intensity: 1 }], note: "", ts: 1,
    }));
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/state`);
      const obj = JSON.parse(res.body);
      assert.deepEqual(Object.keys(obj.agents), ["alive"]);
      assert.deepEqual(Object.keys(obj.registry), ["alive"]);
    });
  });
});

test("unknown route returns 404", async () => {
  await withTempState(async () => {
    await withHttpServer(handle, async ({ url }) => {
      const res = await httpRequest(`${url}/no-such-path`);
      assert.equal(res.status, 404);
    });
  });
});
