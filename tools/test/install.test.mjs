import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withTempHome, freshImport } from "./_helpers.mjs";

async function loadInstall() {
  return freshImport("../src/install.ts");
}

function settingsFile(home) {
  return path.join(home, ".claude", "settings.json");
}

test("installNeeded: true when ~/.claude/settings.json is missing", async () => {
  await withTempHome(async () => {
    const { installNeeded } = await loadInstall();
    assert.equal(installNeeded(), true);
  });
});

test("installNeeded: true when settings.json has no mcpServers block", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
    fs.writeFileSync(settingsFile(home), JSON.stringify({ env: { FOO: "bar" } }, null, 2));
    const { installNeeded } = await loadInstall();
    assert.equal(installNeeded(), true);
  });
});

test("installNeeded: true when mcpServers exists but lacks swarmeq", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
    fs.writeFileSync(settingsFile(home), JSON.stringify({
      mcpServers: { other: { command: "echo" } },
    }, null, 2));
    const { installNeeded } = await loadInstall();
    assert.equal(installNeeded(), true);
  });
});

test("installNeeded: false when mcpServers.swarmeq is present (any shape)", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
    // Lenient: any entry under mcpServers.swarmeq counts as installed, even
    // if the user has hand-edited the command path.
    fs.writeFileSync(settingsFile(home), JSON.stringify({
      mcpServers: { swarmeq: { command: "node", args: ["custom/path.mjs", "mcp"] } },
    }, null, 2));
    const { installNeeded } = await loadInstall();
    assert.equal(installNeeded(), false);
  });
});

test("installNeeded: true when settings.json is malformed JSON", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
    fs.writeFileSync(settingsFile(home), "{ not valid json");
    const { installNeeded } = await loadInstall();
    // Treat malformed as "needs install" so the banner appears and prompts
    // the user to fix it via /swarmeq-install (which will refuse and ask
    // them to repair the file by hand).
    assert.equal(installNeeded(), true);
  });
});

test("installNeeded: true when settings.json is a JSON array, not an object", async () => {
  await withTempHome(async (home) => {
    fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
    fs.writeFileSync(settingsFile(home), "[]");
    const { installNeeded } = await loadInstall();
    assert.equal(installNeeded(), true);
  });
});
