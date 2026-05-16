#!/usr/bin/env node
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, "src", "swarmeq.mjs");
const OUT = path.join(__dirname, "..", "server", "swarmeq.mjs");

const banner = `#!/usr/bin/env node
// swarmeq v0.1.0 — bundled artifact. DO NOT EDIT BY HAND.
// Source: tools/src/swarmeq.mjs and siblings. Rebuild: \`node tools/build.mjs\`.
`;

await esbuild.build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: banner },
  legalComments: "none",
  external: [],
  conditions: ["node", "default"],
  logLevel: "info",
});

// Preserve the executable bit so the shebang works for direct invocation.
// (Plugin always invokes via `node <path>`, but README documents both.)
try { fs.chmodSync(OUT, 0o755); } catch {}

console.log(`built ${path.relative(process.cwd(), OUT)}`);
