# Idea Harness

A purpose-built harness that turns half-formed thoughts into real pull
requests, end-to-end. Six layers: capture (Apple Reminders), brainstorm
(Claude Opus), validate (deterministic schema + Claude Haiku critic),
review (conversational, in Claude), graduate (Claude Code spawned in the
target repo, opens a PR).

This is **the** idea system — there is no separate build pipeline. The
brainstorm IS the spec. `harness build <slug>` hands an accepted idea
to a fresh Claude Code session inside the target repo's working directory
and lets it explore the codebase, implement the chosen variant on a
feature branch, and open the PR.

## Quick Start

```bash
# 1. Seed your product context from the templates
cp context/product.example.md   context/product.md
cp context/decisions.example.md context/decisions.md
$EDITOR context/product.md context/decisions.md   # fill them in

# 2. Install deps and link the binary
npm install
npm link             # makes `harness` available on PATH

# 3. Verify your environment
harness doctor

# Optional: run the dashboard smoke suite (16 suites, ~33s)
npm test             # full suite
npm run test:quick   # skip the long build-spawn smoke (~2s)
npm run check        # tsc + smokes (use before committing)

# 4. Open the dashboard — your home base.
harness                       # mission control (no args)
```

`harness` (no args) drops you into the interactive dashboard. From
there one keystroke captures a new idea (`c`), spawns a brainstorm /
ship run (`:`), or zooms into a live build (`enter` on an in-flight
row). See [Dashboard](#dashboard) below for the full keymap. The
underlying verbs are still available for scripts and agents:

```bash
# Equivalent CLI verbs (the dashboard runs these for you):
harness brainstorm                # harvest → brainstorm → critic
harness ship                      # do the next obvious thing
harness ideas waiting             # list ideas needing review
harness review accept <slug>      # mark accepted
harness build <slug>              # spawn Claude in target repo, open PR
harness resume <slug>             # recover a stuck `building` idea
harness build watch <slug>        # tail a live build session
harness review in-flight          # accepted / building / pr-open
harness inspect                   # rolling metrics + last-run summary
harness cleanup                   # remove worktrees for shipped ideas (dry)
harness cleanup --apply           # actually remove

# Slugs accept a unique prefix or substring, so `harness resume dm-cohorts`
# resolves to the long capture as long as it's unambiguous.
```

## Dashboard

`harness` (no args) is mission control for the agentic idea-to-PR
engine. Four zones, one cursor, every state visible at a glance:

```
┌─ harness · 0 in flight · 1 awaiting you · 2 today ───────────────┐
│ NEXT  ▲ event-ledger needs your call (medium · 90s)  [enter]     │
└──────────────────────────────────────────────────────────────────┘
  ◆ IN FLIGHT · 1
    ⠼ build · job-slug → job.title   letsbarker · 4m12s · 87 ev
      └ build.stdout 12 passed · opening PR
  ▲ AWAITING YOU · 1
  ▸ ▲ event-ledger                     letsbarker · medium · 2m ago
      problem  Operational knowledge locked in transient surfaces…
      variants 1. Event ledger only — append-only domain_events…
               2. Event ledger + MCP — same table plus MCP server…
               3. Full observability platform — pgvector + Stream…
      risks    ▲ "tracks/learns from all app behavior" too broad
               ▲ chat ingestion has Stream plan + privacy story
      build    simplest version (event ledger only)
  ✓ TODAY · 2
    11:24  Job slug → job.title              ↓💭✓◆★ PR #1290
    09:15  event-ledger                       ↓💭
```

**Zones**

- **NEXT** — single line, the obvious-next action computed via the
  same logic `harness ship` uses (newest accepted → newest building →
  newest brainstormed).
- **IN FLIGHT** — every active run (no `summary.json` yet). Each
  row tails its own `runs/<id>/events.ndjson` live; the trailing
  line shows the most recent event. Runs idle > 5 min are flagged
  `(stalled)` with a paused glyph.
- **AWAITING YOU** — brainstormed ideas needing a verdict. Selected
  row expands inline with the verdict, top variants, top risks, and
  the recommended build target — no `$EDITOR` trip needed.
- **TODAY** — rolling 24h activity collapsed by slug into a
  lifecycle trail (↓ captured · 💭 brainstormed · ✓ accepted · ◆
  build started · ★ PR open).

**Keymap**

| keys | action |
|---|---|
| `↑↓` `j` `k` | select row |
| `tab`        | jump to next zone |
| `g` `G`      | first / last row |
| `enter`      | (flight) zoom into watch TUI · (await) expand · (today) open idea |
| `a` `t` `r`  | accept / needs-more-thought / reject (await zone) |
| `b`          | build the selected accepted idea |
| `o`          | open idea file in `$EDITOR` |
| `c`          | inline capture — type a title, Enter to save |
| `:`          | run a verb (brainstorm / ship / doctor / cleanup) |
| `p`          | cycle project filter |
| `?`          | full keymap overlay |
| `q` `ctrl+c` | quit |

**Live behavior**

The dashboard refreshes from disk every second and tails active
events.ndjson files concurrently — capturing an idea, accepting one,
or spawning a verb shows up in the next tick without a manual
refresh. Mutations preserve the cursor position by logical id (slug
or runId), so pressing `a` doesn't yank your selection onto a
neighbor.

The dashboard is TTY-only. `harness --json` and `harness --ndjson`
return a clean BAD_INPUT envelope pointing agents at `harness ideas
list` instead.

### Agent-friendly output

Every verb supports `--json` (single envelope) and `--ndjson` (event
stream). The envelope is stable as `harness/v1`; pin it. Get every
verb's JSON Schema with:

```bash
harness contracts --json
```

## Worktrees

Builds happen in a git worktree, never in your primary checkout. Default
location: `<repo-parent>/<repo-basename>-worktrees/<branch-flat>`. So a
build of `idea/dm-cohorts-d2e3` against the LetsBarker repo lands in
`~/Projects/PrimaryBarker/LetsBarker-worktrees/idea-dm-cohorts-d2e3`.
Override the parent dir with `IDEA_HARNESS_WORKTREE_DIR`.

This means:
- You can keep working in your primary checkout while a build runs.
- Concurrent builds don't trample HEAD (each gets its own worktree).
- Crashes leave the worktree dirty, not your repo. `harness resume <slug>`
  picks the worktree back up where the prior session left off.
- After a PR merges, run `harness cleanup --apply` to delete worktrees
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
BUILD — `harness build <slug>` spawns Claude Code in the target repo, opens a PR
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
  bin/
    harness.ts                      ← single binary entrypoint (commander)
  scripts/
    commands/                       ← one file per verb, each exporting `run(args, out)`
      capture.ts                    ← add an idea (text | --from reminders|stdin)
      brainstorm.ts                 ← orchestrator (capture → review)
      ideas.ts                      ← list / show / waiting
      review.ts                     ← next / in-flight / accept / reject / thought / set
      ship.ts                       ← do the next obvious thing
      build.ts                      ← start / resume / watch / status
      cleanup.ts                    ← remove worktrees for shipped ideas
      inspect.ts                    ← view recent runs + metrics
      doctor.ts                     ← env health check
      completions.ts                ← bash/zsh/fish completion script
      contracts.ts                  ← emit JSON Schema for every verb
    agents/
      initializer.ts                ← L2: plans the run
      harvester.ts                  ← Reminders → raw idea files
      brainstormer.ts               ← L4: brainstorms one idea
      critic.ts                     ← L5: gates output (qualitative)
      builder.ts                    ← L6: spawns claude in worktree, opens PR
    lib/
      output.ts                     ← pretty / --json / --ndjson abstraction
      contracts.ts                  ← Zod schemas + verb-contract registry
      ideas.ts                      ← idea file read/write
      runs.ts                       ← run lifecycle
      context.ts                    ← Tier 1/2/3 loading
      schema.ts                     ← deterministic brainstorm schema check
      worktree.ts                   ← git worktree lifecycle for builds
      graduator.ts                  ← shared worker for build/ship/resume
      slug.ts                       ← permissive slug matching
      llm.ts                        ← model adapters
      reminders.ts                  ← Reminders adapter (osascript)
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

The scaffold ships with all adapters fully implemented — `harness brainstorm --dry`
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
called "App Ideas", then `harness brainstorm`.

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
| `IDEA_HARNESS_AUTO_FLOW` | when `true`, the brainstormer auto-promotes high-confidence accept/reject verdicts past the human gate (see "Auto-flow" below) | `false` |
| `LOG_LEVEL` | `silent`, `error`, `warn`, `info`, `debug` | `info` |

## Auto-flow

After each brainstorm commit, the harness checks the verdict:

- `Recommended action: accept` + `Confidence: high` → idea status flips
  straight to `accepted` (skipping AWAITING YOU).
- `Recommended action: reject` + `Confidence: high` → idea status flips
  straight to `rejected`.
- Any other combination (medium/low confidence, `needs-more-thought`)
  stays at `brainstormed` for human review — no behavior change.

Auto-flow is **opt-in**: set `IDEA_HARNESS_AUTO_FLOW=true` to enable.
Default is off. Every auto-decision is journaled (`idea.auto_flowed`)
and reversible — `harness review accept|reject|needs-more-thought
<slug>` overrides at any time, and the journal preserves both decisions.

The dashboard surfaces auto-flow visibly:

- TODAY trail glyph: `⚡` injected before the accepted/rejected
  glyph (e.g., `↓💭⚡✓` for "captured, brainstormed,
  auto-accepted").
- NEXT bar: `⚡` prefix on auto-flowed picks.
- AWAITING YOU empty state: when auto-flow has handled ideas, the
  inbox-zero message swaps to "auto-flow handled N ideas — press
  [enter] to see TODAY".

## Why This Shape

Six principles drove the design:

1. **The harness is the product, not the model.** Swapping Claude versions
   should change quality, not break the system.
2. **Subtraction over addition.** Each agent sees minimum context.
3. **Fresh context beats compaction.** Each idea gets a clean window.
4. **Durable artifacts over conversation history.** Files are the truth.
5. **Human at the right gate, exactly once.** Conversational review.
6. **Honesty over enthusiasm.** Critic explicitly checks for hand-wavy output.
