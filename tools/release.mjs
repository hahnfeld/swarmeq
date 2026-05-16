#!/usr/bin/env node
// tools/release.mjs — produce a runtime-only zip for `claude --plugin-url`.
//
// Includes only the files a user needs to run the plugin:
//   .claude-plugin/plugin.json
//   commands/                    (slash command defs)
//   hooks/                       (lifecycle hooks)
//   dashboard/                   (static UI + feelings.json)
//   server/swarmeq.mjs           (pre-bundled MCP + HTTP server)
//   LICENSE                      (MIT)
//
// Excludes:  tools/, README, CHANGELOG, marketplace.json, .gitignore, dev scratch.
// Output:    swarmeq-v<version>.zip at the repo root.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_JSON = path.join(ROOT, ".claude-plugin", "plugin.json");
const VERSION = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8")).version;
const OUT = path.join(ROOT, `swarmeq-v${VERSION}.zip`);

// Rebuild the bundle to make sure server/swarmeq.mjs is current.
console.log("→ rebuilding bundle…");
const b = spawnSync("node", [path.join(__dirname, "build.mjs")], { stdio: "inherit" });
if (b.status !== 0) { console.error("bundle failed"); process.exit(1); }

// Sanity: confirm the bundled artifact exists and is non-empty.
const bundle = path.join(ROOT, "server", "swarmeq.mjs");
if (!fs.existsSync(bundle) || fs.statSync(bundle).size < 100000) {
  console.error("server/swarmeq.mjs missing or suspiciously small"); process.exit(1);
}

// Fresh output.
try { fs.unlinkSync(OUT); } catch {}

const INCLUDE = [
  ".claude-plugin/plugin.json",
  "commands",
  "hooks",
  "dashboard",
  "server/swarmeq.mjs",
  "LICENSE",
];

console.log(`→ zipping → ${path.relative(ROOT, OUT)}`);
const z = spawnSync("zip",
  ["-r", "-X", "-q", OUT, ...INCLUDE],
  { cwd: ROOT, stdio: "inherit" });
if (z.status !== 0) { console.error("zip failed"); process.exit(1); }

const size = fs.statSync(OUT).size;
console.log(`✓ ${path.basename(OUT)}  ${(size/1024).toFixed(1)} KB`);
console.log(`  install: claude --plugin-url https://github.com/hahnfeld/swarmeq/releases/download/v${VERSION}/swarmeq-v${VERSION}.zip`);
