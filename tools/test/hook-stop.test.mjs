import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTempState } from "./_helpers.mjs";

const HOOK_SRC = path.resolve(import.meta.dirname, "..", "src", "hooks", "stop.ts");

// Stop hook bails immediately when CLAUDE_PLUGIN_ROOT/server/swarmeq.mjs is
// missing, so to exercise the registry-update path we plant a fake plugin
// root with a swarmeq.mjs that exits immediately. The hook's detached
// daemon/probe spawn against this script becomes a harmless quick exit.
function withFakePluginRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarmeq-fakeroot-"));
  fs.mkdirSync(path.join(root, "server"));
  fs.writeFileSync(path.join(root, "server", "swarmeq.mjs"),
    "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
  try { return fn(root); }
  finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
}

function runHook(stdinBody, pluginRoot, env = {}) {
  return spawnSync(process.execPath, [HOOK_SRC], {
    input: stdinBody,
    encoding: "utf8",
    env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: pluginRoot },
  });
}

function seedRegistry(dir, entries) {
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(entries, null, 2));
}

test("stop hook: SWARMEQ_PROBE=1 exits without updating the registry", async () => {
  await withTempState((dir) => {
    withFakePluginRoot((pluginRoot) => {
      seedRegistry(dir, {
        alpha: { session_id: "s", model: "m", cwd: "/", started_ts: 1, last_seen_ts: 2 },
      });
      const before = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      const result = runHook(JSON.stringify({ session_id: "s", agent_name: "alpha" }),
        pluginRoot, { SWARMEQ_PROBE: "1" });
      assert.equal(result.status, 0);
      const after = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      assert.deepEqual(after, before, "probe forks must not update registry");
    });
  });
});

test("stop hook: updates last_seen_ts on every invocation", async () => {
  await withTempState((dir) => {
    withFakePluginRoot((pluginRoot) => {
      seedRegistry(dir, {
        alpha: { session_id: "s", model: "m", cwd: "/", started_ts: 1, last_seen_ts: 100 },
      });
      const before = Date.now();
      const result = runHook(JSON.stringify({ session_id: "s", agent_name: "alpha" }), pluginRoot);
      assert.equal(result.status, 0);
      const after = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      assert.ok(after.alpha.last_seen_ts >= before,
        `expected last_seen_ts >= ${before}, got ${after.alpha.last_seen_ts}`);
    });
  });
});

test("stop hook: sets last_probe_ts on first stop (no prior probe)", async () => {
  await withTempState((dir) => {
    withFakePluginRoot((pluginRoot) => {
      seedRegistry(dir, {
        alpha: { session_id: "s", model: "m", cwd: "/", started_ts: 1, last_seen_ts: 1 },
      });
      const before = Date.now();
      const result = runHook(JSON.stringify({ session_id: "s", agent_name: "alpha" }), pluginRoot);
      assert.equal(result.status, 0);
      const after = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      assert.ok(after.alpha.last_probe_ts >= before,
        "first stop should advance last_probe_ts (no prior probe within cooldown)");
    });
  });
});

test("stop hook: respects PROBE_MIN_MS cooldown", async () => {
  await withTempState((dir) => {
    withFakePluginRoot((pluginRoot) => {
      const recent = Date.now() - 30_000; // 30s ago, well inside the 90s cooldown
      seedRegistry(dir, {
        alpha: {
          session_id: "s", model: "m", cwd: "/", started_ts: 1,
          last_seen_ts: 1, last_probe_ts: recent,
        },
      });
      const result = runHook(JSON.stringify({ session_id: "s", agent_name: "alpha" }), pluginRoot);
      assert.equal(result.status, 0);
      const after = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      assert.equal(after.alpha.last_probe_ts, recent,
        "stop within 90s of last probe must not advance last_probe_ts");
    });
  });
});

test("stop hook: missing registry entry exits cleanly without writing", async () => {
  await withTempState((dir) => {
    withFakePluginRoot((pluginRoot) => {
      seedRegistry(dir, {});
      const result = runHook(JSON.stringify({ session_id: "s", agent_name: "ghost" }), pluginRoot);
      assert.equal(result.status, 0);
      const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
      assert.deepEqual(reg, {});
    });
  });
});

test("stop hook: missing CLAUDE_PLUGIN_ROOT exits 0 immediately", async () => {
  // Without a plugin script, the hook has nothing to spawn — it should still
  // return non-error so Claude Code isn't blocked.
  await withTempState(() => {
    const result = runHook(JSON.stringify({ session_id: "s" }), "");
    assert.equal(result.status, 0);
  });
});
