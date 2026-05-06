# Dashboard reference

The interactive `harness` (no args) entry point. This doc is for the
"why and how" — the README has the user-facing keymap and zone
breakdown.

## What it is

A 3-zone Ink TUI that consumes the engine's existing data surface
(idea files, runs/<id>/events.ndjson, runs/journal.ndjson) and turns
it into a portal that's enough for the daily loop without leaving
the terminal:

- **capture** a half-formed thought (`c`)
- **review** brainstormed ideas with verdict + variants + risks visible
  inline (`a` / `r` / `t` / `enter` to expand)
- **spawn** brainstorm or ship runs from the inline verb palette (`:`)
- **watch** any active run live, multi-streamed across run dirs (rows
  in IN FLIGHT auto-tail their own events.ndjson; `enter` zooms into
  the watch TUI fullscreen and returns to the dashboard on q)
- **see** the lifecycle of every recent idea collapsed into a glyph
  trail (TODAY)

It is mission control, not a row browser. The first version was a
list with arrow keys; this rewrite re-frames around what the engine
is *doing* and what *needs you* — both in the same view.

## Architecture

```
bin/harness.ts                     CJS — registers all verbs
└─ scripts/commands/dashboard.ts   CJS — verb (state machine)
    ├─ creates snapshot()          reads listIdeas + readJournal +
    │                              scanActiveRuns + buildTodayLifecycle
    ├─ render dashboard ESM child  via dynamic import("./_dashboard")
    │   └─ scripts/commands/_dashboard/
    │      ├─ index.tsx           Ink component, pure renderer
    │      ├─ data.ts             primitives — pure fns, no lib imports
    │      └─ tail.ts             WatcherFleet for fan-out tailing
    ├─ on action {kind: "build"}   spawn child + render watch
    ├─ on action {kind: "watch"}   render watch on existing events.ndjson
    ├─ on action {kind: "open"}    print idea filepath to stdout
    └─ loop: dashboard ↔ subview
```

Key invariant: **the renderer never imports from `scripts/lib/*` at
runtime.** tsx loads `index.tsx` and `data.ts` via the ESM loader,
and named imports against the CJS lib modules fail through that
loader (the bug we hit in iteration 1). The verb is CJS, calls all
lib helpers, and passes results in via the snapshot callback +
mutation callbacks (`onAccept`, `onReject`, `onCapture`,
`onSpawnVerb`).

## Data primitives (`_dashboard/data.ts`)

All pure, all caller-injected; no fs reads except for parsing brain-
storm bodies (which take an absolute path).

| function | input | output |
|---|---|---|
| `computeNext(ideas)` | IdeaSummary[] | NextPick or null |
| `scanActiveRuns(runsDir)` | abs path | ActiveRun[] |
| `parseBrainstormSections(filepath)` | abs path | { problem, variants, topRisks, ifAcceptedBuild } |
| `buildTodayLifecycle(ideas, journal, opts)` | arrays | LifecycleEntry[] (one per slug) |
| `awaitingIdeas(ideas)` | IdeaSummary[] | filtered+sorted |
| `buildableIdeas(ideas)` | IdeaSummary[] | filtered+sorted |

`buildTodayLifecycle` collapses N status flips per slug into one row
showing the trail in chronological order. By default drops orphan
slugs (no idea file); pass `includeOrphans: true` for audit views.
Same-timestamp events stage-rank-sort so capture+brainstorm at the
same instant render as `↓💭` not `💭↓`.

### Trail glyph keymap

| glyph | stage |
|---|---|
| `↓` | captured |
| `💭` | brainstormed |
| `▲` | needs-more-thought |
| `✓` | accepted (also shipped) |
| `✗` | rejected |
| `◆` | build started |
| `★` | PR opened |
| `⚡` | auto-flowed by the engine — injected before the
       accepted/rejected glyph when `IDEA_HARNESS_AUTO_FLOW=true`
       drove the transition (e.g., `↓💭⚡✓`). The NEXT bar also
       prefixes `⚡` when its picked idea was auto-flowed; the
       AWAITING YOU empty state swaps inbox-zero copy for an
       auto-flow tally. See README "Auto-flow" for the full
       semantics. |

`scanActiveRuns` flags runs as `stalled: true` when their latest
event is > 5 minutes old. The renderer paints these with `⏸`
instead of the spinner so a wedged builder doesn't look like it's
making progress.

## Multi-stream tailing (`_dashboard/tail.ts`)

`WatcherFleet.reconcile(targets, onEvent)` accepts the current set
of active run targets and ensures one Watcher per runId. New runs
spawn watchers; finished runs (no longer in targets) get their
watchers stopped. Each Watcher polls its events.ndjson at 400ms,
splits chunks at newlines so a poll boundary mid-write doesn't feed
JSON.parse a half-line, and tracks byte position for incremental
reads.

Per-run live state lives in `state.liveByRun: Map<runId, {events,
eventCount}>`. FlightRow reads its slice; if absent (e.g. fresh
run before first poll) falls back to the `latestEvent` snapshot
from `scanActiveRuns`.

## Cursor stickiness

Selection is logical, not numeric. `selectedRef = {zone, slug |
runId}` updates on every navigation (arrows, j/k, g/G, Tab). On
each items-list refresh:

