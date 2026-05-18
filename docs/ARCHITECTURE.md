# Architecture

A friendly tour of how swarmeq works at runtime. If you just want to use the plugin, you don't need this — start at the [README](../README.md). Read on if you want the under-the-hood picture, or if you're about to change something.

## The pieces

Four kinds of process run at the same time when swarmeq is active:

- **Daemon** — a long-lived background Node process. It owns the dashboard's HTTP port and broadcasts updates to your browser. There's exactly one of these per machine.
- **MCP child** — one of these per Claude Code session. Claude Code starts it automatically as the plugin's MCP server. It listens for the `report` tool call and forwards reports to the daemon.
- **Probe fork** — a short-lived clone of a teammate's session, spawned after each turn. It runs a tiny prompt, calls the `report` tool exactly once, and exits.
- **Browser** — your dashboard. It connects to the daemon and renders updates live.

The browser only reads. The daemon and MCP child both write to the same state directory on disk. Probe forks don't touch disk directly — they just call the MCP tool.

## One turn, end to end

Here's what happens after a teammate finishes a turn:

1. **Stop hook fires.** Claude Code runs `hooks/stop.mjs`.
2. **Throttle check.** The hook reads `registry.json`, looks up this teammate's `last_probe_ts`, and asks: has it been at least 90 seconds since the last probe? If no, the hook exits — we keep the dashboard "warm" but don't over-probe. If yes, it spawns a probe fork.
3. **Probe runs.** The fork is a `claude --resume <session_id> --fork-session --no-session-persistence` invocation that clones the teammate's session ephemerally. A short prompt asks it to call `mcp__swarmeq__report` once with its current state.
4. **Report lands.** The MCP child of the *forked* session receives the tool call, writes `<agent>.json` to disk, and forwards a copy to the daemon's `/ingest` endpoint.
5. **Browser updates.** The daemon broadcasts a Server-Sent Event. The dashboard updates the per-agent tab, the team wheel, and the sentiment chart — all within a second.

A `SWARMEQ_PROBE=1` env var on the fork makes its own SessionStart/Stop/SessionEnd hooks short-circuit, so probes never probe themselves.

## State on disk

Everything swarmeq remembers lives in `~/.claude/plugins/swarmeq/state/`:

- **`.port`** — which TCP port the daemon is on (e.g. `7777`).
- **`.pid`** — the daemon's process ID. Used by the heartbeat (see below).
- **`registry.json`** — one entry per *living* teammate. Tracks `session_id`, `model`, `last_seen_ts`, and `last_probe_ts`.
- **`<agent>.json`** — most recent report for each teammate. One file per agent.
- **`sentiment.jsonl`** — append-only history of team-wide sentiment over time. Drives the chart.
- **`probe.log`** — JSONL trace of every probe's lifecycle: `probe-exit` for every run, `probe-failed` for non-zero exits, `probe-no-report` when a probe exits cleanly but never wrote a report. Rotates at 1 MB. Detached probe processes have no SSE clients, so this is the source of truth for "why didn't the dashboard update?"

The daemon is the only writer of `sentiment.jsonl`; MCP children forward to it via `/ingest`. Probe subprocesses also forward their lifecycle events to the daemon's `/probe-event` so live SSE clients see them — the JSONL log is the offline record.

## How we stay resilient

Four small mechanisms keep things working even when the world is messy:

- **Port walk.** The daemon tries 7777, then 7778, … up to 7790, until it finds one free. If you have another app already on 7777, swarmeq lands on 7778 and writes that to `.port`. Clients always read the recorded port.
- **Identity check.** Before trusting any recorded port, swarmeq hits `/healthz` and reads the marker `{"service":"swarmeq", "pid", "version", "root"}`. If some unrelated app grabbed the port, the check fails and swarmeq treats it as "no daemon" — never adopts a foreign service or sends it your data.
- **Seamless upgrades.** That same identity check also catches daemons left behind by an earlier plugin install: when the running daemon's `version` doesn't match this install's `plugin.json` version (or is missing, as in pre-0.3.3 builds), the probing process SIGTERMs the daemon, clears `.port`/`.pid`, and lets the next caller bind a fresh one. The user's open dashboard tab reconnects via SSE — no duplicate window. Plugin upgrades work end-to-end without any manual `swarmeq stop`. Identity is keyed on `version`, not `root`: Claude Code unpacks each session's plugins into a private `/tmp/claude-plugin-session-<hash>/` directory, so a team with N subagents has N distinct `CLAUDE_PLUGIN_ROOT` paths all pointing at the same install — root-based comparison (used through 0.3.5) made every subagent treat the daemon as foreign and SIGTERM it, producing a thrash loop that froze the dashboard.
- **Heartbeat.** If two daemons race to start simultaneously (rare but possible), each runs a 5-second `setInterval` that reads `.pid`. Whichever wrote `.pid` last is the canonical owner; the loser notices the mismatch and SIGTERMs itself. Yields without zombies, never deletes the winner's files.

## Why we don't probe via an MCP tool call any more

Through 0.4.x the probe asked the forked session to call `mcp__swarmeq__report`. That worked for lead sessions but failed for Agent Teams teammates because Claude Code rebuilds every teammate-session fork's tool catalog from the `tools:` list in its agent-type definition (e.g. the frontmatter of `.claude/agents/qa.md`). The fork passed `--mcp-config <inline> --strict-mcp-config --allowed-tools mcp__swarmeq__report`, and Claude Code spawned the inline MCP server alongside the fork — but the model's catalog post-filter still excluded the tool, and the model responded in prose ("the report tool is not in my toolset"). The 0.4.0/0.4.1 attempt to fix this by writing `mcpServers.swarmeq` into user-scope `~/.claude/settings.json` made the MCP server *load* in teammate forks (verified via process tree) but didn't restore the *tool* to the model's catalog — same wall, one layer down.

