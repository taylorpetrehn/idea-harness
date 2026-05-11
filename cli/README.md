# harness-cli

Python CLI + MCP surface for the [idea-harness skill][skill]. Implements Phase 2 of [the bridge plan](../docs/bridge-plan.md):

> Stop treating `idea.md` frontmatter as a private contract. Wrap it in a CLI any UI can drive, and expose it to Claude Code via MCP + slash commands.

The filesystem (`~/.claude/plans/specs/<slug>/idea.md`) stays canonical. The CLI just makes the verbs first-class.

## Install

```bash
pip install -e cli/
# now `harness` is on PATH
```

No third-party runtime deps. Python ≥ 3.10. (Tests need `pytest`; install with `pip install -e cli/[test]`.)

## Verbs

```text
harness ideas list [--status X] [--project Y] [--score-gte N] [--json]
harness ideas show <slug> [--json]
harness ideas accept <slug>
harness ideas reject <slug>
harness ideas reroute <slug> <project>
harness ideas brainstorm <slug>     # manual trigger of brainstorm-captured.py
harness ideas build <slug>          # manual trigger of build-accepted.py for one idea
harness capture "<title>" [--project X] [--notes "..."]
harness init-harness [<repo-path>]  # interactive .harness/config.json scaffold
harness reindex                     # rebuild ~/.claude/plans/index.sqlite from disk
harness reconcile                   # poll pr-open ideas, update status from GitHub
harness mcp serve                   # JSON-RPC 2.0 stdio MCP transport
```

Every write goes through `idea.md` first, then the SQLite index. `harness reindex` is the recovery path if the index drifts.

## Architecture

```
~/.claude/plans/specs/<slug>/idea.md   ← canonical, filesystem-of-truth
                ↑
                │  reads + atomic frontmatter rewrites
                │
        harness.state.Idea ←─ harness.commands.* ←─ harness/__main__.py (argparse)
                                   ↑
                                   ├── harness.commands.mcp_server (stdio JSON-RPC)
                                   └── ~/.claude/commands/{inflight,idea-*}.md (thin shims)

~/.claude/plans/index.sqlite           ← derived cache, rebuildable by `harness reindex`
```

- **`harness/state.py`** — `Idea` dataclass, frontmatter parser/writer, atomic writes.
- **`harness/projects.py`** — reads `~/.claude/skills/idea-harness/references/projects.yml`.
- **`harness/index.py`** — SQLite mirror. Optional speedup; not required for correctness.
- **`harness/commands/*`** — one file per verb (or verb cluster).
- **`harness/mcp_server.py`** — JSON-RPC 2.0 stdio transport that re-exposes the same verbs as MCP tools.

## MCP + slash commands

`harness mcp serve` speaks MCP over stdio. Add it to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "idea-harness": { "command": "harness", "args": ["mcp", "serve"] }
  }
}
```

Claude Code will list the same verbs as MCP tools. Slash commands at `~/.claude/commands/{inflight,idea-accept,idea-reject,idea-build,idea-search,harness-init}.md` are thin wrappers that shell out to `harness ...` and present the output.

## Tests

```bash
cd cli/
pytest -q
```

Tests target frontmatter parsing, slugification, index round-trips. The
network-touching commands (`brainstorm`, `build`, `reconcile`) are not
unit-tested — they shell out to existing skill scripts and `gh`.

## Status

Phase 2 ships the CLI + stdio MCP. Phase 3 adds the HTTP+Tailscale MCP listener for the mobile app and rewrites cron scripts to call `harness` verbs for status updates.

[skill]: https://github.com/taylorpetrehn/idea-harness
