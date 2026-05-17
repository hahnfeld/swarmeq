---
description: Install swarmeq's MCP server at user scope so Claude Code Agent Teams teammates can call mcp__swarmeq__report.
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs" install

This is a one-time setup. Team subagents in Claude Code Agent Teams load MCP servers from your user settings (`~/.claude/settings.json`), not from the plugin manifest, so the dashboard stays empty for teammates until this entry exists. Idempotent and safe to re-run. Restart active sessions after running so they pick up the new MCP server.
