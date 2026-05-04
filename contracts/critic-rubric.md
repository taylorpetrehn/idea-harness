# Contract: Critic Rubric

The critic is the last gate before a brainstorm reaches Taylor. Its job
is to catch low-quality output before it becomes review burden.

The critic uses a smaller/cheaper model than the brainstormer. It does
not generate — it only checks.

---

## Input

The critic receives:
1. The brainstorm artifact produced by the brainstormer (markdown)
2. The raw idea + notes (for context on what was being evaluated)
3. This rubric

The critic does NOT receive: product context, codebase, past ideas. Its
job is structural and quality validation, not domain re-evaluation. If
the brainstorm cites context, the critic checks the citation exists
(file present in the harness) — it does not re-read the cited source.

---

## Checks

Each check returns pass/fail with a one-line reason on fail.

### 1. Schema completeness
All required sections present per `brainstorm-output.md`?
**Fail mode:** missing section, sections out of order, headers malformed.

### 2. Specificity in "Simplest version"
Does it name a concrete artifact (screen, CTA, field, file)?
**Fail mode:** "a lighter version", "the basic flow", "an MVP" without
specifics.

### 3. Context citation
Does the brainstorm reference at least one of: `product.md`, `decisions.md`,
or a specific past idea slug, AND quote or summarize the relevant passage?
**Fail mode:** brainstorm reads as if written without product context.
**Fail mode:** brainstorm name-drops a context file but doesn't say what
it found there ("per decisions.md" with no further detail).

### 4. Verdict justification
Does the "Why:" sentence reference something specific to THIS idea?
**Fail mode:** generic statements that could apply to any idea ("delivers
user value", "improves UX").

### 5. Variant differentiation
Do variants meaningfully differ in scope or approach?
**Fail mode:** variants differ only in polish ("the same thing but with
animation").

### 6. Honest hedging
If the verdict is `needs-more-thought`, does the brainstorm name what
specifically is missing?
**Fail mode:** vague "needs more thought" without naming the gap.

### 7. Forbidden patterns
Any of the patterns listed in `brainstorm-output.md`?
- Sycophancy
- Hedging without commitment
- Generic verdicts
- Schema reproduction
- Padding for length

---

## Verdict

```json
{
  "verdict": "pass" | "revise" | "escalate",
  "checks": {
    "schema_completeness": "pass",
    "specificity": "fail: 'simplest version' is vague",
    "context_citation": "pass",
    "verdict_justification": "pass",
    "variant_differentiation": "pass",
    "honest_hedging": "pass",
    "forbidden_patterns": "pass"
  },
  "feedback": "The 'Simplest version' section says 'a lighter banner' — name which screen, which CTA, and what disappears when complete."
}
```

**Decision rules:**
- 0 failures → `pass`
- 1-2 failures, all fixable → `revise` (one revision allowed)
- 3+ failures, OR same failure repeated after revision → `escalate`

---

## Revision Loop

If verdict is `revise`:
1. Brainstormer receives the original idea + the critic feedback
2. Brainstormer produces a new brainstorm addressing the feedback
3. Critic re-checks
4. If still failing: `escalate`

The harness allows **one revision** per idea. After that, the idea moves to
`needs-critic-review` and Taylor sees it surfaced as "this couldn't be
brainstormed well — what's actually being asked here?"

---

## Why Use a Critic at All?

Without a critic, three failure modes appear:
- **Wall of generic brainstorms.** Plausible-looking output that doesn't
  actually help decide.
- **Schema drift.** Sections quietly disappear or get renamed across runs,
  breaking downstream parsing.
- **Sycophancy.** The brainstormer becomes a yes-machine that recommends
  accept on every idea.

The critic is not a smarter brainstormer. It is an honest auditor with a
checklist. Cheap to run, high value at gate.
