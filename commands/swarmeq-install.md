---
description: (Manual reinstall) Write swarmeq's MCP server entry to ~/.claude/settings.json. The SessionStart hook does this automatically — use this command only after wiping settings or to verify the entry.
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs" install

Normally you don't need this — the SessionStart hook auto-installs `mcpServers.swarmeq` into `~/.claude/settings.json` on first run (idempotent on subsequent runs). This command is the manual equivalent, useful after wiping your settings file or if the auto-install failed (read-only `$HOME`, etc.). Idempotent and safe to re-run. Restart active sessions after running so they pick up the new MCP server.
