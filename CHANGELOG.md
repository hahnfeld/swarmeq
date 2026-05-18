# swarmeq changelog

## 0.8.0 — FEVS Intrinsic Work Experience panel on the per-agent view

### Added
- **Intrinsic Work Experience (IWE) panel** below the existing feelings panel on the individual view. Asks each agent to rate the 5 items of the U.S. Office of Personnel Management's Federal Employee Viewpoint Survey (FEVS) Employee Engagement Index → Intrinsic Work Experience Sub-Index on a 1–5 Likert scale (1 = Strongly Disagree, 5 = Strongly Agree). The FEVS is a U.S. Government work in the public domain (17 U.S.C. § 105), so items 1–4 are reproduced verbatim from the OPM 2023 FEVS Technical Report (Revised April 2025), p. 13 and Appendix A Table A2 (pp. 50–51). Item 5 is adapted for the AI-agent context — "agency's" → "the user's" — with the original FEVS Q7 wording preserved in the in-panel attribution.
- **Per-item rendering** with continuous green bars (fill = rating / 5). Skipped items render dim with `—`. The 5 items cover: encouragement, sense of accomplishment, role clarity, talents used well, and work-to-goals alignment.
- **Overall score per FEVS method**: percent-positive (rating ≥ 4) averaged across rated items, displayed inline with the panel crumb (e.g., `60% positive`). For a single agent's single probe this reduces to `positiveCount / ratedCount * 100`. Hidden when no items are rated.
- **Schema extension on `Report`** (`tools/src/validate.ts`): optional `iwe?: { [itemNumber: string]: number }` field. Keys must parse to integers in [1, 5]; values must be integers in [1, 5]. Empty `{}` and absent `iwe` both valid. Reports from before 0.8.0 validate unchanged (backward-compatible).
- **Introspection prompt** (`tools/src/prompt.ts`) updated to include the 5 IWE items and instruct the model to emit `iwe` in its JSON reply alongside `feelings` and `note`.
- **Static route** `/iwe.json` served by the daemon so the dashboard fetches the canonical item set the same way it fetches `/feelings.json`.
- **Willcox attribution** under the wheel SVG. The Willcox 1982 feelings wheel had been visualized in-UI for years without an in-page citation; this release adds a small credit line.

### Source attributions (in-dashboard)
- **Willcox feelings wheel** (under the wheel): Willcox, G. (1982), "The Feelings Wheel," *Transactional Analysis Journal* 12(4): 274–276.
- **Intrinsic Work Experience items** (under the IWE panel): U.S. OPM Federal Employee Viewpoint Survey, Intrinsic Work Experience Sub-Index, 2023 FEVS Technical Report (Revised April 2025), p. 13. Public domain (17 U.S.C. § 105). Item 5 adapted ("agency's" → "the user's"); original FEVS Q7 reproduced in-panel.

### Tests
- 8 new `validate.test.mjs` cases covering iwe accept/reject paths (well-formed, empty object, null, out-of-range keys, out-of-range values, non-integers, array rejection).
- 1 new `probe.test.mjs` case: iwe in the fake-claude envelope flows through `record()` into `AGENT_FILE` unchanged.
- 120 tests pass on Node 22+.

## 0.7.2 — registry sweep + chart negative color

### Fixed
- **Chart now uses red below the 0.5 baseline, not blue.** The `.area-neg` shaded region (and the new 0.7.0 `.trace-neg` segment lines) was using `var(--c-sad)` which is the Willcox-palette blue. That conflicted with the join/leave triangle markers below the chart (which already used `var(--c-mad)` red) and read as "calm" rather than "alarming." Both now use `var(--c-mad)` for negatives, matching the dashboard's own polarity coloring elsewhere.

