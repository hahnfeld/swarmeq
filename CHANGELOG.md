# swarmeq changelog

## 0.1.0 — initial release

- Claude Code plugin: 5 slash commands (`/swarmeq`, `/swarmeq-check`, `/swarmeq-poll`, `/swarmeq-stop`, `/swarmeq-doctor`).
- MCP stdio server with one tool, `swarmeq.report` (surfaced as `mcp__swarmeq__report`), validating 8 facial-action values, 1–4 Willcox feelings, and an optional note.
- Localhost HTTP + SSE dashboard at `127.0.0.1:7777`. Single static HTML file, vanilla JS, no CDN.
- First-binder process model: every MCP-spawned process tries to bind the port; loser processes forward reports via `POST /ingest`.
- Fork-probe via `claude --resume … --fork-session --no-session-persistence` with three-way model pin (`--model`, env, `--settings`). Probe failures emit `probe-failed` on SSE.
- Lifecycle hooks (`SessionStart` / `Stop` / `SubagentStop` / `SessionEnd`) maintain a registry of agent → session_id + model.
- Tested on macOS ARM. Best-effort cross-platform code (browser-open via `open` / `xdg-open` / `cmd /c start`); Linux / Windows / WSL untested in 0.1.0.
- License: MIT.
