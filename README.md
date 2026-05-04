# Idea Harness

A purpose-built harness for capturing, brainstorming, and graduating LetsBarker
ideas. Built on the five-layer harness pattern.

This is the **idea system** — the thinking layer between raw capture and the
build pipeline. The build pipeline (`idea-to-pr`) lives separately and consumes
`accepted` ideas from this harness.

## Quick Start

```bash
# 1. Seed your product context from the templates
cp context/product.example.md   context/product.md
cp context/decisions.example.md context/decisions.md
$EDITOR context/product.md context/decisions.md   # fill them in

# 2. Install deps
npm install

# 3. Run a full harness pass
npm run garden

# 4. Review ideas conversationally in Claude (mobile or desktop)
#    Just ask: "What ideas are waiting for me?"

# 5. Inspect what the last run did
npm run inspect
```

> `context/product.md` and `context/decisions.md` are gitignored on purpose —
> they describe your specific product and usually contain internal details
> the rest of the repo doesn't need to know about. The shipped templates
> (`*.example.md`) tell you what to put where.

## Architecture at a Glance

```
TRIGGERS (manual / event / conversational)
   ↓
CONTROL — initializer plans the run
   ↓
CONTEXT — Tier 1 always, Tier 2/3 on request, with token budget
   ↓
EXECUTION — brainstormer produces output (fresh context per idea)
   ↓
VERIFICATION — critic gates output against the rubric
   ↓
STATE — durable artifacts in ideas/ and runs/
   ↓
HANDOFF — Taylor reacts conversationally → accepted ideas graduate
```

See `SKILL.md` for the full design and `contracts/` for the machine-checkable
output contracts at each handoff.

## File Layout

```
idea-harness/
  SKILL.md                          ← full design and contracts
  README.md                         ← this file
  ideas/<slug>.md                   ← work product, one per idea
  context/
    product.example.md              ← template; copy to product.md (gitignored)
    decisions.example.md            ← template; copy to decisions.md (gitignored)
  contracts/
    brainstorm-output.md            ← required brainstorm structure
    critic-rubric.md                ← critic's pass/fail criteria
    context-budget.md               ← Tier 1/2/3 + token caps
    handoff-to-build.md             ← what idea-to-pr expects
  references/
    idea-schema.md                  ← idea file frontmatter + body
  scripts/
    garden.ts                       ← top-level orchestrator
    review.ts                       ← conversational review CLI helpers
    inspect.ts                      ← view latest run + metrics
    agents/
      initializer.ts                ← L2: plans the run
      harvester.ts                  ← Reminders → raw idea files
      brainstormer.ts               ← L4: brainstorms one idea
      critic.ts                     ← L5: gates output
    lib/
      ideas.ts                      ← idea file read/write
      runs.ts                       ← run lifecycle
      context.ts                    ← Tier 1/2/3 loading
      llm.ts                        ← model adapters
      reminders.ts                  ← Reminders MCP adapter
      loops.ts                      ← loop detection
      projects.ts                   ← project routing
      budgets.ts                    ← token budget policy
      text.ts                       ← slugify, fuzzy match
      log.ts                        ← stderr logger
      metrics.ts                    ← rolling counters
  runs/                             ← per-run artifacts (auto-generated)
  state/                            ← rolling metrics (auto-generated)
```

## What's Wired Up

The scaffold ships with all adapters fully implemented — `npm run garden:dry`
runs end-to-end without code changes. What you do still need is the
*environment* the harness runs in:

- `lib/reminders.ts` — talks to Apple Reminders via `osascript`. Set
  `IDEA_HARNESS_REMINDERS=dry` to disable (used in tests / non-mac envs).
- `lib/projects.ts` — parses `~/.openclaw/workspace-bonnie/skills/idea-to-pr/references/projects.yml`
  by default. Override the path with `IDEA_HARNESS_PROJECTS_YML`.
- `lib/context.ts` — Tier 2 codebase reads resolve to the project's
  `local_path` from `projects.yml`. Override per-project with
  `IDEA_HARNESS_REPO_LETSBARKER`, `IDEA_HARNESS_REPO_CLAWD`, etc.
- `lib/llm.ts` — three transports, picked at runtime:
  - **SDK** when `ANTHROPIC_API_KEY` is set — uses `@anthropic-ai/sdk`
    (an *optional* dependency; install with `npm install` since it's
    declared in `optionalDependencies`).
  - **Claude CLI** otherwise — shells out to `claude --print --model <m>
    --system-prompt <s> --output-format json`, using whatever auth the
    CLI already has (subscription / OAuth / keychain). Force this mode
    with `IDEA_HARNESS_LLM=cli`. Token counts are parsed from the JSON.
  - **Offline** stub via `IDEA_HARNESS_LLM=offline` — deterministic
    output for tests.

  Model IDs are env-configurable: `IDEA_HARNESS_BRAINSTORMER_MODEL`,
  `IDEA_HARNESS_CRITIC_MODEL`. CLI binary path:
  `IDEA_HARNESS_CLAUDE_BIN`. Per-call timeout: `IDEA_HARNESS_CLAUDE_TIMEOUT_MS`
  (default 300000).
- `agents/brainstormer.ts` — round-trips Tier 2 context_request emissions
  back to the model up to `IDEA_HARNESS_TIER2_MAX_REQUESTS` (default 3).

For real runs: set `ANTHROPIC_API_KEY`, ensure the Reminders app has a list
called "App Ideas", then `npm run garden`.

## Environment Variables

| Var | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | API key — picks the SDK transport when set | — (CLI transport) |
| `IDEA_HARNESS_LLM` | `sdk` / `cli` / `offline` — force a transport | auto |
| `IDEA_HARNESS_CLAUDE_BIN` | path to the `claude` binary | resolved on PATH |
| `IDEA_HARNESS_CLAUDE_TIMEOUT_MS` | per-CLI-call timeout | 300000 |
| `IDEA_HARNESS_REMINDERS` | `dry` to skip Apple Reminders | live on macOS |
| `IDEA_HARNESS_BRAINSTORMER_MODEL` | brainstormer model id | `claude-opus-4-7` |
| `IDEA_HARNESS_CRITIC_MODEL` | critic model id | `claude-haiku-4-5-20251001` |
| `IDEA_HARNESS_PROJECTS_YML` | path to `projects.yml` | idea-to-pr default |
| `IDEA_HARNESS_REPO_<KEY>` | repo path override per project | from `projects.yml` |
| `IDEA_HARNESS_PER_IDEA_TARGET` | soft token target per brainstorm | 10000 |
| `IDEA_HARNESS_PER_RUN_CAP` | hard run-level token cap | 100000 |
| `LOG_LEVEL` | `silent`, `error`, `warn`, `info`, `debug` | `info` |

## Why This Shape

Six principles drove the design:

1. **The harness is the product, not the model.** Swapping Claude versions
   should change quality, not break the system.
2. **Subtraction over addition.** Each agent sees minimum context.
3. **Fresh context beats compaction.** Each idea gets a clean window.
4. **Durable artifacts over conversation history.** Files are the truth.
5. **Human at the right gate, exactly once.** Conversational review.
6. **Honesty over enthusiasm.** Critic explicitly checks for hand-wavy output.
