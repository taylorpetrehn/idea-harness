---
description: Flip one idea's status to rejected. Archived, not deleted.
argument-hint: "<slug>"
allowed-tools: ["Bash"]
---

Run `harness ideas reject $1` and present the output. The verb flips the idea's status to `rejected`, sets `decided_at` to now, and appends a Notes entry explaining the rejection. The idea.md file is left on disk under `~/.claude/plans/specs/$1/` — terminal statuses are searchable context, never deleted.

If the user wants to explain the rejection, prompt them for a reason and re-run with `--note "<reason>"`.