### Added
- **Registry-side sweep.** The 30-second sweep loop now also drops registry entries whose `last_seen_ts` is older than the same 10-minute staleness threshold the file-sweep uses. Previously the registry grew unbounded — every session that exited abruptly (terminal closed, kill -9, parent crash) without firing the `SessionEnd` hook left a permanent entry. Stale entries from before the v0.6.0 identity-capture update were rendering as raw 8-char slugs on the dashboard for long-running daemons because they never had a `display_name`. With registry sweep enabled, those entries time out within 10 minutes of their last Stop event, just like report files. `sweepStaleRegistry(now)` is exported from `tools/src/sweep.ts` for tests; it runs automatically as the second pass of `sweepStaleAgents()` and emits an `agent-removed` SSE event for any entry not already caught by the file-sweep.

### Tests
- 4 new sweep tests in `tools/test/sweep.test.mjs`: registry entries past STALE_MS get reaped, no-registry-file is a no-op, entries missing `last_seen_ts` are left alone (defensive), and the combined `sweepStaleAgents()` run reaps both the file and the registry entry for a single dead agent. 111 tests pass on Node 22+.

## 0.7.1 — event log: chronological order, auto-scroll to latest

### Changed
- Event log under the chart now renders events in chronological order (oldest at top, newest at bottom) so the log reads left-to-right with the chart's time axis. The container auto-scrolls to the bottom on each refresh, so the most recent event is always visible without manual scrolling. Previously the log was newest-first with no auto-scroll, which meant new events at the bottom of the visible area went out of view as the window grew.

## 0.7.0 — chart polish: per-segment trace coloring, 4-hour window, event log

### Fixed
- **Sentiment chart trace is no longer a single color based on current state.** Through 0.6.x the trace polyline used a global `--tone` set by `renderSentiment` to whichever color matched the *latest* ratio, so a team that's currently positive saw the entire history line drawn green even where the historical ratio was negative. The trace now splits into per-segment line elements, colored green above the 0.5 baseline and red below, with stroke-opacity scaling by distance from 0.5 (segments near neutral are muted; segments at extremes are saturated). Segments that cross 0.5 between consecutive points are split at the midline crossing so the color flips cleanly.

### Added
- **4-hour chart window.** The chart now clips to the most recent 4 hours of history rather than rendering the full retained range. Long-running teams no longer squish recent activity into a sliver. Backend storage (`sentiment.jsonl`, cap 1000) is unchanged — just the display is clipped.
- **Event log under the chart.** A compact list of agent join/leave events derived from `agentCount` deltas in the sentiment history, scoped to the same 4-hour window as the chart. Each row: `HH:MM  +/−  display_name  N total`. Joins get a best-effort name lookup via closest `started_ts` in the current registry (60s tolerance); leaves show as `agent left` since the registry no longer holds the departed agent. Lets you correlate the chart's triangle markers with which specific agent affected team mood — "did the mood drop when the qa subagent joined?" is now answerable at a glance.

### Changed
- New CSS classes `.trace-pos` / `.trace-neg` replace the single `.trace` class (still defined as a fallback in case anything else references it). Chart trace stroke colors are `var(--c-peaceful)` (green) and `var(--c-sad)` (red), reusing the same palette tokens as the shaded areas underneath.

## 0.6.0 — human-readable agent names on the dashboard

### Added
- **Display names on every tile and the active portrait.** Teammates show as `<agent-name>@<team-name>` (e.g. `qa@pocketweather-mood`), leads show as `lead@<cwd-basename>` (e.g. `lead@fun_team`). No more 8-char slugs. Mechanism: the `SessionStart` hook now parses the parent claude process's argv for `--agent-name` / `--team-name` / `--agent-type` / `--parent-session-id`, captures them into the registry entry, and the dashboard prefers `display_name` when rendering. Argv is read via `/proc/$PPID/cmdline` on Linux and `ps -wwp $PPID -o command=` on macOS/everywhere else. Failures are non-fatal — the hook falls back to `lead@<cwd-basename>` and registers the entry anyway.
- New `RegistryEntry` fields (`display_name`, `agent_type`, `team_name`, `parent_session_id`) — all optional, additive over existing entries. `AGENT_FILE(<slug>) → state/<slug>.json` is unchanged; no migration needed.