0.5.0 changes the probe mechanism so the catalog filter is irrelevant. The fork no longer attempts a tool call. Instead the prompt instructs the model to emit one JSON object as its entire reply, schema-anchored and prose-suppressed:

```
[swarmeq introspection probe v2]
…provenance preamble…
Output exactly one JSON object on a single line. Begin with `{`, end with `}`.
No prose before or after, no markdown fences, no tool calls.

Schema: {"feelings":[{"label":…,"intensity":…},…],"note":"…"}
```

The probe parses the JSON out of `--output-format json`'s `result` field (tolerant of stray prose via a balanced-brace scan), injects `agent` from registry context (the model never sees or echoes it), validates via the existing `validateReport` schema, and writes via the same `record()` path that previously fielded MCP-tool calls. End-to-end the report still lands as `~/.claude/plugins/swarmeq/state/<agent>.json`. The MCP `report` tool is kept in `plugin.json` `mcpServers` as a public API surface — any session whose catalog includes it can still call it directly — but the probe no longer depends on it being callable.

`probe-report-written` (SSE + probe.log) is the new "success" signal alongside `probe-no-report` (the "model didn't emit parseable JSON" diagnostic). `modelResult` is still captured on failure for prompt-tuning.

The plugin's `plugin.json` `mcpServers` declaration is still kept — any session whose catalog already includes `mcp__swarmeq__report` (lead sessions, manually-authored slash commands) can still call it directly. The probe path doesn't depend on it.

## Identity and display names

Internally, registry entries are keyed on `sid.slice(0, 8)` — a stable, opaque 8-char slug derived from the session id. That's what `AGENT_FILE(<slug>) → state/<slug>.json` uses, and what the probe injects into the `agent` field of every report. The slug never changes for a given session.

For the dashboard, slugs are unreadable. So `SessionStart` also captures human-readable metadata by parsing the parent claude process's argv:

| argv flag | Captured as | Used for |
| --- | --- | --- |
| `--agent-name` | `agent_type` (also feeds `display_name`) | tile label, future filtering |
| `--team-name` | `team_name` (also feeds `display_name`) | tile label, future grouping |
| `--agent-type` | `agent_type` | (currently same as `--agent-name`) |
| `--parent-session-id` | `parent_session_id` | lineage from teammate back to lead |

Why argv and not the SessionStart event stdin: Claude Code's SessionStart event payload doesn't surface these fields, but they're right there on the parent process's command line. The hook reads its parent (`$PPID`) via `/proc/$PPID/cmdline` on Linux or `ps -wwp $PPID -o command=` on macOS/everywhere else, then a small token scan extracts the four fields. Failures (no permission, ps missing, parent already exited) are non-fatal — the hook falls back to a `lead@<cwd-basename>` display name and registers the entry anyway.

`display_name` is what the dashboard tiles and the active-portrait label render. Teammates show as `<agent-name>@<team-name>` (e.g. `qa@pocketweather-mood`); leads show as `lead@<cwd-basename>` (e.g. `lead@fun_team`) which mirrors the teammate shape and lets you tell parallel leads in different projects apart at a glance.

## Hooks at a glance

- **`SessionStart`** — register the teammate in `registry.json` and capture human-readable identity (`display_name`, `agent_type`, `team_name`, `parent_session_id`) by parsing the parent claude process's argv for `--agent-name` / `--team-name` / `--agent-type` / `--parent-session-id`. Lead sessions (no `--agent-id` on parent argv) fall back to `lead@<cwd-basename>`. Ensures the daemon is running. Never opens a browser — that's `/swarmeq-dashboard`'s job, since spawning N parallel teammates would otherwise open N browser tabs.
- **`Stop`** — auto-probe with the 90-second throttle; ensure the daemon is running.
- **`SessionEnd`** — remove the teammate from `registry.json`; delete its `<agent>.json`.
- **`SubagentStop`** — no-op. Task subagents aren't peer sessions; they can't be `--fork-session`-cloned the way peers can.

All four hooks check `SWARMEQ_PROBE=1` and exit early when set, so probe forks don't accidentally register themselves as new agents.

## What's deliberately not here

- **No auth.** The HTTP server binds 127.0.0.1 only; any local process running as your user could read or POST. That's fine for a single-user dev tool — those processes can read your home dir anyway.
- **No HTTPS.** Localhost-only; not needed.
- **No cross-machine support.** swarmeq is single-user, single-machine by design.
- **No concurrent-write locking.** The atomic tmp+rename pattern is enough; the throttle + heartbeat handle the only real concurrency points.
- **No Task-subagent probing.** Subagents aren't independently resumable sessions, so we can't fork-clone them. If you want subagent observability, give them `mcp__swarmeq__report` in their tool list and have them call it directly.

## Want to read the code?

The source lives in `tools/src/` as TypeScript. Start at `tools/src/swarmeq.ts` (the CLI dispatcher) and follow the imports. `tools/src/bind.ts` has the port/heartbeat logic, `tools/src/probe.ts` has the fork mechanics, and `tools/src/http.ts` has the routes. The four hook entry points are under `tools/src/hooks/*.ts`. esbuild bundles each into the committed `server/swarmeq.mjs` / `hooks/*.mjs` artifacts — see [CONTRIBUTING.md](../CONTRIBUTING.md) for the build loop.
