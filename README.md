# Skald

> *"The skald's job was to remember — to keep the lineage, the sagas, and the decisions of the hall, and recite them back when asked."*

Spec index and project planning tool. Semantic search over a markdown specification corpus, with project plans, build session tracking, and an ANIMUS-styled dashboard.

## Quick Start

```bash
# 1. Initialize config
skald init /path/to/your/specs

# 2. Set your OpenAI API key (for embeddings)
export OPENAI_API_KEY=sk-...

# 3. Index your specs
skald build

# 4. Search
skald search "authentication architecture"

# 5. Start the live dashboard
skald live
```

## What It Does

- **Indexes markdown specs** into SQLite with OpenAI embeddings for semantic search
- **Tracks project plans** with phases, status, completion notes, and auto-advance
- **Generates build briefings** — paste into a Claude Code session to start a build phase
- **Serves a live dashboard** — ANIMUS-styled dark glass UI showing plans, specs, and lint issues
- **Watches for changes** — re-indexes on file save, alerts on spec conflicts
- **MCP server** — Claude Code calls `search_specs`, `get_canonical`, `plan_briefing` mid-session

## Commands

| Command | Description |
|---------|-------------|
| `skald init [dir]` | Create `.skaldrc.json` config |
| `skald build` | Index spec files into SQLite + embeddings |
| `skald search <query>` | Semantic search over specs |
| `skald lint` | Check for conflicts (dual-current, orphan refs) |
| `skald spec new <product> <subsystem>` | Scaffold a new spec file |
| `skald plan list` | Show all project plans |
| `skald plan add <product> "<title>"` | Create a plan |
| `skald plan phase <product> <n> "<title>"` | Add a phase |
| `skald plan status <product> <n> <status>` | Update phase status |
| `skald plan briefing <product> <n>` | Generate build briefing |
| `skald session start <product> <n>` | Start a tracked build session |
| `skald session end <id> --notes "..."` | End session with notes |
| `skald watch` | Watch for spec changes, re-index live |
| `skald live [--port 18803]` | Start live dashboard server |
| `skald dashboard` | Generate static HTML dashboard |
| `skald serve` | Start MCP server (stdio, for Claude Code) |

## Configuration

Create `.skaldrc.json` in your home directory or project root:

```json
{
  "specDirs": ["/path/to/your/specs"],
  "dbPath": "/path/to/skald.db"
}
```

Or use environment variables:
- `SKALD_SPEC_DIR` — spec directory path
- `SKALD_DB_PATH` — database file path
- `OPENAI_API_KEY` — for embedding generation

## Spec Frontmatter

Skald reads YAML frontmatter from markdown files:

```yaml
---
title: "My Spec Title"
product: myproduct
subsystem: auth
status: current          # current | superseded | draft | completed | review
source_type: spec        # spec | build-progress | concept | review
version: 2
supersedes: "auth-v1.md"
date: 2026-04-12
---
```

## MCP Server (Claude Code)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "skald": {
      "command": "node",
      "args": ["/path/to/skald/dist/index.js", "serve"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

Tools available: `search_specs`, `get_canonical`, `lint_specs`, `plan_briefing`, `plan_status`, `plan_notes`, `session_start`, `session_end`

## Built With

Node.js, TypeScript, sql.js, OpenAI embeddings, MCP SDK
