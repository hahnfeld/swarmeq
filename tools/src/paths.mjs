import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Walk up from this file to find .claude-plugin/plugin.json (works in dev and in
// the bundled server/swarmeq.mjs layout). Plugin.json is the canonical marker —
// if a user removes the dashboard/ dir, the rest of the plugin should still load.
let _root = null;
export function pluginRoot() {
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

export function stateDir() {
  const dir = path.join(os.homedir(), ".claude", "plugins", "swarmeq", "state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const PORT_FILE = () => path.join(stateDir(), ".port");
export const PID_FILE = () => path.join(stateDir(), ".pid");
export const REGISTRY_FILE = () => path.join(stateDir(), "registry.json");
export const AGENT_FILE = (agent) => path.join(stateDir(), `${sanitizeAgent(agent)}.json`);
export const SENTIMENT_FILE = () => path.join(stateDir(), "sentiment.jsonl");

export function sanitizeAgent(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "_";
}

// Atomic write: tmp + rename. Avoids partial-read corruption when concurrent
// MCP processes write the same agent file or two hooks touch registry.json.
export function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function dashboardFile() {
  return path.join(pluginRoot(), "dashboard", "dashboard.html");
}
export function feelingsFile() {
  return path.join(pluginRoot(), "dashboard", "feelings.json");
}
