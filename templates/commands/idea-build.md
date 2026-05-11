---
description: Manually trigger build-accepted.py for one idea (skip the cron wait).
argument-hint: "<slug>"
allowed-tools: ["Bash"]
---

Run `harness ideas build $1`. The verb sets `HARNESS_TARGET_SLUG` and spawns the build orchestrator (`build-accepted.py`) for that one idea instead of letting the cron pick the oldest. Present the output as it streams. If the orchestrator exits non-zero, look at `~/.claude/skills/idea-harness/logs/build.log` and the idea's `## Notes` section for the failure reason.

The idea must be at `status: brainstormed` (or `accepted`/`needs-detail` if you want to override the gate). If it's not, the verb refuses with a clear error.
