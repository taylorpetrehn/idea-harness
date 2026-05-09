<!-- This file is read at the start of every Claude Code session launched in
     ~/Projects/idea-harness/. Keep it short and specific to this repo's role
     in the harness pipeline. -->

# This is the idea-harness Mac launch workspace

This repo is the launch point for the harness pipeline. **Nothing in this directory
is a runtime** — the live system is at:

- `~/.claude/skills/idea-harness/` — the operational skill (SKILL.md, references, scripts)
- `~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-{harvest,brainstorm,escalate}.plist` — the cron
- `~/.claude/plans/specs/<slug>/idea.md` — per-idea state

This repo's `.claude/hooks/` are the operator-control primitives (kill-switch, steer,
verify-gate, track-read, commit-on-stop) that long-running Claude sessions inherit when
they `cd` here at startup. They run regardless of who launched the session.

## If you're a Claude session that just launched here

You were probably spawned by one of:

1. **`escalate-needs-detail.py`** — to walk Taylor through an open question on a
   `needs-detail` idea via Remote Control on his phone. Your seed prompt names a
   specific `idea.md` to read; do that, summarize the open question, walk through
   the variants, take Taylor's decision, write `## Decision` + flip status to
   `brainstormed` in a single Edit call, then exit.

2. **`brainstorm-captured.py`** — to brainstorm captured ideas in batch. You're
   running with `--print` (autonomous). Read `~/.claude/skills/idea-harness/SKILL.md`
   and follow steps 2–5 of the flow.

3. **The build flow (manual or future autonomous)** — to graduate an `accepted` idea
   into a PR in a target repo. You should `cd` into the target repo's worktree and
   work there, not here.

4. **Taylor working interactively** — to inspect, debug, or extend the harness itself.
   Read [README.md](../README.md) for the system overview.

## Conventions

- Read `README.md` and the relevant idea.md before doing real work.
- The harness's hooks (`.claude/hooks/`) will fire on Write/Edit. The verify-gate is
  configured for screenshot-based UI evidence — irrelevant to the harness itself, so
  edits to scripts/templates/docs in this repo are unaffected.
- If you need to halt yourself, `touch AGENT_STOP` in this directory. To leave
  steering for the next session, `echo "..." > STEER.md`.

## What lives where

```
README.md                  ← system overview, full setup + onboarding docs
templates/                 ← drop-in resources for new-Mac install + new-repo onboarding
  launchagents/            ← .plist files for the three cron jobs
  hooks/                   ← safety-check.sh (global PreToolUse Write/Edit guard)
  commands/                ← inflight.md (the /inflight slash command)
  skill-scripts/           ← copies of the canonical scripts in case ~/.claude is wiped
  repo/                    ← .harness/config.json + CLAUDE.md to drop into onboarded repos
.claude/                   ← hooks + agents that fire on sessions launched in this dir
SKILL.md                   ← redirect note (canonical SKILL.md is in ~/.claude/skills/idea-harness/)
```

The historical Node CLI source (bin/, contracts/, context/, references/, scripts/agents,
scripts/commands, scripts/lib, ideas/, runs/, state/, proposals/, node_modules) is
preserved at git tag `archive/v2-alpha`. None of it executes at HEAD; remove on disk
when you're confident you no longer need it as a reference.
