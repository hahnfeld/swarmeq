# swarmeq

**A self-reported emotional state dashboard for Claude Code Agent Teams.**

Each peer-agent reports its current functional state — 1–4 Willcox 1982 feelings with intensities — and the dashboard renders one tab per agent: a stylized SVG face (derived from the dominant feeling) plus the full Willcox wheel with intensity highlights. Clicking a tab fork-probes the agent without disturbing its running session.

![dashboard preview](tools/scratch/screenshot-01.png)

```
  Agent ──MCP stdio──> swarmeq.mjs ──HTTP/SSE──> dashboard.html (browser)
                            │
                            └── spawns: claude --resume <SID> --fork-session …
                                        (for tab-click probes only)
```

## Install

**One-liner** (zip-based, recommended):

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  claude --plugin-url https://github.com/hahnfeld/swarmeq/releases/latest/download/swarmeq-v0.1.0.zip
# inside the session:
/swarmeq         # opens http://127.0.0.1:7777 in your browser
```

**From source** (for contributors):

```bash
git clone https://github.com/hahnfeld/swarmeq.git
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --plugin-dir ./swarmeq
```

**Zero user-side npm install.** The MCP SDK is bundled into `server/swarmeq.mjs` at release time via esbuild. The dashboard is a single static HTML file with inline JS and inline SVG.

## Requirements

- Node ≥ 20 (already required by Claude Code)
- Claude Code v2.1.117+ with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set
- macOS, Linux, or Windows (tested on macOS ARM; others best-effort in 0.1.0)

## Slash commands

| Command | What it does |
| --- | --- |
| `/swarmeq` | Open the dashboard (starts the server if not running). |
| `/swarmeq-check` | One-shot self-report from the current agent's session (no fork). |
| `/swarmeq-poll <seconds\|off>` | Enable / disable Stop-hook polling at the given cadence. |
| `/swarmeq-stop` | Stop the dashboard server (SIGTERM the binder). |
| `/swarmeq-doctor` | Print a ✓/✗ diagnostics table. |

## How it works

When Claude Code starts a session, it spawns `node server/swarmeq.mjs mcp` as the plugin's MCP server. Every such process attempts to bind port 7777 — the **first binder** owns the dashboard HTTP+SSE channel. Subsequent processes run MCP-only and forward any tool calls to the binder's `/ingest` endpoint, so reports appear in the browser whether they originated in the binder's process or any other.

The `mcp__swarmeq__report` tool accepts a strict schema: 1–4 feelings whose labels must come from the curated 78-entry Willcox 1982 set, each with an intensity in [0,1], plus an optional ≤200-char note.

Clicking a tab POSTs to `/probe/:agent`, which spawns:

```
claude --resume <SID> --fork-session --no-session-persistence
       --print --model <pinned> --output-format json
       --mcp-config <inline> --strict-mcp-config
       --allowed-tools mcp__swarmeq__report
       --settings '{"model":"<pinned>"}'
       -p "<introspection prompt>"
```

The fork inherits the teammate's full context, calls the tool exactly once, and exits without persisting. The model is pinned three ways (`--model`, `ANTHROPIC_MODEL`, and `--settings`) so the probe never silently downgrades.

## The 78-entry Willcox 1982 taxonomy

Six core emotions, six secondaries per core, one tertiary per secondary.

| Core (color) | Secondaries → tertiaries |
| --- | --- |
| **mad** (#C53030) | hurt → embarrassed · hostile → furious · angry → frustrated · rage → jealous · hateful → resentful · critical → skeptical |
| **sad** (#3182CE) | lonely → isolated · depressed → empty · ashamed → remorseful · guilty → ignored · bored → apathetic · tired → sleepy |
| **scared** (#805AD5) | rejected → inadequate · helpless → frightened · confused → bewildered · submissive → worthless · insecure → inferior · anxious → overwhelmed |
| **joyful** (#ECC94B) | excited → eager · sensuous → fascinating · energetic → playful · cheerful → optimistic · creative → inspired · hopeful → courageous |
| **powerful** (#DD6B20) | faithful → loyal · important → valuable · appreciated → cherished · respected → admired · proud → successful · aware → discerning |
| **peaceful** (#38A169) | trusting → secure · nurturing → caring · intimate → close · loving → affectionate · thankful → grateful · content → satisfied |

Source: Willcox, G. (1982). *The Feeling Wheel*. Transactional Analysis Journal, 12(4):274–276. swarmeq cites this work as factual reference; the taxonomy is a curated subset of the canonical 1982 list.

## Building from source

Maintainer-only. End users do not need this — `server/swarmeq.mjs` is committed pre-bundled.

```bash
cd tools && npm install && node build.mjs
# → produces server/swarmeq.mjs (~600 KB ESM bundle, MCP SDK inlined)
```

## Status: 0.1.0

Tested on macOS ARM. The plugin works end-to-end on this platform. Linux / Windows / WSL paths exist in the code (browser-open shim, `path.join`, etc.) but are not smoke-tested in 0.1.0 — file issues if anything breaks.

## License

MIT. See `LICENSE`.
