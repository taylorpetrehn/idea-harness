# Proposal: `harness` — a verb-driven CLI for humans and agents

Draft. Status: open for discussion.

## Context

Today the harness is a collection of `ts-node` entrypoints invoked via
`npm run <verb>`. Each script parses `process.argv` by hand, prints
ad-hoc JSON or text, and exits. The pipeline itself is solid — five
gated stages (plan → harvest → brainstorm → schema → critic) plus a
worktree-isolated build/ship/resume layer that produces real PRs. The
weakness isn't the model layer; it's the *surface*.

Three things stop the harness from being a "premium" tool:

1. **No single binary.** Discoverability, completions, manpage, pinning
   versions, and `npx`-style invocation all want one entrypoint.
2. **No stable machine contract.** Agents can read `review next` JSON,
   but nothing else is structured. There's no event stream during
   long-running brainstorms or builds, so an agent driving the harness
   can only poll files.
3. **No agent-native invocation.** The harness already runs *inside*
   Claude sessions through the `idea-to-pr` skill, but the skill talks
   to it via shell. There's no MCP/HTTP transport that another
   agent (or another Claude) could attach to cleanly.

Goal: make `harness` a tool that a human and an agent reach for with
equal confidence — same verbs, same output shape, predictable errors,
streaming progress, exhaustive `--help`.

## Vision

```
harness capture "the dm cohorts feel limiting"
harness brainstorm                 # full pass
harness ideas waiting --json
harness review accept dm-cohorts --variant 2
harness ship                       # do the next obvious thing
harness build watch dm-cohorts     # live event stream
harness doctor                     # check env health
harness serve --mcp                # expose to other agents
```

One binary. One verb tree. Same surface for `--json` (single result),
`--ndjson` (event stream), and pretty TTY (default for humans).

## Surface (canonical noun-verb form)

```
# Capture (was: harvester + Reminders)
harness capture <text>                      # ad-hoc seed from CLI
harness capture --from reminders            # macOS Reminders (current path)
harness capture --from issue <url>          # GitHub issue
harness capture --from stdin                # pipe in JSON or text
harness capture --from slack <channel>      # Slack message capture (later)

# Inspect ideas
harness ideas list   [--status <s>] [--project <p>] [--json|--ndjson]
harness ideas show   <slug> [--section brainstorm|notes|frontmatter] [--json]
harness ideas waiting                        # alias for status=brainstormed | needs-critic-review

# Run the brainstorm pipeline (was: garden)
harness brainstorm [<slug>]
   --idea <slug>     # focus one
   --dry             # plan only
   --ndjson          # stream events: plan, brainstorm.start, critic.verdict, ...

# Conversational review hooks (was: review.ts)
harness review next                          # JSON envelope for the next idea
harness review accept <slug> [--variant N] [--note "..."]
harness review reject <slug> [--note "..."]
harness review thought <slug> [--note "..."]
harness review in-flight                     # accepted / building / pr-open

# Ship/build/resume (was: ship.ts, graduate.ts, resume.ts)
harness ship   [<slug>] [--variant N] [--yes] [--dry]   # do the obvious next thing
harness build  <slug>  [--variant N] [--dry]             # explicit fresh build
harness resume <slug>                                    # recover stuck `building`
harness build watch  <slug>                              # tail live events
harness build status <slug>                              # current state JSON

# Operational
harness cleanup [--apply] [--include-rejected] [--orphans]
harness inspect [--runs N] [--metric <name>] [--since 24h] [--json]
harness doctor                               # env health: projects.yml, claude, gh, reminders perms
harness contracts                            # emit JSON schemas for every output

# Servers (so agents can attach)
harness serve --mcp                          # MCP server over stdio
harness serve --http :7717                   # HTTP API for webhooks/UI

# Discovery / DX
harness completions <bash|zsh|fish>
harness --help, --version
```

## Output contract

Every command, when called with `--json`, emits a single envelope:

```jsonc
{
  "schema": "harness/v1",
  "verb": "review.next",
  "ok": true,
  "data": { /* verb-specific */ },
  "warnings": [],
  "hint": "Next: `harness ship` to graduate it"
}
```

On error:

```jsonc
{
  "schema": "harness/v1",
  "verb": "ship",
  "ok": false,
  "error": {
    "code": "BUILD_FAILED",
    "message": "Builder claude session timed out after 1800000ms",
    "recoverable": true
  },
  "hint": "Run `harness resume <slug>` to land any in-flight work"
}
```

Long-running commands with `--ndjson` emit one JSON object per line.
Event types are namespaced (`brainstorm.start`, `brainstorm.tokens`,
`critic.verdict`, `build.spawn`, `build.pr_url`, `done`).

`harness contracts` emits the full Zod-derived JSONSchema for every
envelope and event so agents can validate without guessing.

## Architecture changes from today

