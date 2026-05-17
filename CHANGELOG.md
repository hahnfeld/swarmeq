# swarmeq changelog

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
