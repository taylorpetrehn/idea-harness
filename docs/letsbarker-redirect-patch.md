# LetsBarker sibling-PR redirect patch

Phase 1 of the bridge plan touches three docs in the **LetsBarker** repo
(`BarkerEnterprises/LetsBarker`). Those edits must land in a sibling PR
there because LetsBarker is a separate git remote. This file is the
checklist + exact diff for that sibling PR.

When idea-harness's Phase 1 PR merges:

1. `cd ~/Projects/PrimaryBarker/LetsBarker`
2. `git checkout -b chore/orchestrator-redirect-to-idea-harness`
3. Apply the edits below.
4. Open a PR targeting `preview` (LetsBarker's integration branch).

## docs/orchestration-architecture.md — banner at the top

Insert immediately after line 1 (`# Orchestration Architecture`):

```markdown
> **Redirect — 2026-05.** The orchestrator is now
> [`taylorpetrehn/idea-harness`](https://github.com/taylorpetrehn/idea-harness)
> + the canonical skill at `~/.claude/skills/idea-harness/`. OpenClaw's
> `idea-pipeline` skill and `ideas.jsonl` have been retired. See
> [idea-harness/docs/openclaw-merge.md](https://github.com/taylorpetrehn/idea-harness/blob/main/docs/openclaw-merge.md)
> for the move record. The content below remains for historical context;
> for current orchestrator behavior, read the canonical SKILL.md.
```

The rest of the document can stay; consider it historical. A follow-up PR
can rewrite the body to reflect the idea-harness flow if anyone tries to
use the doc for navigation and gets confused.

## WORKFLOW.md — update orchestrator references

Wherever the doc names OpenClaw / `~/.openclaw/` / `idea-pipeline` as the
orchestrator, swap for idea-harness / `~/.claude/skills/idea-harness/` /
`/inflight`. Likely diff:

| Search for | Replace with |
|---|---|
| `OpenClaw idea-pipeline skill` | `idea-harness skill (~/.claude/skills/idea-harness/)` |
| `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl` | `~/.claude/plans/specs/<slug>/idea.md` |
| `agent:ready` (as a label-driven webhook trigger) | leave it (still the same label) but update the doc to say the webhook is currently disabled and idea-harness's harvest cron picks the issues up via `gh issue list --label 'agent:ready'` (Step 1 Source B in the canonical SKILL.md) |

## AGENTS.md — point at idea-harness for orchestration

Wherever the doc describes "the orchestrator" or "the idea pipeline,"
replace with a short paragraph:

> Orchestration lives in
> [`taylorpetrehn/idea-harness`](https://github.com/taylorpetrehn/idea-harness).
> The canonical SKILL is at `~/.claude/skills/idea-harness/SKILL.md`.
> Harvest, brainstorm, escalate, and build run on LaunchAgents owned by
> idea-harness; the four-reviewer gauntlet runs from
> `~/.claude/skills/idea-harness/scripts/review-gauntlet.py` after each
> PR opens.

## Verification

After the sibling PR merges:

- Re-read `docs/orchestration-architecture.md` from the top and confirm
  the redirect banner is the first thing a reader sees.
- `grep -rn 'openclaw\|idea-pipeline' WORKFLOW.md AGENTS.md` returns no
  current-tense references — only historical mentions.
- `gh pr list --label agent:ready` in LetsBarker still surfaces issues
  for idea-harness's Source-B harvester (nothing about the label itself
  changes; only the orchestrator that reacts to it).
