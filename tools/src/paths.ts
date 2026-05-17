import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Shape of one entry in registry.json. Maintained by the SessionStart hook,
// updated by Stop (last_seen_ts, last_probe_ts), and cleared by SessionEnd.
// The hooks duplicate this type inline to stay zero-import at runtime; only
// non-hook code should import it from here.
export interface RegistryEntry {
  session_id: string;
  model: string;
  cwd: string;
  started_ts: number;
  last_seen_ts: number;
  last_probe_ts?: number;
}
export type Registry = Record<string, RegistryEntry>;

// Walk up from this file to find .claude-plugin/plugin.json (works in dev and in
// the bundled server/swarmeq.mjs layout). Plugin.json is the canonical marker —
// if a user removes the dashboard/ dir, the rest of the plugin should still load.
let _root: string | null = null;
export function pluginRoot(): string {
  if (_root) return _root;
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
      _root = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate plugin root from ${import.meta.dirname}`);
}

export function stateDir(): string {
  const dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const PORT_FILE = (): string => path.join(stateDir(), ".port");
export const PID_FILE = (): string => path.join(stateDir(), ".pid");
export const REGISTRY_FILE = (): string => path.join(stateDir(), "registry.json");
export const AGENT_FILE = (agent: string): string => path.join(stateDir(), `${sanitizeAgent(agent)}.json`);
export const SENTIMENT_FILE = (): string => path.join(stateDir(), "sentiment.jsonl");

export function sanitizeAgent(s: unknown): string {
  return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
}

// Atomic write: tmp + rename. Avoids partial-read corruption when concurrent
// MCP processes write the same agent file or two hooks touch registry.json.
export function writeAtomic(file: string, body: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function readRegistry(): Registry {
  try {
    const obj = JSON.parse(fs.readFileSync(REGISTRY_FILE(), "utf8"));
    return (obj && typeof obj === "object") ? obj as Registry : {};
  } catch { return {}; }
}

export function dashboardFile(): string {
  return path.join(pluginRoot(), "dashboard", "dashboard.html");
}
export function feelingsFile(): string {
  return path.join(pluginRoot(), "dashboard", "feelings.json");
}
