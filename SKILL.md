---
name: idea-harness
description: >
  A harness for capturing, brainstorming, and graduating LetsBarker ideas.
  Built on the five-layer harness pattern (triggers, control, context,
  execution, verification) with durable file-backed state and explicit
  contracts at every handoff. Taylor's only touch points are reacting to
  brainstormed ideas in a Claude conversation and reviewing the final PR.
---

# Idea Harness

A purpose-built harness that turns half-formed thoughts into well-considered
features without losing anything or building the wrong thing.

This is **not** a workflow runner. It is a control plane: it governs what
context agents see, what artifacts they produce, what gates they must pass,
and what state survives across runs.

---

## Architecture

The harness has five layers, each with a clear responsibility and a clean
contract to the next.

```
┌─────────────────────────────────────────────────────────────────┐
│ L1  TRIGGERS         what kicks off a run                        │
│ L2  CONTROL          plans the run, decomposes work              │
│ L3  CONTEXT          loads the right info, with a budget         │
│ L4  EXECUTION        agents do the actual brainstorming          │
│ L5  VERIFICATION     critic gates output before human sees it    │
│                                                                  │
│ STATE                durable artifacts that survive runs         │
│ HANDOFF              human gate → graduation to build pipeline   │
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

## L5: Verification — The Critic

Before any brainstorm reaches Taylor, a critic agent reviews it. This is the
gate that prevents low-quality output from becoming review burden.

**The critic checks (`contracts/critic-rubric.md`):**

| Check | Pass criteria |
|---|---|
| Schema | All required sections present, frontmatter valid |
| Specificity | "Simplest version" names a concrete artifact, not "a lighter version" |
| Context use | At least one citation of `product.md`, `decisions.md`, or a past idea |
| Verdict justification | "Why" sentence references something specific, not generic |
| Variant differentiation | Variants meaningfully differ in scope or approach |
| Honesty | If the idea is vague, the brainstorm says so — doesn't pad |

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

## Graduation: Handoff to the Build Pipeline

Accepted ideas are picked up by the existing `idea-to-pr` skill. The handoff
contract:

**An idea graduates when:**
- `status: accepted`
- `decided_at` is set
- Frontmatter has a `project` resolvable in `projects.yml`
- Brainstorm contains a clear "If accepted, build:" line

`idea-to-pr` reads `ideas/*.md` with status `accepted` as one of its input
sources, the same way it currently reads Reminders. It updates status to
`building` when it picks up the idea, and `shipped` when the PR merges.

The build pipeline shouldn't need to brainstorm — that's already done.
LOW-confidence specs should become rare, since vague ideas were filtered at
the critic gate.

---

## Status Flow

```
                    [harvest]
                       ↓
                      raw
                       ↓ [brainstormer]
                       ↓ [critic]
                       ↓
                  brainstormed ─────► needs-critic-review (escalation)
                       ↓
              [Taylor reacts]
              ↓        ↓        ↓
          accepted  rejected  needs-more-thought
              ↓                    ↓
        [idea-to-pr]          (loop counter++)
              ↓                    ↓
          building            (rebrew on next run, until counter=3)
              ↓
           shipped
```

`rejected` and `shipped` are terminal. Files stay in `ideas/` forever —
they're searchable context for future decisions and never auto-deleted.

---

## Running It

```bash
# Full harness run: harvest → plan → brainstorm → verify
npm run garden

# Inspect the latest run
npm run inspect

# Show ideas waiting for review
npm run waiting

# Manually trigger a status change (Claude does this conversationally)
npm run status set <slug> accepted
```

For Claude CLI invocation:

```bash
claude --include context/ --include ideas/ --include contracts/ \
       "Run the idea-harness per SKILL.md"
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
