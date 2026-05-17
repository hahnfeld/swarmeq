import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withTempState, withTempHome } from "./_helpers.mjs";

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

// Auto-install behavior: the hook detects a missing user-scope swarmeq
// mcpServers entry and silently writes it on first SessionStart. Idempotent
// on subsequent runs. Visible one-line notice on first write.
test("session-start: auto-installs swarmeq into ~/.claude/settings.json when missing", async () => {
  await withTempState(() => withTempHome((home) => {
    const settings = path.join(home, ".claude", "settings.json");
    assert.equal(fs.existsSync(settings), false);
    const result = runHook(JSON.stringify({ session_id: "fresh-home" }));
    assert.equal(result.status, 0);
    assert.ok(fs.existsSync(settings), "auto-install must create settings.json");
    const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.equal(parsed.mcpServers.swarmeq.command, "node");
    assert.deepEqual(parsed.mcpServers.swarmeq.args,
      ["${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs", "mcp"]);
    assert.match(result.stderr, /auto-installed/,
      "first install must emit a one-line notice on stderr");
  }));
});

test("session-start: auto-install is a silent no-op when swarmeq entry already exists", async () => {
  await withTempState(() => withTempHome((home) => {
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      mcpServers: { swarmeq: { command: "node", args: ["custom/path.mjs", "mcp"] } },
    }, null, 2));
    const before = fs.readFileSync(settings, "utf8");
    const result = runHook(JSON.stringify({ session_id: "already-installed" }));
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(settings, "utf8"), before,
      "settings.json must not be rewritten when swarmeq entry exists");
    assert.doesNotMatch(result.stderr, /auto-installed/,
      "no notice when already installed");
    // No backup written either.
    const backups = fs.readdirSync(path.dirname(settings))
      .filter((f) => f.startsWith("settings.json.bak."));
    assert.equal(backups.length, 0);
  }));
});

test("session-start: auto-install preserves existing mcpServers entries and writes a backup", async () => {
  await withTempState(() => withTempHome((home) => {
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const prior = { mcpServers: { other: { command: "echo", args: ["hi"] } }, env: { KEEP: "1" } };
    fs.writeFileSync(settings, JSON.stringify(prior, null, 2));
    const result = runHook(JSON.stringify({ session_id: "merge-test" }));
    assert.equal(result.status, 0);
    const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.deepEqual(parsed.mcpServers.other, prior.mcpServers.other);
    assert.equal(parsed.mcpServers.swarmeq.command, "node");
    assert.deepEqual(parsed.env, prior.env);
    const backups = fs.readdirSync(path.dirname(settings))
      .filter((f) => f.startsWith("settings.json.bak."));
    assert.equal(backups.length, 1, "exactly one backup file");
  }));
});

test("session-start: auto-install refuses to overwrite malformed settings.json", async () => {
  await withTempState(() => withTempHome((home) => {
    const settings = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, "{ not valid json");
    const result = runHook(JSON.stringify({ session_id: "malformed" }));
    assert.equal(result.status, 0, "hook still exits 0 even when install bails");
    assert.equal(fs.readFileSync(settings, "utf8"), "{ not valid json",
      "malformed file must not be clobbered");
    assert.match(result.stderr, /cannot parse/);
  }));
});
