# Contributing to swarmeq

Welcome! swarmeq is a small Claude Code plugin written in TypeScript with a minimal toolchain — esbuild for bundling, `tsc` for type-checking. No framework, no transpiler step you have to learn, no app server. If you can read a Node script, you can change anything in here.

## The three layers

swarmeq has three places where code lives, and you edit each differently:

| Layer | Source | Output (committed) |
| --- | --- | --- |
| **Server** | `tools/src/*.ts` | `server/swarmeq.mjs` (one bundle) |
| **Hooks** | `tools/src/hooks/*.ts` | `hooks/*.mjs` (one bundle per hook, self-contained) |
| **Dashboard** | `dashboard/dashboard.html` | (same file — single static HTML with inline JS/CSS/SVG) |

The server and the four hooks are bundled with esbuild — **never edit the `.mjs` artifacts by hand.** The dashboard is edited directly.

## The build loop

One-time setup:

```bash
cd tools && npm install
```

After editing anything under `tools/src/`, rebuild:

```bash
node tools/build.mjs
```

That produces a fresh `server/swarmeq.mjs` (~600 KB, MCP SDK inlined) and four self-contained `hooks/*.mjs` bundles. Commit the rebuilt artifacts along with your source changes — end users install the plugin pre-bundled.

Type-check (optional but recommended before pushing):

```bash
cd tools && npm run typecheck
```

This runs `tsc --noEmit` in strict mode. The build itself doesn't gate on type errors — esbuild ignores them — so the typecheck script is your safety net.

Run the test suite:

```bash
cd tools && npm test
```

Uses Node's built-in `node:test` runner — no extra dependencies. Tests import the `.ts` source directly via native type-stripping, so they require **Node 22+**. Each test file isolates state via `SWARMEQ_STATE_DIR` (a tmp dir per test) so runs never touch your real `~/.claude/plugins/swarmeq/state`. Helpers live in `tools/test/_helpers.mjs`.

## Testing locally

Install the plugin from a local checkout:

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --plugin-dir /path/to/swarmeq
```

Inside the session:

- `/swarmeq-dashboard` — open the dashboard in your browser.
- `/swarmeq-doctor` — print the ✓/✗ prerequisites table.
- `/swarmeq-stop` — stop the daemon. Useful between iterations: stop it, rebuild, start a new session, and you'll pick up your server changes.

For hook or dashboard changes, you don't need to stop the daemon — start a new Claude Code session and the new code takes effect.

## Review loop

After non-trivial changes, run `/simplify` before committing. It launches three parallel review agents (reuse, quality, efficiency), aggregates findings, and applies safe simplifications. TypeScript often surfaces redundant abstractions or dead branches that survived from the JS era — `/simplify` catches them.

## Conventions worth knowing

A few non-obvious design rules baked into the code. Following them keeps the system simple:

- **Hooks are standalone.** Each hook's `.ts` source has zero imports from `tools/src/` (only `node:*` builtins). If a shared module broke at import time, every hook would silently fail and Claude Code would keep running fine — the worst kind of bug. The 10-ish lines of `portReachable` and the `RegistryEntry` interface duplicated across `tools/src/hooks/*.ts` are intentional. The bundled `hooks/*.mjs` artifacts contain only what the hook itself references — no shared swarmeq runtime.
- **Only the daemon binds the HTTP port.** MCP children call `discoverDashboard()`, never `bindDashboardPort()`. This prevents N silent dashboards (one per Claude Code session) that nobody is watching.
- **Only the daemon writes `sentiment.jsonl`.** MCP children forward to the daemon's `/ingest`. Otherwise concurrent appends would race.
- **`SWARMEQ_PROBE=1` is sacred.** All hooks check it and exit early. Without that guard, every probe fork would spawn another probe fork on its own Stop hook, and Claude API spend would skyrocket.
- **`/healthz` is the only adoption check.** Anywhere that trusts a recorded `.port`, it must go through `readActivePort()` (or, in standalone hooks, an inline probe of the same shape). The probe checks the JSON marker `{"service":"swarmeq"}` *and* the daemon's `version`. Identity is keyed on version, not pluginRoot — Claude Code unpacks each session's plugins into a private `/tmp/claude-plugin-session-<hash>/` directory, so a team with N subagents has N distinct `CLAUDE_PLUGIN_ROOT` paths all pointing at the same install. Comparing roots used to trigger a daemon-thrash loop (every subagent treating the daemon as foreign and SIGTERM'ing it); version comparison fixes that while still evicting genuine cross-version stragglers. A daemon whose `version` doesn't match (or that predates the identity envelope) is SIGTERM'd and its `.port`/`.pid` cleared — that's how plugin upgrades stay seamless. Never trust raw TCP reachability: a foreign service could have grabbed the port, and a same-port daemon left behind by an older install would serve from a deleted temp dir.

## Commit style

Small, focused commits. First line is a summary (under 70 characters); details go in the body. Match the style of recent commits — see `git log --oneline -10` for examples.

Don't commit `swarmeq-plan.md` — it's gitignored and used for scratch planning.

## Where to learn more

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — runtime architecture: the four kinds of process, end-to-end data flow, what lives on disk, how resilience works.
- The source itself. `tools/src/swarmeq.ts` is the CLI entry point; follow the imports from there.
