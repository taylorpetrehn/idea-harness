# Reference: Idea File Schema

Every idea is a single markdown file at `ideas/<slug>.md`.

---

## Frontmatter

```yaml
---
id: <8-char hex>                              # generated at harvest
title: "<verbatim from source>"
status: raw                                   # see status flow below
source: reminders | conversation | feedback | coding
project: letsbarker                           # key from projects.yml
captured_at: <ISO 8601 UTC>                   # set at harvest
brainstormed_at: ~                            # set after critic pass
decided_at: ~                                 # set when Taylor reacts
github_issue: ~                               # reserved for future Issue-first flows
github_pr: ~                                  # set by the builder when PR opens
loop_count: 0                                 # # of needs-more-thought cycles
---
```

`~` means null in YAML — empty values stay as `~` until populated.

---

## Body Sections

```markdown
## Raw Idea

<Verbatim from Reminders or wherever it was captured. Never edited.>

## Notes

<Optional. Appended notes from Taylor, with date prefixes.
 Conversational review updates land here:
 > 2026-05-03: Taylor accepted variant 2>

## Brainstorm

<Filled by brainstormer. Structure defined in contracts/brainstorm-output.md>
```

---

## Status Flow

```
                 [harvest]
                    ↓
                   raw
                    ↓ [brainstormer]
                    ↓ [schema check + critic pass]
              brainstormed ─────► needs-critic-review
                    ↓
            [Taylor reacts]
            ↓       ↓        ↓
        accepted  rejected  needs-more-thought (loop_count++)
            ↓                    ↓
       [harness build]      (rebrew until loop_count == 3)
            ↓                    ↓
        building            (escalate to Taylor on 3rd bounce)
            ↓ [builder spawns claude in repo]
         pr-open
            ↓ [PR merged]
         shipped
```

| Status | Meaning |
|---|---|
| `raw` | Captured, not yet brainstormed |
| `brainstormed` | Schema + critic passed, awaiting Taylor's reaction |
| `needs-critic-review` | Schema or critic escalated — Taylor sees a flagged brainstorm |
| `accepted` | Taylor said yes — ready for `harness build` |
| `rejected` | Taylor said no — archived, never deleted |
| `needs-more-thought` | Taylor isn't ready, loop_count increments |
| `building` | Builder is spawning a Claude session in the target repo |
| `pr-open` | Builder opened a PR (`github_pr` set), waiting on review/merge |
| `shipped` | PR merged, feature is live |

`rejected` and `shipped` are terminal but not deleted. They're searchable
context for future brainstorms.

---

## Slug Format

`<kebab-title>-<id-prefix>.md`

Where:
- `kebab-title` is lowercase, alphanumerics + hyphens, max 50 chars
- `id-prefix` is the first 4 chars of the `id` frontmatter field

Example: `profile-completion-nudges-a3f2.md`

---

## Worked Example

```markdown
---
id: a3f2b1c9
title: "profile completion nudges"
status: brainstormed
source: reminders
project: letsbarker
captured_at: 2026-05-03T14:22:00Z
brainstormed_at: 2026-05-03T14:24:31Z
decided_at: ~
github_issue: ~
github_pr: ~
loop_count: 0
---

## Raw Idea

profile completion nudges

## Notes

Noticed a lot of profiles look empty. Maybe show progress somehow?

## Brainstorm

### Problem
Empty barker profiles undermine first-impression trust at the moment a
client is deciding whether to book.

### Audience and frequency
Every new barker post-signup, plus the long tail of partially-completed
profiles. Affects every first-time client view of an unfilled profile —
high frequency at the funnel top.

### Existing footprint
`User#profile_complete?` exists in `app/models/user.rb` but is only used
in admin filters. No user-facing surface uses it. No banner, modal, or
notification component currently displays profile state.

### Simplest version
A persistent banner at the top of `BarkerProfileScreen` showing
"Profile X% complete" with one CTA pointing to the highest-impact missing
field (photo > bio > rates). Banner disappears at 100%. No gamification.

### Variants
1. **Banner only** — passive, always visible to barker. Minimal surface
   area, easy to revert.
2. **Onboarding modal + banner** — modal once at signup, banner persists.
   Higher intervention, more disruptive on signup.
3. **Email nudges** — background job emails barkers below 60% completion
   after 48 hours. Lowest UI footprint, highest infra cost.

### Risks and open questions
- What counts as "complete"? Need explicit field weights — referenced in
  decisions.md, no prior decision.
- Risk: banner becomes ignored ("banner blindness") if always visible.
- Does this apply to clients or barkers only?

### Past idea overlap
None found in `ideas/`.

### Verdict
**Recommended action:** accept
**Confidence:** high
**Why:** Small surface area, existing model hook, clear funnel-stage value.
**If accepted, build:** simplest version (banner only)
```