| Today | Next-gen |
|---|---|
| `npm run garden`, `npm run ship`, etc. | `bin/harness` (single binary) routing to the same verb fns |
| Manual `process.argv` parsing | `commander` (or `clipanion`) — autogenerated help, completions |
| Ad-hoc `console.log` / JSON.stringify | `lib/output.ts` envelope: pretty / `--json` / `--ndjson` |
| Build session = blob of stdout | NDJSON events written to `runs/<id>/events.ndjson` |
| Agents poll files | `harness serve --mcp` exposes verb fns as MCP tools |
| Reminders-only ingestion | `lib/sources/{reminders,stdin,issue,slack}.ts` plug into one harvester |
| Three places store `loop_count` | One owner (`lib/ideas.ts`); state file becomes a cache |
| No tests | vitest covers verb fns + parsers (schema, slug, ideas) |
| No env health check | `harness doctor` — like `expo-doctor` |

Concrete refactor: each command file becomes
`scripts/commands/<verb>.ts` exporting a typed `run(args): Result`
function. The CLI in `bin/harness.ts` is just argv → fn → output.
The MCP server and HTTP server are thin wrappers over the same fns.
That's what makes "humans and agents use the same surface" mechanical
rather than aspirational.

## Reliability upgrades worth bundling in

These are visible-but-quiet wins that the current code is one bug away
from needing anyway:

- **Single writer for status.** `lib/ideas.ts` is the only module that
  mutates frontmatter. Today `builder.ts:recordPrOnIdea` writes
  `github_pr` directly, and `state/loops.json` mirrors `loop_count`
  separately. Drift is a real risk.
- **Atomic writes** via temp-file + rename in `lib/ideas.ts`.
- **Run journal** at `runs/journal.ndjson` — every status transition
  appends a line. `harness inspect --since 1h` becomes a tail.
- **Concurrency lock** at `state/garden.lock` so two `harness
  brainstorm` runs don't race on the same idea.
- **Recovery hints on every error** so the next command is obvious to
  both human and agent.

## Migration plan (incremental, no big bang)

1. **Wire the binary.** `bin/harness.ts` with commander; route to the
   existing scripts via `child_process.spawn` initially. Keep all
   `npm run X` working. Result: `harness <verb>` works.
2. **Stable JSON envelope.** Introduce `lib/output.ts`; convert
   `review next`, `inspect`, `ideas list` first. Publish
   `harness/v1` schema doc.
3. **Promote scripts to verb fns.** Move `scripts/garden.ts` →
   `scripts/commands/brainstorm.ts` exporting `run()`. The CLI calls
   the fn directly; the npm script becomes a thin shim.
4. **NDJSON event streams.** `brainstorm` and `build` emit events.
   Add `harness build watch`.
5. **Doctor + completions.** Polish for new users.
6. **Sources abstraction.** Split out `lib/sources/*` so capture has
   plural inputs.
7. **MCP server.** Wrap verb fns. Auto-generate tool schemas from the
   Zod contracts.
8. **HTTP server + webhooks.** Last; useful when capturing from GitHub
   or Slack.
9. **Tests.** vitest, importing verb fns directly. Targets first:
   `lib/schema.ts`, `lib/slug.ts`, `lib/ideas.ts` parser, `commands/review.ts`.

Phases 1–4 alone deliver "premium CLI for humans + structured agent
contract". Phase 7 is the unlock for "agent-native".

## Decisions (locked)

1. **Scope:** Full phases 1–7 — binary, JSON envelope, verb fns,
   NDJSON streams, doctor, completions, multi-source capture, MCP
   server.
2. **CLI library:** `commander`.
3. **Naming:** `harness` (binary name), invoked as `harness <verb>`.
4. **Backwards compat:** None. `npm run X` is dropped on the same
   commit `harness` lands. Clean break.
5. **Distribution:** Single repo, ts-node-shebang `bin/harness.ts`
   referenced from `package.json` `bin` field, so `npm link` /
   `npm install -g .` makes `harness` global. No npm publish in this
   pass.

## Implementation plan

Files are listed in build order. Each numbered block is a self-contained
chunk that can be committed and shipped on its own.

### 0. Foundations
- Add deps: `commander`, `zod`, `vitest`, `tsx`. Drop `ts-node` in favor
  of `tsx` (faster, ESM-friendly).
- `package.json`: add `"bin": { "harness": "bin/harness.ts" }`. Replace
  `scripts` block with just `{ test, typecheck }` — no run-script
  shims, per the clean-break decision.
- `tsconfig.json`: keep TS strict, add `bin/` to includes.

### 1. Output envelope + contracts
- `scripts/lib/output.ts` — `out.result(data, hint?)`, `out.event(type, data)`,
  `out.error(code, message, hint?)`, `out.warn(msg)`. Mode (`pretty | json | ndjson`)
  comes from a top-level flag in commander, stored in a request-scoped object.
- `scripts/lib/contracts.ts` — Zod schemas for the envelope, error,
  every verb's `data` shape, every event type. One file, one source of
  truth.
- `scripts/commands/contracts.ts` — `harness contracts` dumps JSON
  Schema for agent consumption.

### 2. Binary + commander wiring
- `bin/harness.ts` — shebang `#!/usr/bin/env tsx`. Builds the
  command tree, parses argv, sets output mode, dispatches to a verb fn.
