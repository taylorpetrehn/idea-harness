# Contract: Handoff to the Builder (L6)

Defines what an `accepted` idea must contain before `harness build <slug>`
will hand it off to the builder.

The builder spawns a Claude Code session inside the target repo's working
directory. The brainstorm body is the only spec — there is no separate
specifier agent. Whatever the brainstorm says is what gets built.

---

## Required Frontmatter

```yaml
id: <8-char hex>
title: "<title>"
status: accepted
source: reminders | conversation | feedback | coding
project: <key from references/projects.yml>   # MUST resolve to a project with local_path
captured_at: <ISO 8601>
brainstormed_at: <ISO 8601>                    # MUST be set
decided_at: <ISO 8601>                         # MUST be set
github_pr: ~                                   # populated by the builder on success
```

If any required field is missing, `harness build` exits non-zero and
prints which fields are missing. Status reverts to `brainstormed` so it
re-surfaces in the review queue.

---

## Required Body Fields

The brainstorm must contain:

- All sections from `brainstorm-output.md` (the schema check enforces this).
- A clear `**If accepted, build:**` line specifying which version (the
  builder reads this as the default `BUILD_VARIANT`).

If Taylor accepted a non-default variant during conversational review, the
choice is appended to the `## Notes` section as:

```
> 2026-05-03: Taylor accepted variant 2 (email nudge approach)
```

The builder reads the most recent `variant N` / `simplest version` line in
`## Notes` and overrides the default with that choice. Pass
`--variant=<text>` to the graduate CLI to override both.

---

## Project Resolution

Every accepted idea must have a `project` value that exists in
`references/projects.yml` AND has a `local_path` that exists on disk.

If the idea was harvested without a clear project match, the initializer
flags it during planning and Taylor resolves it during conversational
review:

> "This one didn't auto-route to a project — is this a LetsBarker idea or
> something else?"

The conversational handler updates the frontmatter on Taylor's answer.

---

## What the Builder Does

For each accepted idea:

1. Resolves `project` → `projects.yml` entry → `local_path`, `github_repo`,
   `base_branch`.
2. Computes branch name `idea/<slug-stub>-<id4>`.
3. Composes a build directive: brainstorm body + variant + branch + base.
4. Sets status to `building`, then spawns `claude --print` in the repo.
5. Claude explores the codebase, implements the chosen variant on the
   feature branch, runs tests, commits, pushes, and runs `gh pr create`.
6. Claude prints `PR_URL=<url>` as its final line on success. The builder
   parses this; absence is treated as failure.
7. On success: status → `pr-open`, `github_pr` set, `## PR` section
   appended to the idea body.
8. On failure: status reverts to `accepted` with a note in `## Notes`
   pointing at the failed run artifact.

The builder NEVER:

- Pushes to a base branch (preview/main)
- Merges the PR (the human gate)
- Uses `--no-verify` or skips signing
- Reads run logs or other ideas — it only sees the brainstorm body

---

## Confidence Mapping

The builder doesn't gate on confidence. The schema + critic + Taylor's
conversational review have already filtered for quality. Low-confidence
ideas should rarely make it to `accepted`; if one does, the build still
runs against the brainstorm as written.

If you want to gate confidence at graduation time, add it to
`scripts/graduate.ts` — it's the right place. Today the policy is "Taylor
gates with the accept/reject decision."