### Changed
- **"Stuck" → "Struggling"** rename across the dashboard (chip label on the top bar, tile CSS class, aria-label, function names in JS). The new word better captures the intended signal — an agent showing distress that may need attention, not necessarily one that has stalled.
- **Struggling detection now scans the full feelings list, not just the dominant feeling.** An agent reporting `thoughtful=0.7, skeptical=0.6, …` was previously not flagged because thoughtful (peaceful core) was dominant; now it is, because skeptical (mad core) hits the 0.6 threshold. Matches user intuition that "any strong negative undercurrent" is worth surfacing, not just "dominant negative feeling."
- README and `docs/ARCHITECTURE.md` updated. Architecture doc has a new "Identity and display names" section explaining the argv-parsing mechanism and the slug-vs-display-name layering. `SessionStart` bullet in "Hooks at a glance" now mentions identity capture.

### Tests
- Two new tests in `tools/test/hook-session-start.test.mjs` covering the lead fallback path (display_name = `lead@<cwd-basename>` when no `--agent-id` is on parent argv, and a sanity check for the `lead@<non-empty>` shape). 107 tests pass on Node 22+.

## 0.5.0 — JSON-only fork probe; v0.4.x install path rolled back

### Changed (breaking, in the architectural sense — user-visible surface only loses one slash command)
- **Probe mechanism: the forked session no longer attempts to call an MCP tool.** Instead, the introspection prompt asks the model to emit a single-line JSON object matching the report schema. The probe parses that object, injects `agent` from registry context, validates via `validateReport`, and writes via the existing `record()` path. End-to-end the same `<agent>.json` files land in `state/`, but the dependency on `mcp__swarmeq__report` being callable inside the fork is gone. Concretely:
  - `tools/src/probe.ts` drops `--mcp-config`, `--strict-mcp-config`, `--allowed-tools mcp__swarmeq__report` from the spawn args. Adds an `extractJsonObject()` helper (fast path for strict single-line JSON, balanced-brace fallback for prose-wrapped output). Replaces the `reportWrittenSince` post-close check with a JSON-parse → validate → `record()` pipeline. New SSE/log event `probe-report-written` is emitted on success.
  - `tools/src/prompt.ts` rewritten as a "v2" prompt that leads with `[swarmeq introspection probe v2]` provenance (suppresses the prompt-injection defensive responses we saw under v1) and hard-locks the response to one JSON object. The `agentName` parameter is dropped — the model never sees or echoes the slug.
- **Why this works for Agent Teams teammates.** The 0.3.x–0.4.x stack assumed `mcp__swarmeq__report` was callable inside the forked session. Agent Teams rebuilds every teammate-fork's tool catalog from the agent-type's `tools:` list (we confirmed this empirically — MCP server processes were spawned inside teammate forks but the tool was filtered out of the catalog). JSON-mode doesn't care what's in the catalog; the model just produces text.

### Removed
- `commands/swarmeq-install.md` slash command. Was needed to write `mcpServers.swarmeq` into user-scope `~/.claude/settings.json` so teammate forks could see the MCP tool — that strategy turned out to load the server but not surface the tool past the catalog filter. Now unnecessary because the probe doesn't call any tool. The 0.4.0/0.4.1 hook-based auto-install is also removed.
- `tools/src/install.ts`, `tools/src/swarmeq.ts:cmdInstall`, the `install` subcommand of `swarmeq.mjs`, `installNeeded`/`installNeededSafe` plumbing in `tools/src/http.ts`, the SessionStart `autoInstall()` block in `tools/src/hooks/session-start.ts`, the `#install-banner` HTML/CSS/JS in `dashboard/dashboard.html`. All deleted.
- Users who ran `/swarmeq-install` under 0.4.x can leave the `mcpServers.swarmeq` entry in `~/.claude/settings.json` — it's now ignored by the probe. Removing it manually has no effect on the dashboard. Plugin-manifest `mcpServers` still exposes the tool for any session whose catalog includes it (lead sessions, anyone hand-authoring a slash command body).

