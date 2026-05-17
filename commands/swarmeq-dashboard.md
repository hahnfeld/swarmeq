---
description: Open the swarmeq emotional state dashboard in the default browser.
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs" dashboard

The dashboard auto-populates as teammates report state. Each agent is probed automatically on its Stop hook (rate-limited to at most one probe per 90s).
