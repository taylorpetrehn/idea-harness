---
description: List all ideas in ~/.claude/plans/specs/ grouped by status (awaiting-review first)
argument-hint: ""
allowed-tools: ["Bash"]
---

Run `~/.claude/skills/idea-harness/scripts/inflight.sh` and present the output verbatim. If anything is in `awaiting-review`, `needs-critic-review`, or `needs-detail`, surface it as the first thing the user should look at. If the list is empty, say so plainly.
