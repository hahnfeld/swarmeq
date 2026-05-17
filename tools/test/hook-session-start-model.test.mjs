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
    env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: "" }, // suppress daemon spawn
  });
}

test("session-start hook: stores unmangled model for 1M-context Opus", async () => {
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({
      session_id: "abc-123",
      model: "claude-opus-4-7[1m]",
    }));
    assert.equal(result.status, 0, `hook exited with ${result.status}: ${result.stderr}`);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    const entries = Object.values(reg);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "claude-opus-4-7",
      `expected unmangled model, got ${entries[0].model}`);
  });
});

test("session-start hook: self-heals an existing mangled registry entry", async () => {
  await withTempState((dir) => {
    // Seed registry as if an old 0.3.3 hook had written the mangled form.
    const agent = "abc12345";
    const reg = {
      [agent]: {
        session_id: "abc-123",
        model: "claude-opus-4-7_1m_",
        cwd: "/tmp",
        started_ts: 1,
        last_seen_ts: 1,
      },
    };
    fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(reg));
    // The session-start hook unconditionally rewrites the entry; passing the
    // bracket form should leave the registry with the unmangled value.
    const result = runHook(JSON.stringify({
      session_id: "abc-123",
      agent_name: agent,
      model: "claude-opus-4-7[1m]",
    }));
    assert.equal(result.status, 0, `hook exited with ${result.status}: ${result.stderr}`);
    const after = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    assert.equal(after[agent].model, "claude-opus-4-7");
  });
});

test("session-start hook: handles plain model id unchanged", async () => {
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({
      session_id: "xyz",
      model: "claude-sonnet-4-6",
    }));
    assert.equal(result.status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    const entries = Object.values(reg);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "claude-sonnet-4-6");
  });
});

test("session-start hook: stores 'unknown' when model is missing", async () => {
  await withTempState((dir) => {
    const result = runHook(JSON.stringify({ session_id: "no-model" }), { ANTHROPIC_MODEL: "" });
    assert.equal(result.status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8"));
    const entries = Object.values(reg);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "unknown");
  });
});
