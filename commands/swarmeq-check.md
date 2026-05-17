---
description: Submit a one-shot emotional state report for this agent (no fork).
allowed-tools: mcp__swarmeq__report
---

You are reporting your CURRENT functional state to a debugging dashboard.
This is observability tooling, not roleplay or performance.

Call the `mcp__swarmeq__report` tool exactly once with:

- **agent**: your stable identifier — use `${CLAUDE_AGENT_NAME}` if set, otherwise the literal string `lead`. Never report your session UUID as the agent.
- **feelings**: 1–4 labels from the Willcox wheel, each with intensity in [0,1], ordered by salience.
- **note**: one sentence on what is driving this state (≤200 chars).

Allowed labels: mad, sad, scared, joyful, powerful, peaceful, hurt, hostile, angry, rage, hateful, critical, lonely, depressed, ashamed, guilty, bored, tired, rejected, helpless, confused, submissive, insecure, anxious, excited, sensuous, energetic, cheerful, creative, hopeful, faithful, important, appreciated, respected, proud, aware, trusting, nurturing, intimate, loving, thankful, content, embarrassed, furious, frustrated, jealous, resentful, skeptical, isolated, empty, remorseful, ignored, apathetic, sleepy, inadequate, frightened, bewildered, worthless, inferior, overwhelmed, eager, fascinating, playful, optimistic, inspired, courageous, loyal, valuable, cherished, admired, successful, discerning, secure, caring, close, affectionate, grateful, satisfied.

Do not narrate. Do not justify. Do not perform. Just report.