1. If `selectedRef` is in the new items, snap cursor there.
2. Otherwise clamp cursor to the same numeric index (slide to next
   neighbor) and adopt whatever's there as the new ref.

Effect: pressing `a` on an awaiting idea (which removes it from
AWAITING YOU) doesn't move the cursor — it stays on whatever was
*next to* the accepted one. This is verified end-to-end by
`_smoke_cursor.ts` against both user-triggered and out-of-band
mutations.

## Subviews and handoff

The verb is a state machine that loops dashboard ↔ subview:

```
while (true) {
  const { action } = await renderDashboard({ ... });
  if (action.kind === "quit") break;
  if (action.kind === "open") { print path; break; }
  if (action.kind === "watch") {
    await renderWatchTui({ eventsPath, exitOnTerminal: false,
      exitHint: "q to return to dashboard · ctrl+c to exit" });
    continue;
  }
  if (action.kind === "build") {
    await runBuildWithWatch(idea);  // spawns child + watch
    continue;
  }
}
```

The watch TUI gets a custom `exitHint` so q clearly returns rather
than appearing to "quit the harness session."

## Smoke coverage

16 dedicated smoke files in `_dashboard/_smoke_*.ts`, plus the
static render demo `_smoke.ts`. Run them all via npm or directly:

```bash
npm test                                              # full suite
npm run test:quick                                    # skip build smoke
npm run test:verbose                                  # dump stderr on failures
npm run check                                         # tsc + smokes
tsx scripts/commands/_dashboard/_smoke_all.ts         # equivalent to `npm test`
```

Or run an individual suite:

```bash
tsx scripts/commands/_dashboard/_smoke.ts --cols=60   # static render
tsx scripts/commands/_dashboard/_smoke_live.ts        # multi-stream tail
tsx scripts/commands/_dashboard/_smoke_handoff.ts     # watch handoff
tsx scripts/commands/_dashboard/_smoke_capture.ts     # `c` flow
tsx scripts/commands/_dashboard/_smoke_palette.ts     # `:` flow
tsx scripts/commands/_dashboard/_smoke_help.ts        # `?` overlay
tsx scripts/commands/_dashboard/_smoke_header.ts      # widths 100→30
tsx scripts/commands/_dashboard/_smoke_today.ts       # lifecycle collapse
tsx scripts/commands/_dashboard/_smoke_cursor.ts      # cursor stickiness
tsx scripts/commands/_dashboard/_smoke_stalled.ts     # stall detection
tsx scripts/commands/_dashboard/_smoke_abandon.ts     # `x` abandon stalled
tsx scripts/commands/_dashboard/_smoke_build.ts       # build-spawn handoff
tsx scripts/commands/_dashboard/_smoke_edge.ts        # cold start, missing dirs
tsx scripts/commands/_dashboard/_smoke_why.ts         # verdict rationale
tsx scripts/commands/_dashboard/_smoke_search.ts      # `/` text search
tsx scripts/commands/_dashboard/_smoke_empty.ts       # filtered vs genuine empty-state
tsx scripts/commands/_dashboard/_smoke_cli.ts         # --json/--ndjson contract
```

175 assertions total, all currently passing (16 suites in ~33s).
Each smoke creates and cleans up its own scratch artifacts (run
dirs, idea files, journal entries via `purgeJournalForSlug`) so
re-running them never leaves state behind.

## Gotchas

- **Ink's stdout TTY detection**: when rendering into a captured
  Writable (smokes), set `(stdout as any).isTTY = true` or Ink falls
  back to "static" mode and only emits one frame. Without this the
  live tail smoke catches no updates.
- **Bare `\x1b` from synthetic stdin**: Ink's escape parser waits for
  a follow-up byte before declaring a bare ESC, so smokes that need
  to test "Esc cancels X" should use `q` or another close key
  instead.
- **Wide-mode AwaitDetail row composition**: each row is a single
  `<Text>` with nested colored spans, not multiple sibling `<Text>`
  elements. Yoga collapses trailing whitespace between adjacent
  Text siblings, which was eating the space between gutter labels
  and content. Nesting inside one Text gives a predictable string.
- **Title budgets must subtract inherited paddingLeft**. The
  `cap = cols - gutter - 1` math has to also subtract AwaitRow's
  paddingLeft (2) and AwaitDetail's paddingLeft (4), or rows wrap
  to two visual lines at exactly 100 cols.

## What this dashboard does NOT yet do

These are deliberate cuts — the dashboard is a portal, the engine is
where these would live:

- **Auto-flow**: high-confidence brainstorms still wait for a human
  `a`. The vision (per the iteration-2 reframe) is to default to
  flow, with the dashboard only surfacing `needs-more-thought` and
  edge cases. That's an engine change, not a dashboard one.
- **Loop on needs-more-thought**: today the user sees the verdict and
  bounces; ideally the system spawns a scope-sharpener that asks one
  clarifying question and re-brainstorms.
- **PR follow-through**: `pr-open` is currently a terminal state in
  the dashboard's view. Real shipping is `merged`, which means
  watching CI + addressing review comments via Claude Code. Engine
  scope.
- **Self-critique**: brainstorm → PR landed cleanly? Tag the run.
  Feed signal back into the brainstormer. Out of dashboard scope.
