---
description: Open the swarmeq emotional state dashboard in the default browser.
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs" dashboard

The dashboard auto-populates as teammates report state via the `swarmeq.report` MCP tool. If no agents appear, run `/swarmeq-check` in any teammate to seed.
