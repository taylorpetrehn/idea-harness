# Idea Harness

A purpose-built harness that turns half-formed thoughts into real pull
requests, end-to-end. Six layers: capture (Apple Reminders), brainstorm
(Claude Opus), validate (deterministic schema + Claude Haiku critic),
review (conversational, in Claude), graduate (Claude Code spawned in the
target repo, opens a PR).

This is **the** idea system — there is no separate build pipeline. The
brainstorm IS the spec. `npm run graduate <slug>` hands an accepted idea
to a fresh Claude Code session inside the target repo's working directory
and lets it explore the codebase, implement the chosen variant on a
feature branch, and open the PR.

## Quick Start

```bash
# 1. Seed your product context from the templates
cp context/product.example.md   context/product.md
cp context/decisions.example.md context/decisions.md
$EDITOR context/product.md context/decisions.md   # fill them in

# 2. Install deps
npm install

# 3. Run a full harness pass: harvest reminders → brainstorm → schema + critic
npm run garden

# 4. Review ideas conversationally in Claude (mobile or desktop)
#    Just ask: "What ideas are waiting for me?"
#    Or hit the CLI directly:
npm run waiting

# 5. Ship the next eligible idea — no slug needed.
#    Picks the newest accepted (or auto-accepts a brainstormed one),
#    or resumes a `building` idea whose previous session didn't reach PR.
npm run ship

# Equivalent step-by-step if you want explicit control:
npm run review accept <slug>     # mark accepted
npm run graduate <slug>          # spawn Claude in target repo, open PR
npm run resume <slug>            # recover a stuck `building` idea

# Slugs accept a unique prefix or substring, so `npm run resume dm-cohorts`
# resolves to the long capture as long as it's unambiguous.

# 6. Track in-flight work
npm run review in-flight    # shows accepted / building / pr-open
npm run inspect             # rolling metrics + last-run summary

# 7. Build sessions stream live to runs/<id>/build-<slug>.log.
#    The path is printed when graduate/ship/resume starts — `tail -f` it.

# 8. Cleanup worktrees for shipped ideas (dry-run by default)
npm run cleanup             # shows what would be removed
npm run cleanup -- --apply  # actually remove
```

## Worktrees

Builds happen in a git worktree, never in your primary checkout. Default
location: `<repo-parent>/<repo-basename>-worktrees/<branch-flat>`. So a
build of `idea/dm-cohorts-d2e3` against the LetsBarker repo lands in
`~/Projects/PrimaryBarker/LetsBarker-worktrees/idea-dm-cohorts-d2e3`.
Override the parent dir with `IDEA_HARNESS_WORKTREE_DIR`.

This means:
- You can keep working in your primary checkout while a build runs.
- Concurrent builds (`npm run graduate -- --all`) don't trample HEAD.
- Crashes leave the worktree dirty, not your repo. `npm run resume <slug>`
  picks the worktree back up where the prior session left off.
- After a PR merges, run `npm run cleanup -- --apply` to delete worktrees
  for shipped ideas. Nothing's deleted automatically.

> `context/product.md` and `context/decisions.md` are gitignored on purpose —
> they describe your specific product and usually contain internal details
> the rest of the repo doesn't need to know about. The shipped templates
> (`*.example.md`) tell you what to put where.

## Architecture at a Glance

```
TRIGGERS (manual / event / conversational)
   ↓
CONTROL — initializer plans the run
   ↓
CONTEXT — Tier 1 always, Tier 2/3 on request, with token budget
   ↓
EXECUTION — brainstormer produces output (fresh context per idea)
   ↓
VERIFICATION — deterministic schema check, then LLM critic
   ↓
STATE — durable artifacts in ideas/ and runs/
   ↓
REVIEW — Taylor reacts conversationally → accept / reject / needs-more-thought
   ↓
BUILD — `npm run graduate` spawns Claude Code in the target repo, opens a PR
```

See `SKILL.md` for the full design and `contracts/` for the machine-checkable
output contracts at each handoff.

## File Layout

```
idea-harness/
  SKILL.md                          ← full design and contracts
  README.md                         ← this file
  ideas/<slug>.md                   ← work product, one per idea
  context/
    product.example.md              ← template; copy to product.md (gitignored)
    decisions.example.md            ← template; copy to decisions.md (gitignored)
  contracts/
    brainstorm-output.md            ← required brainstorm structure
    critic-rubric.md                ← critic's pass/fail criteria
    context-budget.md               ← Tier 1/2/3 + token caps
    handoff-to-build.md             ← what idea-to-pr expects
  references/
    idea-schema.md                  ← idea file frontmatter + body
  scripts/
    garden.ts                       ← orchestrator (capture → review)
    graduate.ts                     ← orchestrator (accepted → PR)
    ship.ts                         ← "do the next thing" — picks an idea, ships it
    resume.ts                       ← recover a stuck `building` idea
    cleanup.ts                      ← remove worktrees for shipped ideas
    review.ts                       ← conversational review CLI helpers
    inspect.ts                      ← view latest run + metrics
    agents/
      initializer.ts                ← L2: plans the run
      harvester.ts                  ← Reminders → raw idea files
      brainstormer.ts               ← L4: brainstorms one idea
      critic.ts                     ← L5: gates output (qualitative)
      builder.ts                    ← L6: spawns claude in worktree, opens PR
    lib/
      ideas.ts                      ← idea file read/write
      runs.ts                       ← run lifecycle
      context.ts                    ← Tier 1/2/3 loading
      schema.ts                     ← deterministic brainstorm schema check
      worktree.ts                   ← git worktree lifecycle for builds
      graduator.ts                  ← shared worker for graduate/ship/resume
      slug.ts                       ← permissive slug matching
      llm.ts                        ← model adapters
      reminders.ts                  ← Reminders MCP adapter
      loops.ts                      ← loop detection
      projects.ts                   ← project routing
      budgets.ts                    ← token budget policy
      text.ts                       ← slugify, fuzzy match
      log.ts                        ← stderr logger
      metrics.ts                    ← rolling counters
  runs/                             ← per-run artifacts (auto-generated)
  state/                            ← rolling metrics (auto-generated)
```

