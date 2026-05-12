# OpenClaw → idea-harness Merge

This is the canonical migration record for Phase 1 of [bridge-plan.md](bridge-plan.md):
the consolidation of the OpenClaw `idea-pipeline` runtime into the idea-harness
skill. After this phase, **idea-harness is the only orchestrator** and
`~/.openclaw/` is either deleted or kept on disk as a frozen archive.

## Why merge

Two orchestrators ran in parallel:

- **idea-harness** — this repo + `~/.claude/skills/idea-harness/` + four
  LaunchAgents, state in per-idea `~/.claude/plans/specs/<slug>/idea.md`.
- **OpenClaw idea-pipeline** — `~/.openclaw/workspace-bonnie/` + cron jobs +
  the `idea-pipeline` skill under `~/.openclaw/.claude/skills/`, state in
  `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl`.

Both claimed authority over the same workflow (idea → spec → build → PR →
review). Documentation in `LetsBarker/docs/orchestration-architecture.md`
pointed at OpenClaw; the actual cron + most-recent code lives in idea-harness.

The bridge plan resolves this: **idea-harness absorbs OpenClaw**. Worth noting
that almost everything OpenClaw's pipeline did has already been reimplemented
in idea-harness (filesystem state, harvest cron, brainstorm cron, build cron,
worktree-aware spawn). The remaining gaps — addressed in this PR — are:

1. The 4-reviewer gauntlet (spec-fidelity, codebase-patterns, risk, ux) that
   runs after each PR opens.
2. A confidence that no live `ideas.jsonl` work is being lost on the way out.
3. Docs in LetsBarker still pointing at OpenClaw.

## What moves over

| OpenClaw artifact | New home in idea-harness | Notes |
|---|---|---|
| `~/.openclaw/.claude/skills/idea-pipeline/review-gauntlet.md` | `templates/skill-scripts/review-gauntlet.py` (installs to `~/.claude/skills/idea-harness/scripts/review-gauntlet.py`) | Ported from prose-for-orchestrator into a Python entry point that spawns 4 parallel `claude --print` subagents. |
| `~/.openclaw/.claude/agents/idea-pipeline/{spec-fidelity,codebase-patterns,risk,ux}.md` | `templates/skill-scripts/review-rubrics/{spec-fidelity,codebase-patterns,risk,ux}.md` (installs to `~/.claude/skills/idea-harness/references/review-rubrics/`) | Each reviewer's system prompt — read by `review-gauntlet.py` and concatenated into each subagent spawn. |
| `~/.openclaw/workspace-bonnie/skills/idea-to-pr/references/projects.yml` | `references/projects.yml` (already at `~/.claude/skills/idea-harness/references/projects.yml`) | The canonical idea-harness `projects.yml` is already a superset — has `letsbarker`, `openclaw` (was `clawd`), `rewilding`, plus `tooter` which OpenClaw never had. No re-merge needed. |
| `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl` (140 records) | One-shot migration → no-op for ideas in terminal states (`completed`, `cancelled`, `closed_duplicate`, `spec_pr_created`, etc.); per-idea `idea.md` files for any non-terminal records | Script: `templates/skill-scripts/migrate-from-openclaw.py`. Snapshot at HEAD shows ALL records in terminal states — no live work to move. Script is idempotent so it can run again pre-deletion. |

## What dies

| OpenClaw artifact | Disposition |
|---|---|
| `~/.openclaw/.claude/skills/idea-pipeline/` (skill + sub-skills + rubrics) | Superseded by `~/.claude/skills/idea-harness/`. Leave on disk one rollback cycle, then delete. |
| `~/.openclaw/.claude/agents/idea-pipeline/` (4 reviewer agents + runtime-evaluator + spec-evaluator) | The 4 reviewers move (see table above). `runtime-evaluator` and `spec-evaluator` are deferred — they are not part of Phase 1 and may not return at all if the simpler gauntlet covers the same ground. |
| OpenClaw `idea-pipeline` cron jobs (in `~/.openclaw/cron/` or equivalent) | Disabled via `templates/skill-scripts/openclaw-disable.sh`. The script unloads launchd plists and lists what got disabled so a future operator can confirm. |
| `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl` | Kept after migration as `ideas.jsonl.archived-<date>` for one rollback cycle, then deleted with the rest of `~/.openclaw/`. |
| OpenClaw webhook-trigger workflows (`agent-ready-trigger.yml.disabled`) | Stay disabled. Phase 4 will resurrect a single replacement that points at `harness mcp serve`. |

## What's already done (in idea-harness, no port needed)

