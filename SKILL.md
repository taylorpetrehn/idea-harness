---
name: idea-harness
description: >
  A harness for capturing, brainstorming, accepting, and shipping LetsBarker
  ideas as real pull requests. Six layers (triggers, control, context,
  execution, verification, build) with durable file-backed state and
  explicit contracts at every handoff. Taylor's only touch points are
  reacting to brainstormed ideas in a Claude conversation and reviewing
  the final PR on GitHub.
---

# Idea Harness

A purpose-built harness that turns half-formed thoughts into well-considered
features — and then into real PRs — without losing anything or building the
wrong thing.

This is **not** a workflow runner. It is a control plane: it governs what
context agents see, what artifacts they produce, what gates they must pass,
and what state survives across runs.

---

## Architecture

The harness has six layers, each with a clear responsibility and a clean
contract to the next.

```
┌─────────────────────────────────────────────────────────────────┐
│ L1  TRIGGERS         what kicks off a run                        │
│ L2  CONTROL          plans the run, decomposes work              │
│ L3  CONTEXT          loads the right info, with a budget         │
│ L4  EXECUTION        agents do the actual brainstorming          │
│ L5  VERIFICATION     schema check + critic, before human sees it │
│ L6  BUILD            spawns Claude in target repo, opens a PR    │
│                                                                  │
│ STATE                durable artifacts that survive runs         │
│ REVIEW               conversational human gate                   │
└─────────────────────────────────────────────────────────────────┘
```

Each layer is implemented as a small, focused module under `scripts/`. The
top-level `garden.ts` is the orchestrator — it composes the layers in order
and is the only file that knows about the full sequence.

---

## L1: Triggers

Three ways to start a run. All produce the same downstream behavior.

| Trigger | Use case | Entry point |
|---|---|---|
| Manual | "I want to process my ideas now" | `npm run garden` |
| Conversational | "What ideas are waiting for me?" | Claude reads `ideas/` directly |
| Event (optional) | New Reminder detected via Shortcut | webhook → `npm run garden` |

The harness **never runs on a timer**. Empty cron loops were the original sin
of the previous pipeline.

---

## L2: Control — The Initializer Agent

The initializer is the first agent in the harness. It does no creative work —
its job is to plan the run.

**Inputs:**
- Current state of `ideas/` folder
- Current state of Apple Reminders "App Ideas" list
- Last run log (if any) at `runs/latest.json`
- Loop detection state at `state/loops.json`

**Outputs (the run plan, written to `runs/<timestamp>/plan.json`):**
```json
{
  "run_id": "2026-05-03T14-22-00Z",
  "trigger": "manual",
  "harvest": [
    {"reminder_id": "...", "title": "...", "action": "create_raw"}
  ],
  "brainstorm": [
    {"slug": "...", "context_tier": "minimal", "budget_tokens": 8000}
  ],
  "skip": [
    {"slug": "...", "reason": "needs-more-thought, bounced 3x, awaiting decision"}
  ],
  "estimated_cost_usd": 0.42,
  "estimated_duration_seconds": 90
}
```

**Contracts the initializer enforces before producing the plan:**
- Every reminder is checked against `ideas/` (fuzzy title match) before being
  marked for harvest
- Every idea marked for brainstorm has a known `project` from `projects.yml`
- Total token budget for the run does not exceed the configured cap
- Loop-detected ideas (`needs-more-thought` 3+ times) are surfaced as
  human-attention items, not auto-brainstormed again

If the plan has nothing to do, the harness exits silently. **No empty runs.**

---

## L3: Context — Progressive Disclosure

Context loading is tiered. The brainstormer starts minimal and requests more
only when needed. This caps cost and makes context use auditable.

**Tier 1 — Always loaded (~3k tokens):**
- `context/product.md` — what LetsBarker is, current state, focus
- `context/decisions.md` — conscious "won't build" list
- The raw idea + notes
- Titles + statuses of all past ideas (just titles, not bodies)

**Tier 2 — On request (~5k tokens each):**
- Full body of a related past idea (when overlap suspected)
- Targeted codebase reads (specific file or directory)
- Recent commit history for relevant area

**Tier 3 — Rarely (~15k tokens):**
- Broad codebase walk
- Full schema/migration history
- Cross-project context

The brainstormer requests Tier 2/3 by emitting structured tool calls. The
harness logs what was requested and why — this becomes training data for
which context actually matters.

