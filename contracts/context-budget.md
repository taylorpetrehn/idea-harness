# Contract: Context Budget

Progressive disclosure with hard caps. The brainstormer starts with minimal
context and earns more by demonstrating need.

---

## Tiers

### Tier 1 — Always loaded (~3,000 tokens)
- `context/product.md`
- `context/decisions.md`
- The raw idea + notes
- Titles + statuses of all past ideas (just `status | title`, not bodies)

The brainstormer cannot proceed without Tier 1.

### Tier 2 — On request (~5,000 tokens each, max 3 requests per idea)

Available on explicit request:
- **Past idea body** — full text of a specific `ideas/<slug>.md` file
  (request when overlap is suspected from titles)
- **Codebase read** — specific file, directory listing, or grep result
  (request when "Existing footprint" requires verification)
- **Schema/migration** — recent DB schema changes for relevant area

Format of request:
```json
{
  "tool": "context_request",
  "tier": 2,
  "kind": "past_idea_body" | "codebase_read" | "schema_history",
  "target": "<slug or path or area>",
  "reason": "<one line explaining why this is needed>"
}
```

The harness logs every request with the reason. If a brainstormer requests
the same thing repeatedly across runs, that's a signal to promote it to
Tier 1.

### Tier 3 — Rarely (~15,000 tokens, requires escalation)

- Broad codebase walk
- Full migration/schema history
- Cross-project context

Tier 3 requests are logged and surfaced in the run summary. If a brainstormer
hits Tier 3 frequently, the harness configuration is wrong — either the
product is too complex for the current Tier 1, or the ideas are too vague
to brainstorm without diving deep.

---

## Budget Caps

| Scope | Cap |
|---|---|
| Per-idea soft target | 10,000 tokens |
| Per-idea hard cap | 25,000 tokens |
| Per-run hard cap | 100,000 tokens |
| Critic per idea | 3,000 tokens (separate from brainstormer budget) |

The initializer estimates total run cost during planning. If the plan
exceeds the run cap, it trims the run (oldest brainstormed ideas first
remain in the queue for next run, never silently dropped).

---

## Enforcement

The harness tracks token usage per agent invocation. Hitting the per-idea
hard cap forces the brainstormer to commit to its current draft — no
further context loads, must produce verdict from what it has.

Hitting the run cap stops the loop after the current idea finishes. Remaining
ideas stay `raw`, picked up on next run.

---

## Why This Matters

Two things break a long-running harness:
1. **Cost drift.** Every brainstorm gradually loads more context until the
   system is too expensive to run.
2. **Context rot.** Cumulative context across many ideas degrades reasoning
   quality.

Progressive disclosure with a hard budget addresses both. Each idea gets
fresh context, sized appropriately for its complexity. Simple ideas stay
cheap. Complex ideas earn more budget through specific requests.
