---
description: Enable or disable swarmeq Stop-hook polling. Usage: /swarmeq-poll <seconds|off>
allowed-tools: Bash
argument-hint: "<seconds 5-3600 | off>"
---

!node "${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs" poll $ARGUMENTS

When enabled, the Stop hook will trigger a self-report no more often than `<seconds>` apart. Pass `off` (or no argument) to disable.