- `scripts/commands/_register.ts` — central place where every verb
  registers its commander definition.

### 3. Promote scripts to verb fns
Each becomes `scripts/commands/<verb>.ts` exporting
`async function run(args): Promise<Result>`. `bin/harness.ts` is the
only argv consumer; verb fns take typed args.

- `commands/capture.ts` — was: harvester invocation. Adds `--from
  reminders|stdin|issue|text`. (Phase 5 expands the source list.)
- `commands/brainstorm.ts` — was: garden.ts. Same plan→harvest→brainstorm→schema→critic
  loop, now emits NDJSON events when `--ndjson`.
- `commands/ideas.ts` — `list`, `show`, `waiting` subcommands.
- `commands/review.ts` — `next`, `accept`, `reject`, `thought`, `in-flight`, `set`.
- `commands/ship.ts` — was: ship.ts. Picks next eligible idea.
- `commands/build.ts` — `<slug>` (fresh), `resume <slug>`, `watch <slug>`,
  `status <slug>`. `watch` tails `runs/<id>/events.ndjson`.
- `commands/cleanup.ts`, `commands/inspect.ts` — straight ports.
- `commands/doctor.ts` — env health: projects.yml parses, every
  `local_path` exists, claude bin found, gh auth, `ANTHROPIC_API_KEY`
  set or CLI auth working, Reminders perms (macOS), git worktree
  available.
- `commands/completions.ts` — emits zsh/bash/fish completion script,
  with live slug completion sourced from `ideas/`.

### 4. NDJSON event streams
- `scripts/lib/events.ts` — `emit(type, data)` writes to both stdout
  (when ndjson mode) and `runs/<id>/events.ndjson`.
- `scripts/agents/brainstormer.ts` — emit `brainstorm.start`,
  `brainstorm.context_request`, `brainstorm.tokens`, `brainstorm.done`.
- `scripts/agents/critic.ts` — emit `critic.verdict`.
- `scripts/agents/builder.ts` — emit `build.spawn`, `build.stdout` (chunked),
  `build.pr_url`, `build.done` / `build.failed`. Replaces the current
  free-form stdout streaming.

### 5. Source abstraction
- `scripts/lib/sources/index.ts` — `Source { id, fetch(): Promise<RawIdea[]> }`.
- `scripts/lib/sources/reminders.ts` — port of current `reminders.ts`.
- `scripts/lib/sources/stdin.ts` — JSON or text on stdin.
- `scripts/lib/sources/issue.ts` — `gh issue view <url>` adapter.
- `scripts/lib/sources/slack.ts` — stubbed for now; interface only.
- `scripts/agents/harvester.ts` becomes a thin dispatcher.

### 6. Reliability bundle
- `scripts/lib/ideas.ts` — atomic writes (temp + rename); becomes the
  *only* writer of frontmatter. `builder.ts:recordPrOnIdea` switches to
  call `setFrontmatterField(slug, "github_pr", url)`.
- `scripts/lib/journal.ts` — `appendJournal(event)` writes
  `runs/journal.ndjson`. Status transitions, run start/end, build
  spawn, PR opened all emit one line.
- `scripts/lib/lock.ts` — file-lock helper used by `brainstorm` and
  `ship` to refuse to run if another instance holds `state/<verb>.lock`.
- Single owner for `loop_count` — `lib/loops.ts` becomes a derived
  cache, not a second source of truth.

### 7. MCP server
- `scripts/commands/serve.ts` — `harness serve --mcp` and `--http :PORT`.
- MCP transport: stdio. Each verb fn is auto-wrapped as an MCP tool;
  the tool's input schema is the verb's Zod contract from
  `lib/contracts.ts`. Tool output is the same `harness/v1` envelope.

### 8. Tests (vitest)
First targets — pure functions and parsers:
- `lib/schema.ts` — schema check on real and synthetic brainstorms.
- `lib/slug.ts` — short-slug resolution edge cases.
- `lib/ideas.ts` — `parseIdeaFile`, `setStatus`, `appendNote`.
- `lib/output.ts` — envelope shape, ndjson framing.
- `commands/review.ts` — `next` and `accept` against a tmp `ideas/` dir.

### Cutover

The commit that lands phases 0–3 also rewrites `package.json` `scripts`.
There is no transitional release. The README and SKILL.md get a
single-shot rewrite the same commit.

## What ships in the first session

A single PR delivering phases 0–3 above:
- `bin/harness` runs and dispatches.
- `harness <every-current-verb>` works with pretty + JSON output.
- The `npm run X` surface is gone.
- README and SKILL.md updated.

Phases 4–7 land in subsequent PRs.

## Out of scope (intentionally)

- Replacing the brainstorm/critic agents themselves. The pipeline is
  good; the surface is the gap.
- A web UI. The "premium" experience is *CLI* and *MCP*. A UI can
  follow once the contract is stable.
- Multi-tenant / team mode. This is a personal harness today; keep it
  that way until it isn't.
