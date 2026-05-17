# Contributing to swarmeq

Welcome! swarmeq is a small Claude Code plugin written in plain Node.js — there's no framework, no transpiler, and no app server. If you can read a Node script, you can change anything in here.

## The three layers

swarmeq has three places where code lives, and you edit each differently:

| Layer | Where | How you change it |
| --- | --- | --- |
| **Hooks** | `hooks/*.mjs` | Edit directly. Plain standalone Node scripts that Claude Code runs on lifecycle events (SessionStart, Stop, SessionEnd, SubagentStop). |
| **Server** | `server/swarmeq.mjs` | **Don't edit this file by hand.** It's a bundled artifact. Source lives in `tools/src/*.mjs`; edit there and rebuild. |
| **Dashboard** | `dashboard/dashboard.html` | Edit directly. Single static HTML file with inline JS, CSS, and SVG. |

## The build loop

The server is bundled with esbuild. One-time setup:

```bash
cd tools && npm install
```

After editing anything under `tools/src/`, rebuild:

```bash
node tools/build.mjs
```

That produces a fresh `server/swarmeq.mjs` (~600 KB, MCP SDK inlined). Commit the rebuilt bundle along with your source changes — end users install the plugin pre-bundled.

The hooks and the dashboard are not bundled. Edits to those files take effect immediately.

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

## Conventions worth knowing

A few non-obvious design rules baked into the code. Following them keeps the system simple:

- **Hooks are standalone.** They don't import from `tools/src/`. If a shared module broke at import time, every hook would silently fail and Claude Code would keep running fine — the worst kind of bug. The 10-ish lines of `portReachable` duplicated between `hooks/session-start.mjs` and `hooks/stop.mjs` is intentional.
- **Only the daemon binds the HTTP port.** MCP children call `discoverDashboard()`, never `bindDashboardPort()`. This prevents N silent dashboards (one per Claude Code session) that nobody is watching.
- **Only the daemon writes `sentiment.jsonl`.** MCP children forward to the daemon's `/ingest`. Otherwise concurrent appends would race.
- **`SWARMEQ_PROBE=1` is sacred.** All hooks check it and exit early. Without that guard, every probe fork would spawn another probe fork on its own Stop hook, and Claude API spend would skyrocket.

## Commit style

Small, focused commits. First line is a summary (under 70 characters); details go in the body. Match the style of recent commits — see `git log --oneline -10` for examples.

Don't commit `swarmeq-plan.md` — it's gitignored and used for scratch planning.

## Where to learn more

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — runtime architecture: the four kinds of process, end-to-end data flow, what lives on disk, how resilience works.
- The source itself. `tools/src/swarmeq.mjs` is the CLI entry point; follow the imports from there.