### Added
- `tools/test/probe.test.mjs` (renamed from `probe-no-report.test.mjs`): 16 cases covering strict + tolerant JSON extraction, validation rejection paths (bad label, intensity out of range, empty feelings), pure-prose `probe-no-report`, cwd plumbing carryover, and a guard test asserting `--mcp-config`/`--strict-mcp-config`/`--allowed-tools` never make it into the spawn args.

### Updated
- `docs/ARCHITECTURE.md` replaces the "Team subagents and the catalog filter" section with a "Why we don't probe via an MCP tool call any more" section explaining the 0.5.0 architecture.
- `docs/agent-teams-catalog-filter-research-brief.md` gets a closing note that the catalog-filter wall is sidestepped (not solved) by JSON-mode, in case the brief gets reused for similar problems.
- README setup section simplified — no install command to remember.

## 0.4.1 — auto-install on SessionStart + install-needed banner

### Added
- **SessionStart auto-install.** The hook now silently writes `mcpServers.swarmeq` into `~/.claude/settings.json` on first run, so Agent Teams teammates pick it up on their next session without any manual command. Idempotent — subsequent SessionStarts are a single stat + JSON parse with no write. Emits a one-line stderr notice the one time it does the install (visible in Claude Code's startup output, so the user sees what changed). `/swarmeq-install` stays available for manual reinstall after `~/.claude/settings.json` wipes, but is no longer required for normal use.
- **Install-needed banner on the dashboard.** `/state` now includes `installNeeded: boolean`. Dashboard shows a warning banner above the team view only when the user-scope settings.json lacks the swarmeq entry — covers the brief race window between plugin install and first SessionStart hook completion, and any edge case where auto-install can't write (read-only `$HOME`, etc.). The banner disappears the instant the install lands.

### Changed
- `tools/src/install.ts` (new): small dedicated module exporting `installNeeded()`, `canonicalMcpEntry()`, `userSettingsPath()`. Lets both the CLI (`tools/src/swarmeq.ts`) and the HTTP `/state` route (`tools/src/http.ts`) consume the same check without forming a circular import through swarmeq.ts ↔ http.ts.
- `tools/src/hooks/session-start.ts` gains the inlined `autoInstall()`. Hooks stay zero-import at runtime; the canonical entry is duplicated from `install.ts` on purpose. Failure modes (non-object settings, malformed JSON, copy/write errors) all emit a stderr line and continue — the hook never blocks the session.
- `dashboard/dashboard.html` gains a `#install-banner` element and CSS, toggled by `refreshState()` against `installNeeded`.

### Tests
- 6 new tests for `installNeeded()` in `tools/test/install.test.mjs` (missing file, missing key, malformed JSON, JSON array, present-with-canonical-shape, present-with-custom-shape).
- 4 new tests for SessionStart auto-install in `tools/test/hook-session-start.test.mjs` (fresh write + stderr notice, idempotent no-op, merge with existing entries + backup, refuse malformed settings).
- 110 tests pass on Node 22+.

## 0.4.0 — team-subagent MCP via `/swarmeq-install`

### Added
- **`/swarmeq-install` slash command** (and underlying `node server/swarmeq.mjs install` CLI). Writes the swarmeq MCP server entry into user-scope `~/.claude/settings.json` `mcpServers`. Idempotent, atomic, backs up the prior file before mutating. Run it once after first install; from then on every Claude Code session — lead or Agent Teams teammate — loads `mcp__swarmeq__report` into its tool catalog and the probe path works end-to-end. The dashboard fills in for teammates the same way it does for the lead. This is the documented escape hatch from Agent Teams' per-agent-type tool filter — see `docs/ARCHITECTURE.md` for the why.

### Fixed
- The "team subagent fork-probe finds the session but the model has no `mcp__swarmeq__report` in catalog" failure mode, which v0.3.5–0.3.7 had narrowed down but not solved. Diagnosis from the new `modelResult` field in `probe-no-report` events: Agent Teams rebuilds each teammate's tool catalog from the static `tools` list in its agent-type definition and silently ignores `--mcp-config`/`--strict-mcp-config`. The fix routes around this entirely by registering swarmeq at user scope, which Claude Code's docs explicitly permit teammates to load from.

### Changed
- `tools/src/swarmeq.ts` gains a `cmdInstall()` and `"install"` subcommand. The top-level `main()` is now gated by an entry-point check (compares `import.meta.url` against `process.argv[1]`) so importing the module from tests doesn't fire the CLI dispatcher.
- `tools/test/_helpers.mjs` gains `withTempHome(fn)` (mirrors `withTempState`) — sets `HOME`/`USERPROFILE` to a fresh tmpdir, restores on exit. Used by the install tests to keep them from touching real user settings.

### Tests
- 4 new install tests: fresh-create, merge-with-existing-mcpServers, idempotency, refuse-malformed. 100 tests total on Node 22+.

## 0.3.7 — `/swarmeq-dashboard` actually opens the browser again

### Fixed
- `/swarmeq-dashboard` (and `node server/swarmeq.mjs dashboard` via the slash command) no longer silently fails to open a browser tab. `openBrowser` used `spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()`, which works fine when invoked from a Bash tool call but breaks when invoked from the slash-command body (`!node …`): Claude Code wraps the slash-command body in a process tree that gets torn down as soon as our `node` exits, and the detached `open` child gets killed before LaunchServices (or `xdg-open`/`start`) has handed the URL off to the system URL handler. Switched to `spawnSync`, which keeps the parent alive for the few ms `open` itself takes to dispatch; by then the browser tab is owned by a system daemon and survives our exit. Failures are now also surfaced on stderr instead of being silently swallowed by the bare `try {} catch {}`.

## 0.3.6 — version-based daemon identity (kill-loop fix)

### Fixed
- Dashboard no longer flips between "connected" and "reconnecting" while team subagents are spinning up. Claude Code unpacks each session's plugins into a private `/tmp/claude-plugin-session-<hash>/` directory, so a parent and its N team subagents all compute different `CLAUDE_PLUGIN_ROOT` values pointing at the same plugin install. The 0.3.3–0.3.5 identity check compared `root` strings (with `fs.realpathSync` added in 0.3.5), which made every subagent's `SessionStart` hook — and every MCP-child `record()` call — treat the running daemon as a "stale earlier install" and SIGTERM it. The dashboard SSE dropped on every cycle, ending in "reconnecting" forever once a kill happened to land between session events. Identity is now keyed on `version` (from `/healthz` vs. our `plugin.json`), so any number of per-session unpacks of the same plugin install coexist with a single daemon. Legitimate upgrade case (version drift) still evicts the old daemon as before.

### Changed
- `tools/src/bind.ts:isStaleIdentity` no longer references `pluginRoot()`. Stale iff `version` differs (or is missing on pre-0.3.3 daemons).
- `tools/src/hooks/session-start.ts` reads `<root>/.claude-plugin/plugin.json` inline (hooks stay zero-import) and compares versions instead of paths.

### Added
- Tests for `isStaleIdentity` covering the regression case (same version, different roots → not stale), version drift → stale, and missing version → stale. 96 tests pass on Node 22+.

## 0.3.5 — team-subagent visibility fixes

### Fixed
- Probes for team subagents no longer fail with `No conversation found with session ID …`. The `claude --resume <sid>` lookup is project-scoped: it resolves the session under the project derived from the spawn's CWD. The probe previously inherited the daemon's CWD (typically the directory the user ran `/swarmeq-dashboard` from), so a team subagent registered with a different `cwd` was invisible to resume even when its JSONL existed on disk. The probe now spawns `claude` with `cwd: entry.cwd` from the registry, with a fallback to inheriting if the recorded directory has since been deleted.
- `SessionStart` no longer opens a browser tab when a team fans out parallel subagents. Each subagent's hook used to race past the port-file check before the first daemon bound, so every concurrent subagent invoked the `dashboard` subcommand and `openBrowser()` fired once per agent. The hook now always invokes `_daemon` (never `dashboard`); the browser is only opened by the explicit `/swarmeq-dashboard` slash command.
- The "live dashboard tab flips to reconnecting whenever a new subagent starts" symptom is gone. The `SessionStart` stale-daemon check now compares plugin roots via `fs.realpathSync`, so symlink resolution differences and `/var` vs `/private/var` drift between parent and subagent processes no longer trip the kill-and-respawn path.
- `probe-no-report` events now include the model's actual prose response (`modelResult`, capped at 1KB). When forked Claude exits 0 without calling `mcp__swarmeq__report`, the log now tells us whether the model didn't see the tool, refused to call it, or answered in narrative — previously we only had envelope metadata. Disambiguates the in-the-wild "probe succeeded but produced no report" failure mode.

### Added
- Integration tests for `startProbe` using a fake `claude` binary on `PATH`. New cases cover the `probe-no-report` `modelResult` capture, the per-entry `cwd` getting passed to spawn, and graceful fallback when `entry.cwd` no longer exists. 93 tests pass on Node 22+.

## 0.3.4 — dashboard-empty fixes + test suite

### Fixed
- `SessionStart` no longer mangles 1M-context model ids. `sanitize()` turned `claude-opus-4-7[1m]` into `claude-opus-4-7_1m_`, which then got passed to `claude --model` by the probe and 404'd in <500ms. A new `cleanModel()` strips the `[…]` context-window suffix and keeps only chars valid in a model id; the registry now stores the unbracketed form the CLI accepts. Existing mangled registries self-heal on the next session start. `probe.ts` also defensively un-mangles old `_1m_`/`_200k_`/`_400k_` entries before spawning.
- Detached probe failures are no longer silent. Every `probe-failed`, `probe-exit`, `probe-no-report`, and `model-mismatch` event now lands in `state/probe.log` (JSONL, ≤1MB with rotate) *and* is forwarded to the daemon over a new `POST /probe-event` so live SSE clients see them. Previously `broadcast()` was the only sink, and it only reaches clients of the calling process — never the detached probe.
- Surfaces the "claude exits 0 but never called `mcp__swarmeq__report`" failure mode. The probe now checks whether `AGENT_FILE(agent)` was modified during the run; if not, emits `probe-no-report` with the stdout tail. The root cause (forked-session tool catalog appears frozen) is logged for diagnosis, fix deferred.
- `swarmeq probe` CLI no longer swallows the wrapper's own errors with `try {} catch {}` — exceptions write to stderr so the call site can see them.

### Added
- Test suite. New `tools/test/` directory with 14 `node:test`-based test files covering `validate`, `sentiment`, `paths`, `record`, `http`, `bind`, `sweep`, both probing pure-functions, and all three executable hooks via `spawnSync` against the `.ts` source. Run with `npm test` from `tools/`. Each test isolates state via `SWARMEQ_STATE_DIR` (now honored by `paths.ts` and all hooks) so runs never touch the real plugin state. 90 tests pass on Node 22+.
- `POST /probe-event` HTTP route on the daemon for detached subprocesses to forward SSE events. Capped at 8KB; only the four probe-related `SseEvent` types are accepted.

## 0.3.3 — seamless plugin upgrades

### Fixed
- Plugin upgrades no longer leave behind a broken daemon. The always-on daemon (0.3.0+) caches its `pluginRoot` at startup; when the user upgrades the plugin via `--plugin-url`, Claude Code unpacks the new version into a fresh temp dir and eventually GCs the old one, but the daemon — still running — keeps reading from the deleted path. Every dashboard fetch then 500s with `ENOENT … dashboard/dashboard.html`. The daemon now publishes its `pluginRoot` and `version` on `GET /healthz`; on every `readActivePort()` probe a mismatch triggers SIGTERM + state-file cleanup, and the next caller binds a fresh daemon from the current install. The `SessionStart` hook does the same check inline (hooks stay zero-import) and respawns just the daemon — not the full `dashboard` subcommand — when a stale one is evicted, so the user's existing browser tab reconnects via SSE instead of getting a duplicate window. Pre-0.3.3 daemons (no identity in `/healthz`) are treated as stale and evicted on first contact, so the very first session after upgrading from any older release self-heals.

### Added
- `swarmeq doctor` reports a `daemon matches this install` row, showing the running daemon's version + root and flagging drift from the local install.

## 0.3.2 — drop explicit hooks pointer from plugin.json

### Fixed
- `.claude-plugin/plugin.json` no longer declares `"hooks": "./hooks/hooks.json"`. The Claude Code plugin loader auto-loads `hooks/hooks.json` from its standard path, so declaring it again in the manifest tripped the loader's duplicate-detection guard with `Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file …`. 0.3.1 fixed the *shape* of `hooks/hooks.json` but left the redundant manifest pointer in place, so `--plugin-url` installs still failed at load time. The `manifest.hooks` field is now reserved for *additional* hook files beyond the standard location, per the loader's error message.

## 0.3.1 — plugin hooks.json shape fix

### Fixed
- `hooks/hooks.json` now wraps its event map under a top-level `"hooks"` key, matching the schema the Claude Code plugin loader expects. The 0.3.0 release shipped the events at the root (the standalone `.claude/hooks.json` shape), so `--plugin-url` installs of 0.3.0 failed at load time with `"hooks": expected record, received undefined`. `--plugin-dir` installs were unaffected only if the user happened to have a patched local copy.

### Changed
- Docs sync: README "Status" line now tracks the current version; "Building from source" snippet adds the `npm run typecheck` step and notes the sources are TypeScript with esbuild producing the committed `server/swarmeq.mjs` + `hooks/*.mjs` bundles. `docs/ARCHITECTURE.md` "Want to read the code?" section now points at `tools/src/*.ts` (and `tools/src/hooks/*.ts`) instead of the post-build `.mjs` paths. `.claude-plugin/marketplace.json` version field aligned with `plugin.json`.

## 0.3.0 — TypeScript + always-on daemon

### Changed (breaking)
- Dashboard runs as a true detached daemon. `/swarmeq` is renamed to `/swarmeq-dashboard` and is now non-blocking: it forks the daemon, polls until reachable, opens the browser, and returns. Previously the slash command's `!node …` invocation held the foreground process forever (the binder), which stalled Claude Code's UI until the user killed the dashboard.
- Probing is automatic. Every `Stop` hook fires a per-agent probe, throttled to at most one probe per 90s (tracked via `last_probe_ts` in `registry.json`). The probe fork inherits `SWARMEQ_PROBE=1`, which short-circuits the hooks in the forked session so probes don't probe themselves.
- `/swarmeq-check` and `/swarmeq-poll` are removed — both are subsumed by auto-probe.
- Dashboard UI: "probe" and "probe all" buttons are gone; the portrait now shows a minimal `last updated · Xs ago` line. `POST /probe` and `POST /probe/:agent` HTTP routes and the `swarmeq probe-all` / `swarmeq check` / `swarmeq poll` subcommands are removed.

### Added
- TypeScript migration (server + hooks). All sources under `tools/src/` are now `.ts` with `tsc --strict` clean; `esbuild` still emits `server/swarmeq.mjs` and `hooks/*.mjs`. Hook bundles remain fully self-contained (zero shared runtime imports). New `npm run typecheck` step in the maintainer build chain. Runtime architecture is unchanged.
- Cold-start polish: only the foreground `/swarmeq-dashboard` opens the browser; the auto-spawned daemon doesn't. Stale `.port` / `.pid` are scrubbed up-front when a fresh daemon starts. Self-termination heartbeat in the bound daemon reclaims `.pid` / `.port` if a yielding peer's cleanup raced ahead.
- Docs: README warm-up section, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, and dashboard screenshots (`docs/screenshot-individual.png`, `docs/screenshot-team.png`).

### Fixed
- Sweep no longer broadcasts a sentiment point built from dead agents. `sweepStaleAgents()` now calls `snapshotAndBroadcast(readLivingReports())` after removals — previously it passed `readAllReports()`, briefly violating the team-view living-only invariant.
- `appendSentimentPoint()` swapped its hand-rolled `.tmp + rename` (fixed suffix, race-prone under concurrent trim) for the shared `writeAtomic()` helper which pid+timestamp-suffixes the tmp file.
- `snapshotAndBroadcast()` skips the JSONL append and SSE broadcast when ratio + agentCount are identical to the previous point. Probe-bursts no longer fill the history with duplicates or wake every SSE client on a no-op.
- Three slightly-different inline registry-read idioms (`http.snapshot()`, `record.readLivingReports()`, `probe.lookupAgent()`) collapsed onto a single typed `paths.readRegistry()`. Side effect: `GET /state` parses `registry.json` once per request instead of twice.

## 0.2.0 — team dashboard + reliability

### Added
- Team-level dashboard at `/team` with a topbar `individual | team` toggle. Union wheel (cell lit if any agent's most-recent report names it, opacity = max intensity across agents). Big team sentiment % (positive intensities / total valenced; 50% = neutral) with a diverging negative/neutral/positive bar. Sentiment-over-time SVG chart with HH:MM ticks, polarity-colored areas split at the 50% baseline, and small ▲ green (join) / ▼ red (leave) markers on the x-axis at each `agentCount` change. Team strip hides on `/team`.
- `swarmeq probe-all` CLI, `POST /probe` HTTP endpoint, and dashboard topbar "probe all N" button that fan out `startProbe()` across every entry in `registry.json`.
- Sentiment history persisted to `sentiment.jsonl` in `stateDir/` (capped at 1000 lines), exposed via `GET /history?limit=N` and pushed live via SSE `sentiment` events.
- Stale-agent sweep: a 30s timer in the bound process deletes per-agent report files older than 10 min and broadcasts `agent-removed` for files that vanished externally (the `SessionEnd` hook unlinks them). Dashboard drops the agent from the team strip, the team wheel, and the sentiment chart.
- Re-probe UX: button now shows `probing…` / `failed` states and surfaces the server's `probe-failed` reason inline; portrait "Xs ago" updates every second; `.agent.probing` / `.agent.stale` finally have matching CSS.
- Auto-open: `SessionStart` hook detached-spawns `swarmeq dashboard`, so the browser pops up the moment Claude Code starts (idempotent on macOS — focuses the existing tab).

### Changed (breaking)
- The `face` field (8 facial-action values) is removed from the `report` MCP tool schema, ingest validation, the introspection prompt, and `/swarmeq-check`. Nothing read it — the dashboard's robot-face glyph is derived from the dominant feeling label. Pre-existing on-disk reports with a `face` block still load.

### Fixed
- Dashboard refresh + perceived `/swarmeq-check` delay: `cmdMcp` no longer greedily binds 7778+ when 7777 is taken. Previously every Claude Code session became its own private dashboard and broadcast SSE events into a void no one was reading; now the MCP child only discovers the active port and `record()` re-reads `.port` lazily, so long-lived children forward to whichever dashboard is alive.
- `/swarmeq-check` defaults the agent name to the literal string `lead` instead of emitting the full session UUID when `CLAUDE_AGENT_NAME` isn't set.

## 0.1.0 — initial release

- Claude Code plugin: 5 slash commands (`/swarmeq`, `/swarmeq-check`, `/swarmeq-poll`, `/swarmeq-stop`, `/swarmeq-doctor`).
- MCP stdio server with one tool, `swarmeq.report` (surfaced as `mcp__swarmeq__report`), validating 8 facial-action values, 1–4 Willcox feelings, and an optional note.
- Localhost HTTP + SSE dashboard at `127.0.0.1:7777`. Single static HTML file, vanilla JS, no CDN.
- First-binder process model: every MCP-spawned process tries to bind the port; loser processes forward reports via `POST /ingest`.
- Fork-probe via `claude --resume … --fork-session --no-session-persistence` with three-way model pin (`--model`, env, `--settings`). Probe failures emit `probe-failed` on SSE.
- Lifecycle hooks (`SessionStart` / `Stop` / `SubagentStop` / `SessionEnd`) maintain a registry of agent → session_id + model.
- Tested on macOS ARM. Best-effort cross-platform code (browser-open via `open` / `xdg-open` / `cmd /c start`); Linux / Windows / WSL untested in 0.1.0.
- License: MIT.
