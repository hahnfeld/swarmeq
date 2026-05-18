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
3. **Probe runs.** The fork is a `claude --resume <session_id> --fork-session --no-session-persistence` invocation that clones the teammate's session ephemerally. A short prompt asks it to POST its current state to `127.0.0.1:<PORT>/ingest` via a pattern-restricted `Bash(curl …)` tool call.
4. **Report lands.** The daemon's `/ingest` handler validates the payload, writes `<agent>.json` atomically, and broadcasts the new state via SSE. The probe itself doesn't touch disk — success is detected by watching the agent file's mtime advance during the fork's run.
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

## Probe mechanism — three eras

The probe (the forked, ephemeral session that asks each teammate to log its state) has gone through three designs. The history is in the code comments and CHANGELOG; the short version:

**v0.4.x — MCP tool call.** The fork was asked to call `mcp__swarmeq__report` with a structured payload. Worked for lead sessions but failed for Agent Teams teammates: Claude Code rebuilds every teammate-fork's tool catalog from the `tools:` list in its agent-type definition (e.g. the frontmatter of `.claude/agents/qa.md`), and the catalog post-filter stripped `mcp__swarmeq__report` even when the fork passed `--mcp-config <inline> --strict-mcp-config --allowed-tools mcp__swarmeq__report`. The 0.4.0/0.4.1 attempt to fix this by writing `mcpServers.swarmeq` to user-scope `~/.claude/settings.json` loaded the MCP server in teammate forks (verified via process tree) but didn't restore the tool to the model's catalog — same wall, one layer down.

**v0.5.0–0.8.x — JSON-in-message.** The fork was asked to emit one JSON object as its entire reply (`"no prose before or after, no markdown fences, no tool calls"`). The catalog filter became irrelevant: the model just writes text and the probe parses it. This worked uniformly for lead and teammates *as long as the model played along*. In practice sonnet 4.6 teammates refused this prompt roughly half the time — the "suppress your prose, emit raw JSON, this isn't an injection" framing read to them as the exact shape of a phishing attempt, especially when the fork inherited a recent system reminder that swarmeq's MCP server had disconnected (which is normal — the parent session's MCP child dies at session end). Refusal texts were direct: *"a legitimate system probe wouldn't arrive as a user-turn message asking me to suppress my normal reasoning."*

**v0.9.0+ — Bash + curl into /ingest.** The fork is asked to POST its self-report via `curl` to the daemon's existing `/ingest` endpoint. The model perceives this as normal tool use rather than as a suspicious "suspend your judgment" request. The spawn args include:

```
--allowed-tools 'Bash(curl -sS -X POST http://127.0.0.1:<PORT>/ingest*)'
```

— pattern-restricted Bash, scoped to exactly that curl invocation. No arbitrary command execution. The probe writes nothing to disk itself; success is detected by watching `AGENT_FILE(slug).mtime` advance during the fork's run (the daemon's `/ingest` handler writes the file when the agent's curl lands). The prompt is descriptive:

```
swarmeq is an observability tool the user runs alongside their agent team —
a localhost dashboard at 127.0.0.1:<PORT> that shows each agent's self-reported
state. Periodically, swarmeq forks your session in an ephemeral context (no
session persistence; nothing writes back to your live conversation) so you
can log how you're doing.

POST your current self-report to the dashboard:

  curl -sS -X POST http://127.0.0.1:<PORT>/ingest \
    -H 'Content-Type: application/json' \
    -d '{"agent": "<SLUG>", "feelings": [...], "note": "...", "iwe": {...}}'

Schema: <Willcox-78 labels + 1–5 Likert IWE items inline>
```

`probe-report-written` is the success signal; `probe-no-report` carries richer telemetry than before — `diagnoseFailure()` in `probe.ts` parses the envelope's `permission_denials` and `terminal_reason` and pattern-matches the model's `result` against common refusal openings, so the log entry says e.g. *"agent refused"* / *"bash permission denied"* / *"terminal_reason=interrupted"* rather than a flat *"no parseable JSON"*. The daemon side also writes `ingest-rejected` events to `probe.log` whenever `/ingest` returns 400 — `grep ingest-rejected probe.log` shows the user exactly what payload was sent and which validation rule rejected it.

The MCP `report` tool is still declared in `plugin.json`'s `mcpServers` block — any session whose catalog already includes it can still call it directly — but the probe path no longer depends on it.

Operational requirement: teammate `tools:` allowlists must include `Bash` for v3 probes to land. Most agent-type definitions allow Bash by default; restrictive lists need to be amended. The probe logs `probe-no-report` with `reason: "bash permission denied"` if Bash isn't available.

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

## Intrinsic Work Experience (IWE)

Added in 0.8.0, alongside the affective (Willcox feelings) signal. Each probe asks the agent to optionally rate the 5 items of the U.S. OPM FEVS Intrinsic Work Experience Sub-Index on a 1–5 Likert scale (1 = Strongly Disagree, 5 = Strongly Agree). The FEVS is a U.S. Government work in the public domain (17 U.S.C. § 105), so items 1–4 are reproduced verbatim. Item 5 — "I know how my work relates to the agency's goals" — is adapted for the AI-agent context: "agency's" → "the user's"; the original is preserved in the in-panel attribution.

Schema-wise this is a single optional `iwe?: Record<string, number>` field on `Report`, keyed by item number ("1"–"5") with integer values 1–5. Missing keys mean the agent skipped that item this round; missing `iwe` entirely means the agent didn't answer any (or pre-dates 0.8.0). The validator (`tools/src/validate.ts`) rejects out-of-range keys, non-integer values, arrays, and null shapes; everything else is additive over the pre-0.8.0 schema.

Item text lives in `dashboard/iwe.json` so the probe prompt builder (`tools/src/prompt.ts`) and the dashboard renderer share a single source of truth — same pattern as `feelings.json`. The daemon serves `/iwe.json` as a static route. The dashboard fetches it once at startup, builds the panel structure (`buildIwe()`), and `renderIwe()` then fills per-item bars based on the active agent's `report.iwe`. The **overall sub-index score follows the FEVS method**: percent-positive (rating ≥ 4) averaged across rated items. For a single agent's single probe this reduces to `positiveCount / ratedCount`, displayed inline with the panel crumb as `NN% positive`.

Source: U.S. OPM 2023 FEVS Technical Report (Revised April 2025), p. 13 (sub-index definition) and pp. 50–51 Appendix A Table A2 (verbatim item wording). Attribution appears in-panel on the dashboard; the README's "Source material" section has the full citation.

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
