# Contract: Handoff to Build Pipeline

Defines what an `accepted` idea must contain before the `idea-to-pr` skill
picks it up.

---

## Required Frontmatter

```yaml
id: <8-char hex>
title: "<title>"
status: accepted
source: reminders | conversation | feedback | coding
project: <key from references/projects.yml>   # MUST resolve
captured_at: <ISO 8601>
brainstormed_at: <ISO 8601>                    # MUST be set
decided_at: <ISO 8601>                         # MUST be set
```

If any required field is missing, `idea-to-pr` skips the idea and posts a
note: "Idea {slug} marked accepted but missing fields: …". Status reverts
to `brainstormed` for re-review.

---

## Required Body Fields

The brainstorm must contain:
- All sections from `brainstorm-output.md`
- A clear `**If accepted, build:**` line specifying which version

If Taylor accepted a non-default variant during conversational review, that
choice is appended to the `## Notes` section as:

```
> 2026-05-03: Taylor accepted variant 2 (email nudge approach)
```

`idea-to-pr` reads the most recent variant note as the chosen scope.

---

## Project Resolution

Every accepted idea must have a `project` value that exists in
`references/projects.yml`. If the idea was harvested without a clear project
match, the initializer flags it during planning and Taylor resolves it
during the conversational review:

> "This one didn't auto-route to a project — is this a LetsBarker idea or
> something else?"

The conversational handler updates the frontmatter on Taylor's answer.

---

## What `idea-to-pr` Does

The build pipeline reads `ideas/*.md` with `status: accepted` as one of its
input sources (alongside Reminders, until Reminders is fully retired).

For each accepted idea:
1. Read the brainstorm — this replaces the existing "scoring" step. Verdict
   confidence becomes the build pipeline's confidence tier.
2. Update status: `accepted` → `building`
3. Generate spec + brief from the brainstorm content (much higher signal
   than from a Reminders one-liner)
4. Create GitHub Issue with brainstorm content as the body
5. Run the existing build/review/PR flow
6. On PR merge: status → `shipped`
7. On PR cancellation: status → `accepted` (re-queue for revisit)

---

## Confidence Mapping

| Brainstorm verdict confidence | `idea-to-pr` tier |
|---|---|
| `high` | HIGH (auto-build) |
| `medium` | MEDIUM (await `agent:ready` label) |
| `low` | Should not occur — critic should have caught vague ideas |

If a `low` confidence idea reaches the build pipeline, that's a critic
failure. The build pipeline gates it to MEDIUM and logs the leak for
critic tuning.

---

## What Doesn't Cross the Handoff

The build pipeline never reads:
- The harness run logs (`runs/`)
- Loop detection state
- Critic verdicts
- Other ideas in `ideas/`

The accepted idea file is fully self-contained. This is the contract — if
you can't build from the file alone, the brainstorm wasn't good enough.
