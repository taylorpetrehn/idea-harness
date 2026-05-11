# {PROJECT} — Conventions

These conventions are injected into every idea-harness builder spawn and
should be honored by any agent (or human) implementing in this repo. For
richer context, see this repo's `CLAUDE.md` / `AGENTS.md` / `docs/`.

The harness reads this file when projects.yml has
`conventions_path: ".harness/conventions.md"` for this project. See
`~/.claude/skills/idea-harness/SKILL.md` "Per-project context resolution".

## The Five Principles

### 1. Follow Existing Patterns
Before designing anything, find 2–3 places in the codebase that solve a
similar problem. Extend what's there.

### 2. DRY — Reuse Before Duplicating
Reuse existing models, components, and modules rather than duplicating
logic. If a similar abstraction exists, extend it.

### 3. Extend Before Inventing
Add to existing endpoints, components, and modules before creating new
ones. Prefer extension over parallel new surface.

### 4. Scope Discipline
Every PR must include a "Not included" section listing scope deliberately
left out. This forces confronting scope creep before it ships.

### 5. Architecture Alignment
New code should fit the existing architecture — use established layer
boundaries and patterns.

## Project Specifics

> Replace this section with patterns specific to {PROJECT} — language /
> framework conventions, naming, testing, deployment, anything an agent
> needs to know to write code that fits in. Examples: background-job
> framework, service / module naming, authorization library, multi-tenancy
> axis, test command, lint command, deploy gates.

- **TODO**

## Prompt Fragment

Include this in every builder spawn task:

```
CONVENTIONS (follow these):
- Find 2-3 existing patterns in the codebase before designing anything new. Extend, don't invent.
- DRY: reuse existing abstractions rather than duplicating logic.
- Extend existing endpoints / components before creating new ones.
- PR description must include a "Not included" section listing what you deliberately left out.
- New code should fit the existing architecture — use established patterns and layer boundaries.

{PROJECT} specifics:
- TODO: replace with project-specific guardrails.
```
