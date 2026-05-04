# Product Context (Tier 1) — TEMPLATE

> **This is a template.** Copy to `context/product.md` (which is gitignored)
> and fill in for your product. The brainstormer reads `context/product.md`
> on every idea — keep it concise, current, and decision-relevant.
> Aim for ~1,500 tokens or less; the harness will trim above the budget cap
> in `contracts/context-budget.md`.
>
> Delete every `<…>` placeholder before saving. If a section doesn't apply
> to your product, delete the whole section rather than leaving it stub.

## What <Product Name> is

One paragraph: what the product does, who it's for, what it is *not*.
Examples of what to include:
- One-sentence purpose ("X is the operations platform for Y").
- Who actually uses it (employees? customers? internal team?).
- One sentence on what it deliberately is not (not a marketplace, not a
  consumer app, not a public-facing API, etc.).

## Stack

Bullet list, one line per layer. The brainstormer uses this to ground
"existing footprint" reasoning. Include framework, language, deploy target,
notable infrastructure pieces.

- **Backend:** <framework + language>, deployed to <where>. <DB>. <jobs>.
- **Frontend / web:** <framework or "server-rendered" + bundler>.
- **Mobile:** <framework, e.g., Expo / native iOS / native Android> if any.
- **Auth:** <how authn works>.
- **Notable third-party services:** <chat, payments, analytics, etc.>.

If your project has a deployment promotion path (preview → main → prod),
say so explicitly — the brainstormer will use it when reasoning about scope.

## Surface areas (the things ideas usually touch)

5–10 bullets. The categories ideas tend to land in. This is what the
brainstormer scans against to write the "Audience" and "Existing footprint"
sections of a brainstorm.

- **<Surface 1>** — short description
- **<Surface 2>** — short description
- **<Surface 3>** — short description

## Current focus (rolls forward; revisit monthly)

2–4 bullets. The actual things you're working on right now. The brainstormer
weights the verdict toward ideas that align with current focus, and away
from ideas that pull attention off it.

- **<Focus area 1>** — one sentence on the goal
- **<Focus area 2>** — one sentence on the goal

## How to think about ideas in this context

Optional. 3–5 short rules that shape how the brainstormer should evaluate
ideas in your domain. Examples:

- **Mobile-first by default** if your users live in an app, not a browser.
- **Audience must name a real role**, not "the user."
- **Multi-tenant by <dimension>** if every record needs a scope.
- **Don't invent new UI primitives** — variants should reuse existing
  components before adding new ones.

These rules become enforceable via the critic rubric over time.

## Reference paths (for Tier 2 codebase reads)

Optional but useful. Absolute paths the brainstormer can request via
Tier 2 `codebase_read`. Without these the harness falls back to whatever
`projects.yml` says.

- `<repo>/<path/to/data/layer>` — data models
- `<repo>/<path/to/controllers>` — entry points
- `<repo>/<path/to/services>` — domain logic
- `<repo>/<conventions doc>` — repo conventions

## Out of scope for THIS harness

Optional. If you run multiple products and only want this harness to evaluate
ideas for one of them, say so explicitly. The brainstormer will verdict
out-of-scope ideas as `needs-more-thought` with a "wrong project" note
rather than silently brainstorming the wrong thing.
