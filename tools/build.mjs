#!/usr/bin/env node
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "src");
const HOOKS_SRC = path.join(SRC_DIR, "hooks");
const HOOKS_OUT = path.join(__dirname, "..", "hooks");
const SERVER_OUT = path.join(__dirname, "..", "server", "swarmeq.mjs");

const banner = `#!/usr/bin/env node
// swarmeq — bundled artifact. DO NOT EDIT BY HAND.
// Source: tools/src/*.ts. Rebuild: \`node tools/build.mjs\`.
`;

// Server bundle.
await esbuild.build({
  entryPoints: [path.join(SRC_DIR, "swarmeq.ts")],
  outfile: SERVER_OUT,
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
try { fs.chmodSync(SERVER_OUT, 0o755); } catch {}
console.log(`built ${path.relative(process.cwd(), SERVER_OUT)}`);

// Hook bundles — one self-contained .mjs per hook, so the standalone-hook
// resilience invariant survives the move under tools/src/. Each hook stays
// import-free at runtime even though it can pull in TS helpers at compile time.
const hookFiles = fs.readdirSync(HOOKS_SRC).filter((f) => f.endsWith(".ts"));
await Promise.all(hookFiles.map(async (file) => {
  const name = file.replace(/\.ts$/, "");
  const outFile = path.join(HOOKS_OUT, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(HOOKS_SRC, file)],
    outfile: outFile,
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
  try { fs.chmodSync(outFile, 0o755); } catch {}
  console.log(`built ${path.relative(process.cwd(), outFile)}`);
}));
