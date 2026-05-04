# Contract: Brainstorm Output

This contract defines what a valid brainstorm artifact must contain.
The brainstormer agent MUST produce output matching this contract.
The critic agent uses this contract to validate output.

A brainstorm that does not match this contract cannot be written to an
idea file — the harness rejects it before it reaches the human review queue.

---

## Required Structure

The brainstorm section of an idea file must contain these markdown headers,
in this order, each with at least one paragraph of substantive content:

```markdown
### Problem
### Audience and frequency
### Existing footprint
### Simplest version
### Variants
### Risks and open questions
### Past idea overlap
### Verdict
```

---

## Section Requirements

### Problem
- One sentence stating the user-facing problem this idea addresses
- Must be a problem, not a feature description
- ❌ "Add profile completion bar"
- ✅ "Empty profiles undermine trust at first impression"

### Audience and frequency
- Who experiences the problem (specific user segment)
- How often (every signup / every booking / once per user / etc.)
- Frequency drives priority — must be explicit, not implied

### Existing footprint
- What's already in the codebase related to this
- Honest answer can be "nothing"
- If something exists, name it specifically (file path, model, screen)
- This section requires the brainstormer to have actually checked

### Simplest version
- The smallest implementation that delivers most of the value
- MUST name a concrete artifact: which screen, which CTA, which field
- ❌ "A lighter version of the feature"
- ✅ "A persistent banner on the barker profile screen with one CTA pointing
     to the most-impactful missing field"
- This is the version recommended for build by default

### Variants
- 2-3 meaningfully different approaches
- Each must differ in scope, surface area, or approach — not just polish
- Each must have a one-line tradeoff statement
- Less than 2 variants → critic flags as insufficient exploration
- More than 4 variants → critic flags as scope creep

### Risks and open questions
- What could go wrong in production
- What decisions are unresolved
- Be specific: "How do we define 'complete'?" beats "Requirements unclear"
- Empty section is a critic fail — every idea has at least one risk

### Past idea overlap
- Ideas in `ideas/` that relate to this one, by slug
- Note relationship: duplicate / evolution / related-but-different
- "None found" is acceptable if true

### Verdict
Must end with these exact lines, formatted exactly:

```
**Recommended action:** accept | reject | needs-more-thought
**Confidence:** high | medium | low
**Why:** <one sentence justifying the action and confidence>
**If accepted, build:** <simplest version | variant 1 | variant 2 | etc>
```

---

## Forbidden Patterns

These trigger automatic critic rejection:

- **Sycophancy.** "This is a great idea!" — the brainstormer's job is
  evaluation, not encouragement.
- **Hedging without commitment.** "Could be valuable" / "might be useful" —
  if the brainstormer can't take a position, the verdict should be
  `needs-more-thought` with specific missing info.
- **Generic verdicts.** "Why: provides user value" — must reference a
  specific aspect of THIS idea, not generic feature value.
- **Schema reproduction.** Copying section headers without substantive
  content underneath.
- **Padding for length.** Repeating points across sections to fill space.

---

## Output Format

The brainstormer emits the brainstorm as a single markdown block. The
harness writes it into the idea file replacing the placeholder:

```markdown
## Brainstorm

<!-- Filled by the brainstormer. -->
```

becomes:

```markdown
## Brainstorm

### Problem
...

### Audience and frequency
...

(etc.)
```

The brainstormer does NOT modify frontmatter. Status changes are made by
the harness after critic verdict.