The reason the merge surface is so small: idea-harness already implements most
of what OpenClaw did, often more cleanly. These do **not** need porting:

- **Harvest from Apple Reminders** — `harvest.py` in idea-harness (vs. OpenClaw's
  triage flow).
- **Confidence scoring + routing** — Step 2 in idea-harness `SKILL.md`. Maps
  cleanly to OpenClaw's `confidence_score` / `confidence_tier`.
- **Brainstorm + critic separation** — Steps 3–4 in idea-harness `SKILL.md` with
  a fresh subagent for the critic. Replaces OpenClaw's spec-evaluator agent.
- **Worktree-aware build** — `build-accepted.py` in idea-harness already does
  worktree creation, bot identity setup, builder spawn, PR parsing.
- **Per-project context resolution** — already implemented; falls back from
  repo-side `.harness/{decisions,conventions}.md` to harness-side
  `references/context/{project}/`.
- **`/inflight` slash command** — already present.

## What's deferred (not Phase 1)

- **Runtime evaluator** — OpenClaw's `runtime-evaluator` agent (Layer 2 of the
  gauntlet: spin up an eval worktree, run the test suite, verify acceptance
  criteria). This belongs with Phase 3's `worktree-runner.sh` primitive; the
  bridge-plan's Phase 3 evaluator pattern (`evidence.evaluators[*]`) supersedes
  it.
- **Spec evaluator** — Already absorbed into idea-harness's critic step. The
  separate agent isn't worth keeping.
- **Auto-fix loop after gauntlet** — OpenClaw's gauntlet would spawn a fresh
  builder to address review comments and re-run reviewers up to 3 times. Phase
  1's `review-gauntlet.py` posts the consolidated review as a PR comment and
  stops there — Taylor (or a manual `/idea-build` re-trigger) drives the next
  step. The auto-fix loop will come back in Phase 2 once the CLI exists to
  orchestrate it cleanly.

## How `review-gauntlet.py` works

```
build-accepted.py builder spawn
  └─ prints PR_URL=https://github.com/.../pull/N
       └─ on success, build-accepted.py invokes:
            review-gauntlet.py --pr <N> --repo <slug> --spec <path> --idea-slug <slug>
              ├─ Layer 0: gh pr checks → wait up to 5 min for pending; fail fast on any failed required check
              ├─ Layer 1: 4 parallel claude --print subagents (spec-fidelity, codebase-patterns, risk, ux*)
              │            *ux only spawned if PR touches files matching UI globs
              ├─ Aggregate JSON verdicts → single Markdown summary
              └─ gh pr comment with the summary; write spec-dir/review.json for record-keeping
```

The script does NOT auto-merge, NOT auto-fix, NOT re-loop. It just runs the
review and reports back. That's a deliberate scope cut from OpenClaw's version
to keep Phase 1 minimal and avoid resurrecting the complexity that motivated
the consolidation.

## Verification (Phase 1 gates)

The bridge plan's verification checklist for Phase 1:

- [ ] `launchctl list | grep -E '(openclaw|idea-pipeline)'` returns empty after running `openclaw-disable.sh`.
- [ ] `find ~/.claude/plans/specs -name idea.md | wc -l` ≥ pre-migration `ideas.jsonl` non-terminal record count (currently 0 — all terminal). Idempotent re-run of `migrate-from-openclaw.py` is a no-op.
- [ ] A captured idea reaches `pr-open` end-to-end with `review-gauntlet.py` posting a PR comment.
- [ ] `README.md` and `LetsBarker/docs/orchestration-architecture.md` agree on what's canonical (idea-harness).

## Rollback

If something breaks after this PR merges and a rollback is needed:

1. `git revert <this-PR>` in idea-harness.
2. Re-enable OpenClaw cron: `launchctl load ~/.openclaw/cron/<plist>`
   (paths printed by `openclaw-disable.sh` on the way out — check the script's
   output log).
3. `~/.openclaw/` is intentionally left intact for one rollback cycle. No data
   should have been lost.

Once a rollback window passes (suggest one week of observation), follow up
with a destructive PR that:

- Deletes `~/.openclaw/.claude/skills/idea-pipeline/` and `~/.openclaw/.claude/agents/idea-pipeline/`.
- Moves `~/.openclaw/workspace-bonnie/data/idea-pipeline/` to a backup tarball or deletes it.
- Optionally archives the whole `~/.openclaw/` if the rest of OpenClaw's
  workspaces (bonnie's R365/Square automations, coder workspace, mailroom) have
  also been retired or migrated independently. Those are out of scope for this
  PR.
