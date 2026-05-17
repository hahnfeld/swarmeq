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

The daemon is the only writer of `sentiment.jsonl`; MCP children forward to it.

## How we stay resilient

Three small mechanisms keep things working even when the world is messy:

- **Port walk.** The daemon tries 7777, then 7778, … up to 7790, until it finds one free. If you have another app already on 7777, swarmeq lands on 7778 and writes that to `.port`. Clients always read the recorded port.
- **Identity check.** Before trusting any recorded port, swarmeq hits `/healthz` and checks for the marker `{"service":"swarmeq"}`. If some unrelated app grabbed the port, the check fails and swarmeq treats it as "no daemon" — never adopts a foreign service or sends it your data.
- **Heartbeat.** If two daemons race to start simultaneously (rare but possible), each runs a 5-second `setInterval` that reads `.pid`. Whichever wrote `.pid` last is the canonical owner; the loser notices the mismatch and SIGTERMs itself. Yields without zombies, never deletes the winner's files.

## Hooks at a glance

- **`SessionStart`** — register the teammate in `registry.json`; ensure the daemon is running; on cold start (no daemon yet), open the browser.
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

The source lives in `tools/src/`. Start at `tools/src/swarmeq.mjs` (the CLI dispatcher) and follow the imports. `tools/src/bind.mjs` has the port/heartbeat logic, `tools/src/probe.mjs` has the fork mechanics, and `tools/src/http.mjs` has the routes. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the build loop.