## What's Wired Up

The scaffold ships with all adapters fully implemented — `npm run garden:dry`
runs end-to-end without code changes. What you do still need is the
*environment* the harness runs in:

- `lib/reminders.ts` — talks to Apple Reminders via `osascript`. Set
  `IDEA_HARNESS_REMINDERS=dry` to disable (used in tests / non-mac envs).
- `lib/projects.ts` — parses `~/.openclaw/workspace-bonnie/skills/idea-to-pr/references/projects.yml`
  by default. Override the path with `IDEA_HARNESS_PROJECTS_YML`.
- `lib/context.ts` — Tier 2 codebase reads resolve to the project's
  `local_path` from `projects.yml`. Override per-project with
  `IDEA_HARNESS_REPO_LETSBARKER`, `IDEA_HARNESS_REPO_CLAWD`, etc.
- `lib/llm.ts` — three transports, picked at runtime:
  - **SDK** when `ANTHROPIC_API_KEY` is set — uses `@anthropic-ai/sdk`
    (an *optional* dependency; install with `npm install` since it's
    declared in `optionalDependencies`).
  - **Claude CLI** otherwise — shells out to `claude --print --model <m>
    --system-prompt <s> --output-format json`, using whatever auth the
    CLI already has (subscription / OAuth / keychain). Force this mode
    with `IDEA_HARNESS_LLM=cli`. Token counts are parsed from the JSON.
  - **Offline** stub via `IDEA_HARNESS_LLM=offline` — deterministic
    output for tests.

  Model IDs are env-configurable: `IDEA_HARNESS_BRAINSTORMER_MODEL`,
  `IDEA_HARNESS_CRITIC_MODEL`. CLI binary path:
  `IDEA_HARNESS_CLAUDE_BIN`. Per-call timeout: `IDEA_HARNESS_CLAUDE_TIMEOUT_MS`
  (default 300000).
- `agents/brainstormer.ts` — round-trips Tier 2 context_request emissions
  back to the model up to `IDEA_HARNESS_TIER2_MAX_REQUESTS` (default 3).

For real runs: set `ANTHROPIC_API_KEY`, ensure the Reminders app has a list
called "App Ideas", then `npm run garden`.

## Environment Variables

| Var | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | API key — picks the SDK transport when set | — (CLI transport) |
| `IDEA_HARNESS_LLM` | `sdk` / `cli` / `offline` — force a transport | auto |
| `IDEA_HARNESS_CLAUDE_BIN` | path to the `claude` binary | resolved on PATH |
| `IDEA_HARNESS_CLAUDE_TIMEOUT_MS` | per-CLI-call timeout | 300000 |
| `IDEA_HARNESS_BUILDER` | `live` / `offline` / `dry` — builder mode | `live` |
| `IDEA_HARNESS_BUILDER_TIMEOUT_MS` | builder session timeout | 1800000 (30 min) |
| `IDEA_HARNESS_WORKTREE_DIR` | parent dir for build worktrees | `<repo-parent>/<repo>-worktrees` |
| `IDEA_HARNESS_REMINDERS` | `dry` to skip Apple Reminders | live on macOS |
| `IDEA_HARNESS_BRAINSTORMER_MODEL` | brainstormer model id | `claude-opus-4-7` |
| `IDEA_HARNESS_CRITIC_MODEL` | critic model id | `claude-haiku-4-5-20251001` |
| `IDEA_HARNESS_PROJECTS_YML` | path to `projects.yml` | idea-to-pr default |
| `IDEA_HARNESS_REPO_<KEY>` | repo path override per project | from `projects.yml` |
| `IDEA_HARNESS_PER_IDEA_TARGET` | soft token target per brainstorm | 10000 |
| `IDEA_HARNESS_PER_RUN_CAP` | hard run-level token cap | 100000 |
| `LOG_LEVEL` | `silent`, `error`, `warn`, `info`, `debug` | `info` |

## Why This Shape

Six principles drove the design:

1. **The harness is the product, not the model.** Swapping Claude versions
   should change quality, not break the system.
2. **Subtraction over addition.** Each agent sees minimum context.
3. **Fresh context beats compaction.** Each idea gets a clean window.
4. **Durable artifacts over conversation history.** Files are the truth.
5. **Human at the right gate, exactly once.** Conversational review.
6. **Honesty over enthusiasm.** Critic explicitly checks for hand-wavy output.
