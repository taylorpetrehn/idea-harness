---
description: List all ideas in ~/.claude/plans/specs/ grouped by status (awaiting-review first)
argument-hint: ""
allowed-tools: ["Bash"]
---

Run `harness ideas list` and present the output verbatim. If `harness` is not on PATH (i.e. the CLI hasn't been installed yet on this machine), fall back to `~/.claude/skills/idea-harness/scripts/inflight.sh`. If anything is in `awaiting-review`, `needs-critic-review`, or `needs-detail`, surface it as the first thing the user should look at. If the list is empty, say so plainly.