**Token budget enforcement:**
- Default: 10k per idea
- Hard cap: 25k per idea
- Run cap: 100k total — initializer trims the run if exceeded

See `contracts/context-budget.md` for the full policy.

---

## L4: Execution — The Brainstormer Agent

Each idea gets a **fresh context window**. No replay across ideas. This is
Anthropic's two-agent pattern applied at the idea level: the initializer
plans, the brainstormer executes one idea at a time with clean state.

**Per-idea loop:**

```
1. Load Tier 1 context
2. Read raw idea + notes
3. Think: what would make this brainstorm useful for Taylor's decision?
4. Optionally request Tier 2 context (max 3 requests per idea)
5. Produce brainstorm artifact matching contracts/brainstorm-output.md
6. Hand to verification (L5)
7. On critic pass: write to ideas/<slug>.md, status → brainstormed
8. On critic fail: one revision pass with critic feedback, then escalate
```

The brainstormer follows a strict output contract — it cannot save a
brainstorm that doesn't include all required sections and a justified verdict.
See `contracts/brainstorm-output.md`.

---

## L5: Verification — Schema Check + Critic

Two gates before any brainstorm reaches Taylor. The first is mechanical
and free; the second is qualitative and uses a small LLM.

### L5a: Deterministic schema check

Implemented in `scripts/lib/schema.ts`. Runs first. Validates structure
mechanically — required H3 headers in order, exact verdict-line format,
and rejects known drift headers (e.g. "Effort estimate", "Recommendation").
Costs zero tokens.

This gate exists because the live brainstormer (Opus) can produce a great
brainstorm with the wrong section names — the LLM critic alone has been
seen to rubber-stamp this. The schema check makes drift impossible.

