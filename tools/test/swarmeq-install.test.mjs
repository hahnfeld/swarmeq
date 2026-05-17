import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withTempHome, freshImport } from "./_helpers.mjs";

// End-to-end driver: cmdInstall reads/writes $HOME/.claude/settings.json.
// withTempHome flips HOME to a fresh tmpdir, so the real user settings
// are never touched.
async function runInstall() {
  const mod = await freshImport("../src/swarmeq.ts");
  return mod._internals.cmdInstall();
}

function settingsPath(home) {
  return path.join(home, ".claude", "settings.json");
}

function readSettings(home) {
  return JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
}

function canonicalEntry() {
  return {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs", "mcp"],
  };
}

test("cmdInstall: creates settings.json when missing", async () => {
  await withTempHome(async (home) => {
    assert.equal(fs.existsSync(settingsPath(home)), false);
    await runInstall();
    assert.equal(fs.existsSync(settingsPath(home)), true);
    const settings = readSettings(home);
    assert.deepEqual(settings.mcpServers.swarmeq, canonicalEntry());
  });
});

test("cmdInstall: preserves existing mcpServers entries and writes a backup", async () => {
  await withTempHome(async (home) => {
    // Pre-seed settings.json with another MCP server + an unrelated top-level
    // key the user may have set. Both must survive the install.
    const prior = {
      mcpServers: { other: { command: "echo", args: ["hi"] } },
      env: { KEEP: "this" },
    };
    fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
    fs.writeFileSync(settingsPath(home), JSON.stringify(prior, null, 2));
    await runInstall();
    const after = readSettings(home);
    assert.deepEqual(after.mcpServers.swarmeq, canonicalEntry(),
      "swarmeq entry should be added");
    assert.deepEqual(after.mcpServers.other, prior.mcpServers.other,
      "existing mcpServers entry must be preserved");
    assert.deepEqual(after.env, prior.env,
      "other top-level keys must be preserved");
    // Backup of the pre-existing file.
    const backups = fs.readdirSync(path.dirname(settingsPath(home)))
      .filter((f) => f.startsWith("settings.json.bak."));
    assert.equal(backups.length, 1, "expected exactly one backup file");
  });
});

test("cmdInstall: is idempotent — re-running prints 'already installed' and writes no backup", async () => {
  await withTempHome(async (home) => {
    await runInstall(); // first run creates the file
    const dir = path.dirname(settingsPath(home));
    const backupsBefore = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.bak."));
    const mtimeBefore = fs.statSync(settingsPath(home)).mtimeMs;
    // Spacing so an mtime-based change would be visible if it happened.
    await new Promise((r) => setTimeout(r, 20));
    await runInstall(); // should be a no-op
    const backupsAfter = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.bak."));
    const mtimeAfter = fs.statSync(settingsPath(home)).mtimeMs;
    assert.equal(backupsAfter.length, backupsBefore.length,
      "idempotent re-run must not create a new backup");
    assert.equal(mtimeAfter, mtimeBefore,
      "idempotent re-run must not rewrite the file");
  });
});

test("cmdInstall: refuses to overwrite malformed settings.json", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
    fs.writeFileSync(settingsPath(home), "{ not valid json");
    // cmdInstall calls process.exit(1) on parse error. Hijack process.exit
    // so the test sees the failure without killing the runner.
    const origExit = process.exit;
    let exitCode = null;
    process.exit = ((code) => { exitCode = code; throw new Error("exit-trapped"); });
    try {
      try { await runInstall(); }
      catch (err) {
        if ((err && err.message) !== "exit-trapped") throw err;
      }
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCode, 1, "expected non-zero exit on malformed settings");
    // File must be unchanged — no clobber.
    assert.equal(fs.readFileSync(settingsPath(home), "utf8"), "{ not valid json");
    // No backup written either (we only back up before a real write).
    const backups = fs.readdirSync(path.dirname(settingsPath(home)))
      .filter((f) => f.startsWith("settings.json.bak."));
    assert.equal(backups.length, 0);
  });
});
