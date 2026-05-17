import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Path + presence check for the user-scope `mcpServers.swarmeq` entry that
// Claude Code Agent Teams teammates load from. Kept in its own module so it
// can be consumed by both swarmeq.ts (the CLI install command) and http.ts
// (the /state snapshot that drives the dashboard's "install needed" banner)
// without forming a circular import through swarmeq.ts ↔ http.ts.

export function userSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// Lenient: any entry under mcpServers.swarmeq counts as installed. Lets a
// user hand-edit the file (e.g. swap to an absolute path during dev) without
// the banner falsely reappearing. We only flag the genuinely-missing case.
export function installNeeded(): boolean {
  const file = userSettingsPath();
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return true; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return true; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const mcp = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return true;
  return !(mcp as Record<string, unknown>).swarmeq;
}

// Canonical mcpServers.swarmeq entry written by the CLI install command and
// the SessionStart auto-install hook. `${CLAUDE_PLUGIN_ROOT}` is expanded by
// Claude Code's plugin loader the same way it is in plugin.json.
export function canonicalMcpEntry(): { command: string; args: string[] } {
  return {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs", "mcp"],
  };
}
