# Conventions for this project

> Project-agnostic harness conventions. Machine-readable shape is in
> `.harness/config.json`; this file is the human-readable companion.
> Read both at the start of every session.

## First-time setup in a new repo

If `.harness/config.json` was just copied from the template, it's still
filled with LetsBarker values. Before doing real work in this repo:

1. **Read the existing config.json.** Note which fields look right and
   which are stubs from the template.
2. **Update these fields for THIS repo** (no auto-detection — humans/agents
   fill them in once, deliberately):
   - `name` — short slug for this repo
   - `identity.github_repo`, `identity.local_path`
   - `vcs.base_branch` (often `main`, sometimes `develop` / `preview`)
   - `vcs.uses_worktrees`, `vcs.worktree_pattern`, `vcs.bot.*`
   - `stacks` — declared, not detected. Common values: `rails`, `expo`,
     `vite`, `python`, `rust`, `next`, `static`. Multi-stack repos list
     several.
   - `commands` — the actual shell commands for this repo's smoke test,
     test suite, lint, dev server. Verify each one runs cleanly before
     committing the config.
   - `evidence.evaluators` — one entry per stack; `when_touched` patterns
     should match this repo's directory layout.
   - `safety.*` — **all optional**. Add entries only for files this repo
     genuinely needs guarded. Empty/missing fields are no-ops.
3. **If you're an agent stamping a new repo**, propose the updated
   config.json to the user before writing it. Don't guess paths the human
   will care about getting right (bot PAT files, base branches).

## Always start here

1. **Read `.harness/config.json`.** It defines the shape of this repo:
   stacks, commands, evidence patterns, safety guardrails.
2. **Read `PROGRESS.md`.** It's the handoff from the previous session.
   If it doesn't exist, create it with four empty sections: `## Done`,
   `## In progress`, `## Next`, `## Notes`.
3. **Run `git log --oneline -10`** to see what was just committed.
4. **Run the smoke command** from `commands.smoke` in config.json to
   confirm you're starting from a working tree.
5. **Read project context** from the global idea-harness skill:
   - `~/.claude/skills/idea-harness/references/context/{name}/conventions.md`
   - `~/.claude/skills/idea-harness/references/context/{name}/product.md`
   - `~/.claude/skills/idea-harness/references/context/{name}/decisions.md`

   where `{name}` is `.harness/config.json:name`. These are the canonical
   conventions, decisions, and product context. Don't paraphrase them.
6. **Read** `~/.claude/skills/idea-harness/references/simplicity-rules.md`
   and `branch-hygiene.md` — non-negotiable across every project.

## One feature at a time

Work on exactly one item per session. Finish it (tests passing, evidence
verified) before starting another. If the user adds a new task mid-session,
note it in PROGRESS.md and finish the current item first.

## Proof before passing

A test only "passes" after you have:

1. Run the right evaluator from `.harness/config.json:evidence.evaluators`
   for the files you touched (the `when_touched` glob tells you which).
2. Opened the resulting screenshot or `results-*.json` with the Read tool.
3. Confirmed it shows what it should.

The `verify-gate` hook denies writes to `evidence.results_file` until
you've Read evidence matching `evidence_patterns`. Do not work around it.

## Safety surface

`.harness/config.json:safety` is **entirely optional**. Any subkey may be
absent or empty; missing entries are no-ops at the hook level. When
present, they mean:

- **`must_not_touch`** — hard block at Write/Edit. If you genuinely need
  to change one of these, escalate to the human. They may temporarily
  remove the entry from config.json.
- **`require_human_review_when_touching`** — soft block. The hook will
  refuse the first attempt and tell you to ask the user. Once the user
  approves, run:
  ```bash
  mkdir -p .harness && touch .harness/.allow-once
  ```
  Then retry the edit. The bypass is consumed after one write.
- **`never_force_push_branches`** — never `--force` push to these.
- **`always_label_pr`** — every PR you open gets these labels appended.

If a repo has no safety section at all, the safety hook is a no-op — it
won't block anything. Add entries only when you actually want them
enforced.

## Keep PROGRESS.md current

After each completed item, update PROGRESS.md: check off what's done,
add what you learned, note what's next. Future sessions read this file
cold.

## Commit often

The Stop hook commits tracked changes at session end. Also `git add` new
files and commit yourself at meaningful checkpoints with descriptive
messages. Use `commands.lint` from config.json before commits if it's
defined.

## If you're told to stop

`OPERATOR STEERING:` messages come from a human via the steer hook.
Treat them as higher priority than your current plan.
