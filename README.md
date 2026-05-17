# swarmeq

**A self-reported emotional state dashboard for Claude Code Agent Teams.**

Each peer-agent reports its current functional state — 1–4 Willcox 1982 feelings with intensities — and the dashboard renders one tab per agent: a stylized SVG face (derived from the dominant feeling) plus the full Willcox wheel with intensity highlights. Agents are probed automatically on their Stop hook (rate-limited to at most one probe per 90s), so the dashboard stays warm without any manual action.

![dashboard preview](tools/scratch/screenshot-01.png)

```
  Agent ──MCP stdio──> swarmeq.mjs ──HTTP/SSE──> dashboard.html (browser)
                            │
                            └── spawns: claude --resume <SID> --fork-session …
                                        (auto-probe on every Stop hook, ≥90s apart)
```

## Install

**One-liner** (zip-based, recommended):

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  claude --plugin-url https://github.com/hahnfeld/swarmeq/releases/latest/download/swarmeq-v0.2.0.zip
# inside the session:
/swarmeq-dashboard   # opens http://127.0.0.1:7777 in your browser
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
- macOS, Linux, or Windows (tested on macOS ARM; others best-effort)

## Slash commands

| Command | What it does |
| --- | --- |
| `/swarmeq-dashboard` | Open the dashboard (starts the daemon in the background if not running). |
| `/swarmeq-stop` | Stop the dashboard daemon (SIGTERM the binder). |
| `/swarmeq-doctor` | Print a ✓/✗ diagnostics table. |

## How it works

When Claude Code starts a session, it spawns `node server/swarmeq.mjs mcp` as the plugin's MCP server, and the SessionStart hook forks a detached **daemon** that owns port 7777 and serves the dashboard HTTP+SSE channel. The daemon outlives any individual session — start a session, close it, the daemon keeps running. Every MCP child discovers the active port and forwards reports to the daemon's `/ingest` endpoint.

The `mcp__swarmeq__report` tool accepts a strict schema: 1–4 feelings whose labels must come from the curated 78-entry Willcox 1982 set, each with an intensity in [0,1], plus an optional ≤200-char note.

On every Stop hook the plugin spawns a per-agent probe (rate-limited to one per 90s per agent):

```
claude --resume <SID> --fork-session --no-session-persistence
       --print --model <pinned> --output-format json
       --mcp-config <inline> --strict-mcp-config
       --allowed-tools mcp__swarmeq__report
       --settings '{"model":"<pinned>"}'
       -p "<introspection prompt>"
```

The fork inherits the teammate's full context, calls the tool exactly once, and exits without persisting. The model is pinned three ways (`--model`, `ANTHROPIC_MODEL`, and `--settings`) so the probe never silently downgrades. `SWARMEQ_PROBE=1` is set on the fork's env so its own SessionStart/Stop/SessionEnd hooks short-circuit — no probe-of-a-probe recursion.

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

## Status: 0.2.0

Tested on macOS ARM. The plugin works end-to-end on this platform. Linux / Windows / WSL paths exist in the code (browser-open shim, `path.join`, etc.) but are not smoke-tested — file issues if anything breaks.

## License

MIT. See `LICENSE`.
