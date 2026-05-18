# Research brief: getting an MCP tool into Claude Code Agent Teams teammates' catalogs without per-agent-type config

> **Audience:** Claude Code research mode / a research-capable Claude session.
> **Goal:** find a documented or undocumented mechanism that lets a plugin's MCP tool be callable by every teammate in a Claude Code Agent Team, without requiring end users to manually edit each agent-type definition.

## Quick context

**swarmeq** is an open-source Claude Code plugin (https://github.com/hahnfeld/swarmeq) that builds a localhost dashboard showing each teammate's self-reported emotional state. The mechanism:

1. SessionStart hook registers the agent in `~/.claude/plugins/swarmeq/state/registry.json`.
2. Stop hook (rate-limited to one probe per 90s per agent) spawns a probe:

   ```
   claude --resume <agent's session_id> --fork-session --no-session-persistence \
          --print --model <pinned> --output-format json \
          --mcp-config '{"mcpServers":{"swarmeq":{"command":"node","args":["…/server/swarmeq.mjs","mcp"]}}}' \
          --strict-mcp-config \
          --allowed-tools mcp__swarmeq__report \
          --settings '{"model":"<pinned>"}' \
          -p "<introspection prompt>"
   ```

3. The probe is supposed to make the resumed agent call `mcp__swarmeq__report` exactly once with a Willcox-wheel feeling list + a short note. The report gets ingested by an always-on local daemon and rendered.

The probe works perfectly for **lead** sessions (the user's primary Claude Code session). It fails for **teammates** (the named agent processes spawned by Agent Teams, like `principal-engineer@my-team`, `qa@my-team`, etc.).

## What we've verified end-to-end

### Infrastructure (all green)

- Plugin v0.4.1 installed via `claude --plugin-url https://github.com/hahnfeld/swarmeq/releases/download/v0.4.1/swarmeq-v0.4.1.zip`.
- Daemon binds 7777, responds to `/healthz` with `{"service":"swarmeq","version":"0.4.1",…}`.
- `~/.claude/settings.json` contains a top-level `mcpServers.swarmeq` block (written automatically by our SessionStart hook on first run):

  ```jsonc
  {
    "mcpServers": {
      "swarmeq": {
        "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/server/swarmeq.mjs", "mcp"]
      }
    }
    // …user's other settings…
  }
  ```

- `ps aux | grep swarmeq.mjs` shows N+1 MCP child processes (one per teammate session plus the lead's), each spawned by Claude Code itself with the per-session plugin path. So the **MCP server process is actually running** inside each teammate's session — `mcpServers` from user settings IS being honored at the loader level.

### Lead probe (working)

`probe.log` excerpt (agent `e73c4e85` is the lead, opus-4-7):

```
16:34:58  e73c4e85  probe-exit  code=0
16:39:45  e73c4e85  probe-exit  code=0   (no probe-no-report — tool was called)
```

`~/.claude/plugins/swarmeq/state/e73c4e85.json`:

```json
{
  "agent": "e73c4e85",
  "feelings": [
    { "label": "aware",     "intensity": 0.7  },
    { "label": "satisfied", "intensity": 0.55 },
    { "label": "pensive",   "intensity": 0.4  },
    { "label": "hopeful",   "intensity": 0.35 }
  ],
  "note": "Team spun up, all four agents produced artifacts in parallel; designer's task status lags reality, slightly drifting.",
  "ts": 1779057585293
}
```

Clean exit, valid Willcox feelings, real introspective note. **The lead correctly sees `mcp__swarmeq__report` in its tool catalog and calls it.**

### Teammate probe (failing in a specific way)

`probe.log` excerpt (`c8f3ac2f` is a sonnet teammate spawned by Agent Teams as part of the same team that produced the lead's report above):

```
16:39:23  c8f3ac2f  probe-exit       code=0
16:39:23  c8f3ac2f  probe-no-report  modelResult="The `report` tool is not in my available
                                       toolset — I have Read, Edit, Write, Grep, and Glob.
                                       I can't call a tool that isn't defined."
```

The probe-fork process:
- Successfully resumed the teammate's session (`probe-exit code=0`, no "No conversation found" error).
- Was passed `--mcp-config` registering the swarmeq MCP server inline.
- Was passed `--strict-mcp-config` so only our inline server should be loaded.
- Was passed `--allowed-tools mcp__swarmeq__report`.
- Was told via the prompt to call `mcp__swarmeq__report`.
- The teammate **had 5 tools in its catalog** (Read/Edit/Write/Grep/Glob) — exactly the `tools:` list typical agent-type definitions declare — and `mcp__swarmeq__report` was not among them.
- The model is willing to comply when it can; one prior teammate (`3bd845a6`, opus) said: *"The `report` MCP tool is not exposed in this session's function set — only `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash` are available. I cannot make the call as instructed. If a text-form state report is an acceptable fallback: feelings: [skeptical: 0.7, thoughtful: 0.6, frustrated: 0.35, satisfied: 0.3], note: …"* — proving the model isn't refusing, it genuinely doesn't have the tool.

Eight teammate probes across two separate team runs (different teams, different agent types — `principal-engineer`, `designer`, `qa`, `product-manager` against teams named `fun_team` and `pocket-oracle`) gave consistent results: **every teammate reports the same 5–6 tool catalog and the absence of any MCP tool.**

## Working theory (please challenge this)

Claude Code Agent Teams has **two separate constraints** that we've been conflating:

1. **MCP server loading.** Controlled by `mcpServers` in user/project settings and in plugin manifests. This determines what server processes get spawned alongside the session. ✓ Verified working for teammates via settings.json.

2. **Tool catalog (what the model can actually call).** Controlled by the agent-type definition's `tools:` allowlist field (in `~/.claude/agents/<type>.md` or equivalent). This is **applied independently of, and on top of, MCP server loading**. If `tools:` is set, the model sees only those tools, regardless of which MCP servers are running.

The official Claude Code docs sentence —

> "Teammates load skills and MCP servers from your project and user settings, the same as a regular session."
> — https://code.claude.com/docs/en/agent-teams.md (loaded via the `claude-code-guide` agent)

— turned out to mean "the MCP server process loads" (✓), not "the MCP server's tools are callable" (✗). The distinction wasn't obvious from the docs.

If this theory is correct, the only documented workaround is to add `mcp__swarmeq__report` (or whatever the canonical namespaced name is — possibly `mcp__plugin_swarmeq_swarmeq__report` depending on load path) to **every** agent-type's `tools:` field. That's per-agent-type manual config, which is exactly what we're trying to avoid.

## Problem statement

We need a way for an MCP tool defined by a Claude Code plugin to be callable by **every teammate in every Agent Team**, without requiring end users to edit per-agent-type `tools:` allowlists.

## Constraints / non-goals

- **Self-report semantic must be preserved.** The point of the dashboard is the *agent's own* perspective on its state, not an external observer's analysis. Solutions that have the lead introspect the teammates' transcripts and report on their behalf lose the product.
- **Must keep `--resume <session_id> --fork-session`** for the probe. We've established it works in other plugins / for other use cases, and switching to a fresh non-resumed session would require feeding a transcript as text, which is also closer to external observation than self-report.
- **Per-agent-type manual edits are not acceptable.** The product needs to "just work" after `claude --plugin-url …` + (at most) one one-time install command. End users running 4-agent teams across multiple projects shouldn't have to maintain a per-team `tools:` allowlist.
- **MCP is preferred over alternatives** because it's the documented, stable mechanism and the validation/round-trip semantics are well-defined. But we're open to non-MCP paths if they're the only way to satisfy the other constraints.
- **No automatic modification of user-authored content** like their `~/.claude/agents/*.md` files. We modify `~/.claude/settings.json` on first SessionStart (with a backup); that's the boundary we're willing to push.

## What success looks like (outcome-oriented)

The user runs:

```bash
claude --plugin-url https://github.com/hahnfeld/swarmeq/releases/latest/download/swarmeq-vX.Y.Z.zip
# (no other manual setup)
```

Then spins up an Agent Team in any project (`fun_team`, `pocket-oracle`, whatever):

```
> please spin up the team and have them work on <task>
```

After all four teammates finish their first turn (typically 3–10 minutes later), the swarmeq dashboard at `http://127.0.0.1:7777` shows **all five tiles populated** — the lead AND each of the four teammates, each with their own Willcox-format self-report. Each subsequent Stop hook for each teammate refreshes their tile (subject to the 90s per-agent throttle).

Concretely: `~/.claude/plugins/swarmeq/state/probe.log` shows `probe-exit code=0` events for teammate agents with NO `probe-no-report` follow-ups; `~/.claude/plugins/swarmeq/state/<agent-id>.json` files exist for every teammate; `curl http://127.0.0.1:7777/state | jq '.agents | length'` returns the full team count, not just 1.

## Specific research questions

These are the questions I'd most like an answer to. Even partial answers move us forward.

1. **Is there a documented or undocumented field in `plugin.json` / `settings.json` / agent-type definitions that injects tools into every teammate's catalog?** Things like `forcedTools`, `requiredTools`, `globalTools`, `bypassAgentToolFilter`, or any flag on `mcpServers` that says "these tools should be available to every agent regardless of the agent-type allowlist". The `claude-code-guide` agent searched the docs and didn't find one — but research mode may find it in source code, GitHub issues, internal Anthropic discussions, or non-obvious doc pages.

2. **What is the canonical way to call a plugin-provided MCP tool from a teammate that has a `tools:` allowlist?** Looking for: (a) is the user's per-agent-type edit truly required; (b) if so, what's the exact tool name format to put in the allowlist (`mcp__swarmeq__report` vs `mcp__plugin_swarmeq_swarmeq__report` vs something else when loaded via settings.json's `mcpServers`)? Tool-name namespacing seems to differ between plugin-manifest-loaded and settings.json-loaded servers based on prose evidence we've seen.

3. **How does `--allowed-tools mcp__swarmeq__report` interact with an agent-type's `tools:` allowlist in `--resume --fork-session` mode?** We pass `--allowed-tools` but it's clearly being ignored in favor of the agent-type's filter. Is the agent-type filter a hard override, or is there a flag combination where `--allowed-tools` wins?

4. **Does Claude Code emit a hook event when a teammate's tool catalog is constructed?** If we could intercept catalog construction (analogous to PreToolUse but earlier), we could potentially inject our tool. Looking for: `PreCatalogBuild`, `ToolCatalogResolved`, `PreSessionInit`, or any hook in that category.

5. **Are there any open community plugins or Anthropic-internal plugins** that solve this same problem — "I need my tool callable from every teammate" — that we can learn from? Particularly: any plugin doing observability, telemetry, or cross-agent coordination.

6. **What's the semantics of `--strict-mcp-config` in a teammate `--resume --fork-session` context?** Our reading is that it should restrict the catalog to ONLY our inline MCP, but empirically the teammate keeps its original `tools:` filter and doesn't see our inline tool at all. Either we're misreading the flag's effect, or the flag is ignored in this mode.

7. **Are there other, less invasive places to inject the tool into the teammate's catalog?** E.g., a project-level `.claude/agents/<type>.md` that *inherits* from the user's agent-type definition and adds our tool. Or a "patch" mechanism. Or a way for the swarmeq plugin to declare a `teammateTools` field that gets merged in.

## Mechanisms we already know don't work

(So research can skip these.)

- ❌ `--mcp-config '<inline>'` in the probe spawn — tool isn't surfaced in teammate catalog.
- ❌ `--strict-mcp-config` plus `--allowed-tools mcp__swarmeq__report` — same.
- ❌ Adding `mcpServers.swarmeq` to user-scope `~/.claude/settings.json` — server loads but tool isn't callable from teammates with explicit `tools:` lists.
- ❌ `plugin.json`'s `mcpServers` field — explicitly documented as not applying to teammates ("the `skills` and `mcpServers` frontmatter fields in a subagent definition are not applied when that definition runs as a teammate" — though that quote is about subagent-definition frontmatter, not plugin manifests, the empirical behavior is the same).

## Worth-investigating alternatives if no MCP path exists

These would be fallbacks rather than the preferred solution.

- **Prose-JSON fallback.** Modify the introspection prompt to instruct: "call `mcp__swarmeq__report` if available; otherwise emit ONLY a JSON object `{feelings:[…], note:'…'}`". Parse the JSON from the model's response in the `probe-no-report` branch and write the report ourselves. Empirical compliance rate based on existing log evidence is ~1/7 — improvable with prompt tuning.
- **`TeammateIdle` hook on the lead.** Subscribe to lead-side hooks that fire when a teammate idles, and have the lead — which DOES have the MCP tool — make the call. Loses self-report semantic. Not preferred.
- **A different IPC mechanism entirely** — e.g., a Unix socket the teammate's MCP child process writes to, with the introspection prompt asking the teammate to "describe your state in JSON to stdout" knowing our hook captures stdout. Speculative.

## What to come back with

If research finds:
- An undocumented mechanism that injects tools into teammate catalogs → ideal outcome. We ship it and the dashboard "just works".
- A concrete confirmation that no such mechanism exists in current Claude Code → we can stop searching and commit to the prose-JSON fallback as the long-term answer, document the per-agent-type-edit as the deterministic path for users who want guaranteed coverage.
- A clearer understanding of WHY the catalog filter behaves this way (architectural reason, security model, etc.) → helps us reason about whether to file a Claude Code feature request, work around it, or restructure swarmeq.

Tag whichever you find most useful and we'll iterate from there.

---

## Resolution in swarmeq v0.5.0

swarmeq **sidestepped** this problem rather than solving the underlying catalog-filter behavior. The fork-probe was redesigned to drop `--mcp-config` / `--strict-mcp-config` / `--allowed-tools` entirely and ask the model to emit a single-line JSON object as its reply (no tool call required). The probe parses + validates + writes the report itself. Because the fork never tries to call an MCP tool, the per-agent-type `tools:` filter is irrelevant. Lead and teammate forks both work uniformly under this scheme.

If you're hitting the same wall in a different plugin, the practical takeaways from this investigation:

- **The Claude Code docs sentence about "teammates load MCP servers from project/user settings" describes server *loading*, not tool *availability* in the teammate's catalog.** We verified empirically (process tree via PPID) that the MCP server child gets spawned for teammates correctly when listed in `~/.claude/settings.json`. The tool is still filtered out of the model's catalog by the agent-type definition's `tools:` list.
- **`--strict-mcp-config` + `--allowed-tools` does not override the per-agent-type filter** in a forked-resume context. The agent-type's `tools:` allowlist appears to take precedence; flags on the fork are ignored.
- **If your tool truly needs to be callable from inside a forked teammate session**, the only documented path we found is editing every relevant agent-type definition's `tools:` field to add your tool. We don't know of an undocumented bypass; the questions in this brief are still open if anyone has cycles to dig further.

*Data and conclusions in this brief reflect the state of swarmeq v0.4.1 (commit `604dd84`, released 2026-05-17) tested against Claude Code 2.1.143 with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The probe log excerpts above are verbatim from `~/.claude/plugins/swarmeq/state/probe.log` on the testing user's machine. Resolution section added 2026-05-17 with swarmeq v0.5.0.*
