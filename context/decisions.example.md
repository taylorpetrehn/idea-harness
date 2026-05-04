# Conscious Decisions — What We're NOT Building (Tier 1) — TEMPLATE

> **This is a template.** Copy to `context/decisions.md` (which is gitignored)
> and fill in with real decisions as you make them. The brainstormer reads
> `context/decisions.md` on every idea and cites entries here to avoid
> re-litigating settled questions.
>
> Append-only ledger of deliberate non-choices. Each entry is one decision
> with the reason. Newer entries go at the bottom. The harness keeps the
> most recent ~6–10 entries in Tier 1 once you exceed the budget cap; older
> entries stay in the file for reference but are dropped from the prompt.
>
> Format: `### YYYY-MM-DD — <one-line decision>` then 1–3 sentences of why.

---

### YYYY-MM-DD — <one-line decision> (example)
1–3 sentences explaining the reason. Be specific about the cost being
avoided and what category of incoming idea this should kill. Example:
"New ideas that propose `<pattern>` should verdict `reject` with a pointer
to this entry."

### YYYY-MM-DD — <another decision> (example)
What you decided not to do, and the failure mode you're protecting against.
Specifying the failure mode matters more than specifying the decision —
the brainstormer uses the failure mode to recognize disguised versions of
the same proposal.

<!--
Tips for writing good entries:

  1. Frame as a non-choice, not a choice. "We won't add gamification"
     is more useful to the brainstormer than "Gamification is bad."

  2. Name the trigger pattern. The brainstormer matches incoming ideas
     against decisions; if the trigger isn't named, it can't match.
     Bad:  "Stay simple."
     Good: "Reject ideas that add a new database table for X — we use
            the existing Y table with a type column."

  3. Date the decision. Old decisions get stale; the date lets you
     trim or revisit on a schedule.

  4. Cite evidence sparingly. "Multiple staff flagged this" is fine.
     Long postmortems belong in a docs system, not Tier 1 context.

  5. Prefer "verdict reject with pointer here" over "we'll think about it."
     Decisions are for closed questions.
-->
