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
  // Display metadata (0.6.0+). Populated by the SessionStart hook from the
  // parent claude process's argv (--agent-name / --team-name / --agent-type /
  // --parent-session-id). Optional: leads only set display_name; teammates
  // set all four. The dashboard prefers display_name over the registry key
  // when rendering tile/tab labels.
  display_name?: string;
  agent_type?: string;
  team_name?: string;
  parent_session_id?: string;
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

// Used as an identity signal in /healthz so a new plugin process can detect a
// daemon left behind by an earlier install. Cached because plugin.json never
// changes within a single process lifetime.
let _version: string | null = null;
export function pluginVersion(): string {
  if (_version !== null) return _version;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8"));
    _version = String(pkg.version || "");
  } catch { _version = ""; }
  return _version;
}

export function stateDir(): string {
  // SWARMEQ_STATE_DIR opt-out exists so the test suite can isolate writes
  // to a tmp dir without touching the user's real plugin state.
  const dir = process.env.SWARMEQ_STATE_DIR
    || path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const PORT_FILE = (): string => path.join(stateDir(), ".port");
export const PID_FILE = (): string => path.join(stateDir(), ".pid");
export const REGISTRY_FILE = (): string => path.join(stateDir(), "registry.json");
export const AGENT_FILE = (agent: string): string => path.join(stateDir(), `${sanitizeAgent(agent)}.json`);
export const SENTIMENT_FILE = (): string => path.join(stateDir(), "sentiment.jsonl");
export const PROBE_LOG_FILE = (): string => path.join(stateDir(), "probe.log");

export function sanitizeAgent(s: unknown): string {
  return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
}

// Model ids must be passed verbatim to `claude --model`. The 1M-context
// Opus variant arrives as `claude-opus-4-7[1m]`; sanitizeAgent() would
// mangle the brackets into `_1m_` and the CLI would 404 on the result.
// Strip a trailing `[...]` suffix instead, then keep only chars valid in
// a model id. The bracket suffix is a context-window hint — dropping it
// leaves the model id the CLI accepts (`claude-opus-4-7`).
export function cleanModel(s: unknown): string {
  const raw = String(s || "").trim().replace(/\[[^\]]*\]$/, "");
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return cleaned || "unknown";
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
export function iweFile(): string {
  return path.join(pluginRoot(), "dashboard", "iwe.json");
}