A schema failure produces precise, line-level feedback ("missing required
section ### Existing footprint", "**Recommended action:** must be one of
accept | reject | needs-more-thought") that the brainstormer can act on
in a single revision.

### L5b: The Critic

Once schema is valid, the critic agent reviews the qualitative dimensions.

**The critic checks (`contracts/critic-rubric.md`):**

| Check | Pass criteria |
|---|---|
| Specificity | "Simplest version" names a concrete artifact, not "a lighter version" |
| Context use | At least one citation of `product.md`, `decisions.md`, or a past idea |
| Verdict justification | "Why" sentence references something specific, not generic |
| Variant differentiation | Variants meaningfully differ in scope or approach |
| Honesty | If the idea is vague, the brainstorm says so — doesn't pad |
| Forbidden patterns | No sycophancy, hedging-without-commitment, schema reproduction, padding |

(Structural completeness is no longer a critic check — schema.ts handles it.)

**Critic output:**
```json
{
  "verdict": "pass" | "revise" | "escalate",
  "failed_checks": ["specificity", "context_use"],
  "feedback": "The 'simplest version' is vague — say which screen, which CTA."
}
```

- `pass` → brainstorm written to file, status → `brainstormed`
- `revise` → brainstormer gets one shot to fix, with feedback in context
- `escalate` → status set to `needs-critic-review`, surfaced to Taylor

The critic uses a smaller/cheaper model than the brainstormer — its job is
checking, not generating. See `contracts/critic-rubric.md`.

---

## State

All state is file-backed and human-readable. Nothing important lives only in
a database or in memory.

```
idea-harness/
  ideas/<slug>.md           ← the work product, one file per idea
  runs/
    latest.json             ← symlink to most recent run
    <timestamp>/
      plan.json             ← initializer output
      brainstorm-<slug>.json ← per-idea execution log
      critic-<slug>.json    ← critic verdict per idea
      summary.json          ← run-level metrics
  state/
    loops.json              ← loop detection counters per idea
    metrics.json            ← rolling stats (accept rate, time-to-decision)
  contracts/                ← machine-checkable output contracts
  context/                  ← human-maintained product context
```

The `runs/` directory is your observability layer. Every brainstorm is fully
reproducible from its run artifacts — what context was loaded, what the
critic said, how long it took, what it cost.

---

## Handoff: The Conversational Review

When Taylor opens Claude and asks **"What ideas are waiting for me?"**,
Claude should:

1. Read `ideas/*.md` filtered to `status: brainstormed`
2. Sort by `brainstormed_at` (oldest first — first in, first out)
3. Present each idea as a tight summary:
   - Title
   - One-line problem statement (from the brainstorm)
   - Recommended action + confidence
   - The simplest-version recommendation
4. Wait for Taylor's reaction before moving on

**Reactions and effects:**

| Taylor says | Effect |
|---|---|
| "Ship it" / "Yes" / "Accept" | status → `accepted`, decided_at set |
| "The simpler version" | append note, status → `accepted` |
| "Variant 2" | append note specifying which variant, status → `accepted` |
| "Kill it" / "No" | status → `rejected`, decided_at set |
| "Not sure yet" | status → `needs-more-thought`, increment loop counter |
| "Tell me more" | discuss freely; ask again when ready |
| "What did we decide about X before?" | scan archive, summarize, return to current |

**Loop detection at handoff:**
If Taylor selects `needs-more-thought` and the loop counter hits 3, Claude
should push back: "This is the third time this has bounced. Want to just kill
it, or what's actually missing?" — surfacing the indecision instead of
quietly rebrewing.

After every status change, write to the file immediately. Never batch.

---

## L6: Build — The Builder

`npm run graduate <slug>` is the bridge from accepted idea to real PR.
Implemented in `scripts/agents/builder.ts` and orchestrated by
`scripts/graduate.ts`.

**What it does:**

1. Resolves the target repo from frontmatter `project` → `projects.yml`
   (`local_path`, `github_repo`, `base_branch`).
2. Computes a feature branch name: `idea/<slug-stub>-<id4>`.
3. Picks the variant — newest "variant N" / "simplest version" line in
   `## Notes` (Taylor's choice during conversational review), or falls
   back to the brainstorm's `**If accepted, build:**` line.
4. Composes a build directive: the brainstorm body verbatim is the spec,
   plus the variant choice, branch name, and base branch.
5. Spawns `claude --print --permission-mode acceptEdits` with the target
   repo as cwd. The session has full Claude Code tools — it explores,
   plans, edits, runs tests, commits, pushes, and opens a PR via `gh`.
6. Parses `PR_URL=<url>` from the session's last line. Absent → failure;
   status reverts to `accepted`.
7. On success: writes `github_pr` to frontmatter, status →`pr-open`,
   appends a `## PR` section to the idea body.

**What it does NOT do:**

- It does not generate a separate spec. The brainstorm IS the spec — that's
  the design choice. The brainstorm has already been gated for specificity,
  variant differentiation, and a concrete build target.
- It does not merge the PR. The PR is the human gate.
- It does not push to base branches (preview/main). The system prompt
  forbids any branch other than the one in BRANCH_NAME.

**Permission posture:**

The builder spawns `claude --permission-mode bypassPermissions`. This is
deliberate: a fresh build needs `git add`, `git commit`, `git push`, and
`gh pr create` to run without per-command approval, and the target repo's
`.claude/settings.local.json` allow-list is unlikely to include those. We
bypass the permission gate and rely on the system prompt's branch-pinned
constraints + no-merge + no-force-push rules to bound risk. (This is how
the dm-cohorts-d2e3 build got blocked the first time — `acceptEdits` lets
edits through but still gates Bash; that's the wrong shape for this job.)

**Recovery: `npm run resume`:**

If a build session implements changes but doesn't reach the PR (network
hiccup, CI agent killed, prior permission gate before bypassPermissions
landed), the idea stays at status `building` with a `## Notes` line
pointing to the run log. `npm run resume <slug>` re-spawns Claude in the
worktree with a different system prompt: "the branch already has
uncommitted work, just commit/push/PR." It does not re-implement.

**Worktrees, not the primary checkout:**

Every build runs in a git worktree, never in the user's main checkout.
Default location is `<repo-parent>/<repo-basename>-worktrees/<branch-flat>`.
Three reasons:

1. **Concurrency.** `npm run graduate -- --all` with two accepted ideas
   spawns two sessions; without worktrees both would `cd` to the same
   directory and stomp HEAD on each other's `git checkout -b`.
2. **Working-tree isolation.** Without a worktree, an in-progress edit
   sitting in your primary checkout could be picked up by the builder's
   `git add` and end up in the PR. The worktree is clean by construction.
3. **Clean recovery.** Crashes leave the worktree dirty, not the repo.
   `npm run resume` reuses the same worktree; in-flight changes are still
   there.

Cleanup is opt-in: `npm run cleanup` shows what's eligible (worktrees of
ideas at `shipped`); `--apply` actually removes. Nothing auto-deletes.

**Modes (env: `IDEA_HARNESS_BUILDER`):**

- `live` (default) — spawn Claude in the repo and actually build.
- `dry` — print the prompt and resolved settings; don't spawn.
- `offline` — skip Claude, return a fake PR URL; used in tests.

**Status flow:**

```
accepted ──[npm run graduate]──> building ──[claude session]──> pr-open ──[merge]──> shipped
                                    │
                                    └──[failure]──> accepted (re-queueable)
```

The `npm run review in-flight` command surfaces accepted / building / pr-open
ideas so a quick check tells you what's still moving through the pipeline.

---

## Status Flow

```
                    [harvest]
                       ↓
                      raw
                       ↓ [brainstormer]
                       ↓ [schema check + critic]
                       ↓
                  brainstormed ─────► needs-critic-review (escalation)
                       ↓
              [Taylor reacts]
              ↓        ↓        ↓
          accepted  rejected  needs-more-thought
              ↓                    ↓
       [npm run graduate]     (loop counter++)
              ↓                    ↓
          building             (rebrew on next run, until counter=3)
              ↓ [claude session in repo]
          pr-open
              ↓ [PR merged]
           shipped
```

`rejected` and `shipped` are terminal. Files stay in `ideas/` forever —
they're searchable context for future decisions and never auto-deleted.

---

## Running It

```bash
# Full harness run: harvest → plan → brainstorm → schema + critic
npm run garden

# Show ideas waiting for review
npm run waiting

# Conversational review CLI (Claude calls these during the chat review)
npm run review next                       # JSON for the next idea
npm run review accept <slug> [note]       # mark accepted
npm run review reject <slug> [note]
npm run review thought <slug> [note]
npm run review in-flight                  # accepted / building / pr-open

# Ship the next eligible idea (no slug needed)
npm run ship                              # picks newest accepted, or auto-accepts brainstormed
npm run ship <slug>                       # explicit
npm run ship -- --yes                     # don't prompt for auto-accept confirmation

# Or step-by-step
npm run graduate <slug>                   # accepted → PR (fresh build)
npm run graduate <slug> --variant=v2      # override variant choice
npm run graduate <slug> --dry             # preview the build prompt
npm run graduate -- --all                 # graduate every accepted idea
npm run resume <slug>                     # recover a `building` idea whose session died

# Slugs accept unique prefix or substring (`dm-cohorts` is fine).

# Inspect run history + metrics
npm run inspect
```

---

## Why This Shape

A few principles drove the design — worth being explicit so future changes
don't quietly violate them.

**1. The harness is the product, not the model.** Swapping the brainstormer
from one Claude version to another should change quality, not break the
system. All inter-agent contracts are file-based and model-agnostic.

**2. Subtraction over addition.** Each agent sees the minimum context needed.
The critic uses a smaller model. The harvest step doesn't load product
context. Removing tools from agents' reach has been shown to improve task
success more than model upgrades.

**3. Fresh context beats compaction.** Each idea gets a clean window. We
never replay one brainstorm into another. Cross-idea state lives in the
filesystem, not the context window.

**4. Durable artifacts over conversation history.** The `ideas/<slug>.md`
file is the truth. Run logs are the truth. If the harness crashed mid-run
and you restarted it, no information would be lost.

**5. Human at the right gate, exactly once.** Taylor reviews brainstormed
ideas conversationally. Everything before that is automated. Everything
after that hands off to the build pipeline, where the next human gate is
the GitHub PR review.

**6. Honesty over enthusiasm.** The critic explicitly checks for hand-wavy
output. The brainstormer is instructed to be honest about vague ideas, not
to pad them. Bad ideas should look bad — that's the point of brainstorming.

---

## Reference Files

- `contracts/brainstorm-output.md` — required structure for brainstorm artifacts
- `contracts/critic-rubric.md` — pass/fail criteria for the critic
- `contracts/context-budget.md` — token budget policy and tier definitions
- `contracts/handoff-to-build.md` — what `idea-to-pr` expects from `accepted` ideas
- `references/idea-schema.md` — idea file frontmatter + body template
- `context/product.md` — what LetsBarker is (Taylor maintains)
- `context/decisions.md` — conscious "won't build" list (Taylor maintains)
