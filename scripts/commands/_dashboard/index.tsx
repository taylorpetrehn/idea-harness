/**
 * scripts/commands/_dashboard/index.tsx
 *
 * Mission control for the idea-to-PR engine. `harness` (no args) drops
 * you here.
 *
 * Three zones, one cursor:
 *   NEXT           — single line, the obvious-next action.
 *   IN FLIGHT      — every active run, live-tailed from events.ndjson.
 *   AWAITING YOU   — brainstormed ideas with verdict expanded inline.
 *   TODAY          — rolling 24h activity from journal + idea frontmatter.
 *
 * No engine writes inside the renderer; mutations go through callbacks
 * the caller supplies. Reads come from the `_dashboard/data.ts` and
 * `_dashboard/tail.ts` primitives so this file stays UI-shaped.
 */

import * as React from "react";
import { Box, Text, useApp, useInput, useStdout, render } from "ink";
import Spinner from "ink-spinner";

import type { IdeaSummary, IdeaStatus } from "../../lib/ideas";
import { withAltScreen } from "../_watch_tui/altscreen";

import {
  ActiveRun,
  ParsedEvent,
  TodayEntry,
  LifecycleEntry,
  computeNext,
  awaitingIdeas,
  parseBrainstormSections,
  ideaFilepath,
  relTime,
  fmtElapsed,
} from "./data";
import { WatcherFleet } from "./tail";

// ── action surface returned to the verb ─────────────────────────────

export type DashboardAction =
  | { kind: "build"; idea: IdeaSummary }
  | { kind: "watch"; run: ActiveRun; idea?: IdeaSummary }
  | { kind: "open"; idea: IdeaSummary }
  | { kind: "quit" };

export interface DashboardCallbacks {
  onAccept(slug: string): void;
  onReject(slug: string): void;
  onNeedsMoreThought(slug: string): void;
  /** Persist a fresh raw idea from the dashboard's inline capture input.
   *  Callback is synchronous so the dashboard's tick refresh picks it up
   *  on the next pass without exiting the renderer. */
  onCapture(text: string): { slug: string; project: string } | null;
  /** Spawn a harness verb in the background. Returning runs (brainstorm,
   *  ship) will surface in IN FLIGHT once their events.ndjson appears.
   *  Quick verbs (doctor) return a one-line summary to display inline. */
  onSpawnVerb(verb: string): { detached: boolean; message?: string };
}

// ── selection model ─────────────────────────────────────────────────
//
// The dashboard collapses three lists into one cursor. Each entry below
// is one focusable row; non-selectable lines (zone headers, hints) are
// not represented here.

type Selectable =
  | { zone: "flight"; runId: string }
  | { zone: "await"; slug: string }
  | { zone: "today"; slug: string };

export interface DashboardState {
  ideas: IdeaSummary[];
  runs: ActiveRun[];
  today: LifecycleEntry[];
  /** Tail-driven slice: latest event(s) per run id. */
  liveByRun: Map<string, { events: ParsedEvent[]; eventCount: number }>;
}

/** Snapshot the verb hands the dashboard on each refresh tick. */
export interface DashboardSnapshot {
  ideas: IdeaSummary[];
  runs: ActiveRun[];
  today: LifecycleEntry[];
}

// ── status & event styling ──────────────────────────────────────────

function statusColor(status: IdeaStatus | string): string {
  if (status === "shipped" || status === "pr-open") return "green";
  if (status === "building") return "cyan";
  if (status === "rejected") return "red";
  if (status === "needs-more-thought") return "yellow";
  if (status === "accepted") return "green";
  return "white";
}

function actionGlyph(action: string | undefined): { glyph: string; color: string } {
  if (action === "accept") return { glyph: "✓", color: "green" };
  if (action === "reject") return { glyph: "✗", color: "red" };
  if (action === "needs-more-thought") return { glyph: "▲", color: "yellow" };
  return { glyph: "·", color: "gray" };
}

const EVENT_GLYPHS: Record<string, { color: string; glyph: string }> = {
  "build.spawn":         { color: "cyan",   glyph: "◆" },
  "build.worktree.ready":{ color: "cyan",   glyph: "◆" },
  "build.stdout":        { color: "gray",   glyph: "·" },
  "build.exit":          { color: "green",  glyph: "✓" },
  "build.pr_open":       { color: "green",  glyph: "★" },
  "build.pr_url":        { color: "green",  glyph: "★" },
  "build.requested":     { color: "cyan",   glyph: "◆" },
  "build.started":       { color: "cyan",   glyph: "◆" },
  "build.done":          { color: "green",  glyph: "✓" },
  "build.failed":        { color: "red",    glyph: "✗" },
  "brainstorm.start":    { color: "cyan",   glyph: "◆" },
  "brainstorm.tokens":   { color: "gray",   glyph: "·" },
  "brainstorm.done":     { color: "green",  glyph: "✓" },
  "critic.verdict":      { color: "yellow", glyph: "▲" },
};

function eventStyle(type: string): { color: string; glyph: string } {
  return EVENT_GLYPHS[type] ?? { color: "white", glyph: "·" };
}

function summarizeEvent(ev: ParsedEvent): string {
  const t = ev.type;
  const d = ev.data;
  if (t === "build.stdout") return String(d.chunk ?? d.line ?? "").trim().split("\n").pop() ?? "";
  if (t === "build.spawn") return String(d.cmd ?? d.cwd ?? "spawning…");
  if (t === "build.pr_url" || t === "build.pr_open") return String(d.url ?? d.pr_url ?? "");
  if (t === "build.exit") return d.pr_url ? `pr ${d.pr_url}` : `exit ${d.exit_code ?? "?"}`;
  if (t === "brainstorm.tokens") {
    const v = d.tokens ?? d.count;
    return v !== undefined ? `${v} tokens` : "";
  }
  if (t === "critic.verdict") {
    return [d.verdict ?? d.recommended_action, d.confidence].filter(Boolean).join(" · ");
  }
  // Generic fallback
  if (typeof d.message === "string") return d.message;
  if (typeof d.line === "string") return d.line.trim();
  return "";
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function timeOfDay(iso: string): string {
  if (!iso) return "—";
  // HH:MM in local time so it lines up with the user's clock.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toTimeString().slice(0, 5);
}

// ── responsive helpers ──────────────────────────────────────────────

function useTerminalSize(): { cols: number; rows: number } {
  // Use Ink's stdout reference so the size matches whatever the renderer
  // is actually writing to — including a captured stream in the smoke.
  const { stdout } = useStdout();
  const read = React.useCallback(
    () => ({
      cols: (stdout as unknown as { columns?: number }).columns ?? 80,
      rows: (stdout as unknown as { rows?: number }).rows ?? 30,
    }),
    [stdout]
  );
  const [size, setSize] = React.useState(read);
  React.useEffect(() => {
    setSize(read());
    const onResize = () => setSize(read());
    (stdout as unknown as NodeJS.EventEmitter).on?.("resize", onResize);
    return () => {
      (stdout as unknown as NodeJS.EventEmitter).off?.("resize", onResize);
    };
  }, [stdout, read]);
  return size;
}

// ── small presenters ────────────────────────────────────────────────

function ZoneHeader({
  glyph,
  label,
  count,
  color,
}: { glyph: string; label: string; count: number; color: string }) {
  return (
    <Box marginTop={1}>
      <Text color={color} bold>{glyph} {label}</Text>
      <Text color="gray"> </Text>
      <Text color="gray" dimColor>· {count}</Text>
    </Box>
  );
}

function NextBar({ next, narrow, cols }: {
  next: ReturnType<typeof computeNext>;
  narrow: boolean;
  cols: number;
}) {
  if (!next) {
    // Single Text element so Ink doesn't wrap each fragment independently.
    const line = "nothing waiting — capture an idea or run harness brainstorm";
    return (
      <Box paddingX={1}>
        <Text color="gray" dimColor>NEXT  </Text>
        <Text color="gray">{truncate(line, cols - 8)}</Text>
      </Box>
    );
  }
  const glyph = actionGlyph(next.idea.recommended_action);
  const suffix = `${next.reason}  [${next.primary.key}] ${next.primary.label}`;

  if (narrow) {
    // Two-line vertical layout — title on row 1, action suffix on row 2.
    const titleBudget = Math.max(20, cols - 8);
    return (
      <Box paddingX={1} flexDirection="column">
        <Box>
          <Text color="cyan" bold>NEXT </Text>
          <Text color={glyph.color}> {glyph.glyph} </Text>
          <Text bold>{truncate(next.idea.title, titleBudget)}</Text>
        </Box>
        <Box>
          <Text color="gray">     {next.reason}  </Text>
          <Text color="cyan">[{next.primary.key}]</Text>
          <Text color="gray"> {next.primary.label}</Text>
        </Box>
      </Box>
    );
  }

  // Wide layout — title and action suffix on one row.
  const titleBudget = Math.max(20, cols - suffix.length - 12);
  return (
    <Box paddingX={1}>
      <Text color="cyan" bold>NEXT </Text>
      <Text color={glyph.color}> {glyph.glyph} </Text>
      <Text bold>{truncate(next.idea.title, titleBudget)}</Text>
      <Text color="gray">  {next.reason}  </Text>
      <Text color="cyan">[{next.primary.key}]</Text>
      <Text color="gray"> {next.primary.label}</Text>
    </Box>
  );
}

function FlightRow({
  run,
  idea,
  live,
  selected,
  narrow,
}: {
  run: ActiveRun;
  idea: IdeaSummary | undefined;
  live: { events: ParsedEvent[]; eventCount: number } | undefined;
  selected: boolean;
  narrow: boolean;
}) {
  const startedMs = new Date(run.startedAt).getTime();
  const elapsed = fmtElapsed(Date.now() - startedMs);
  const tail = (live?.events?.[live.events.length - 1]) ?? run.latestEvent;
  const eventCount = live?.eventCount ?? run.eventCount;
  const title = idea?.title ?? run.slug ?? run.runId;
  const project = idea?.project ?? "—";

  const verbLabel = run.verb;
  const verbColor = verbLabel === "build" ? "cyan" : verbLabel === "brainstorm" ? "yellow" : "white";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text color={verbColor} bold> {verbLabel}</Text>
        <Text color="gray"> · </Text>
        <Text bold={selected}>{truncate(title, narrow ? 40 : 60)}</Text>
      </Box>
      <Box paddingLeft={4} flexDirection={narrow ? "column" : "row"}>
        <Text color="gray">{project}</Text>
        <Text color="gray">{narrow ? "" : "  ·  "}</Text>
        <Text color="gray">{elapsed}</Text>
        <Text color="gray">{narrow ? "" : "  ·  "}</Text>
        <Text color="gray">{eventCount} ev</Text>
      </Box>
      {tail ? (
        <Box paddingLeft={4}>
          <Text color="gray">└ </Text>
          <Text color={eventStyle(tail.type).color}>{tail.type}</Text>
          <Text> </Text>
          <Text color="white">{truncate(summarizeEvent(tail), narrow ? 50 : 80)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function AwaitRow({
  idea,
  selected,
  expanded,
  narrow,
  cols,
  ideasDir,
}: {
  idea: IdeaSummary;
  selected: boolean;
  expanded: boolean;
  narrow: boolean;
  cols: number;
  ideasDir: string;
}) {
  const glyph = actionGlyph(idea.recommended_action);
  const conf = idea.confidence ? `${idea.confidence} conf` : "low signal";
  const verdict = idea.recommended_action ?? "no verdict";
  // Title gets one row's width minus the row gutter and glyphs.
  const titleBudget = Math.max(20, cols - 6);

  // Pre-compose the metadata strip as a single string so Ink doesn't wrap
  // each fragment independently and split words like "letsbark / er".
  const metaParts = [
    idea.project,
    verdict,
    conf,
    relTime(idea.brainstormed_at || idea.captured_at),
  ];
  const metaLine = metaParts.join("  ·  ");
  const metaBudget = Math.max(20, cols - 6);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
        <Text color={glyph.color}>{glyph.glyph} </Text>
        <Text bold={selected}>{truncate(idea.title, titleBudget)}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color="gray">{truncate(metaLine, metaBudget)}</Text>
      </Box>
      {expanded ? <AwaitDetail idea={idea} narrow={narrow} cols={cols} ideasDir={ideasDir} /> : null}
    </Box>
  );
}

function AwaitDetail({ idea, narrow, cols, ideasDir }: {
  idea: IdeaSummary;
  narrow: boolean;
  cols: number;
  ideasDir: string;
}) {
  const sections = React.useMemo(
    () => parseBrainstormSections(ideaFilepath(ideasDir, idea.filename)),
    [idea.filename, ideasDir]
  );

  // Width strategy:
  //   wide  — left gutter "label    " then content on the same line.
  //   narrow — group header on its own line, content lines indented under it.
  // Both render content as ONE pre-truncated Text element so Ink never wraps
  // mid-word inside a row.
  if (narrow) {
    const indent = 4;
    const cap = Math.max(30, cols - indent - 2);
    return (
      <Box flexDirection="column" paddingLeft={indent} marginTop={0}>
        {sections.problem ? (
          <>
            <Text color="gray" dimColor>problem</Text>
            <Text>  {truncate(sections.problem, cap - 2)}</Text>
          </>
        ) : null}
        {sections.variants.length > 0 ? (
          <Text color="gray" dimColor>variants</Text>
        ) : null}
        {sections.variants.slice(0, 3).map((v, i) => {
          const line = `${i + 1}. ${v.label} — ${v.body}`;
          return <Text key={i}>  {truncate(line, cap - 2)}</Text>;
        })}
        {sections.topRisks.length > 0 ? (
          <Text color="gray" dimColor>risks</Text>
        ) : null}
        {sections.topRisks.slice(0, 2).map((r, i) => (
          <Box key={i}>
            <Text>  </Text>
            <Text color="yellow">▲ </Text>
            <Text>{truncate(r, cap - 4)}</Text>
          </Box>
        ))}
        {sections.ifAcceptedBuild ? (
          <>
            <Text color="gray" dimColor>build</Text>
            <Text color="green">  {truncate(sections.ifAcceptedBuild, cap - 2)}</Text>
          </>
        ) : null}
      </Box>
    );
  }

  // Wide: gutter + content on the same line. Each row is a SINGLE Text
  // with nested colored spans — Ink's Yoga collapses trailing whitespace
  // between adjacent <Text> siblings, which was eating the space between
  // "variants" and "1." and producing a blank line between Boxes when
  // their content brushed the column width. Nesting inside one Text gives
  // a predictable continuous string.
  //
  // Indent budget: AwaitRow paddingLeft (2) + AwaitDetail paddingLeft (4)
  // = 6 chars consumed before our content begins.
  const gutter = 9;
  const cap = Math.max(30, cols - 2 - 4 - gutter - 1);
  const pad = (label: string) =>
    label + " ".repeat(Math.max(1, gutter - label.length));

  return (
    <Box flexDirection="column" paddingLeft={4} marginTop={0}>
      {sections.problem ? (
        <Text>
          <Text color="gray" dimColor>{pad("problem")}</Text>
          {truncate(sections.problem, cap)}
        </Text>
      ) : null}
      {sections.variants.slice(0, 3).map((v, i) => {
        const head = `${i + 1}. ${v.label}`;
        const headBudget = Math.max(12, Math.min(40, Math.floor(cap * 0.45)));
        const headTrunc = truncate(head, headBudget);
        const bodyTrunc = truncate(v.body, cap - headTrunc.length - 3);
        return (
          <Text key={i}>
            <Text color="gray" dimColor>{pad(i === 0 ? "variants" : "")}</Text>
            <Text color="cyan" bold>{headTrunc}</Text>
            <Text color="gray"> — </Text>
            {bodyTrunc}
          </Text>
        );
      })}
      {sections.topRisks.slice(0, 2).map((r, i) => (
        <Text key={i}>
          <Text color="gray" dimColor>{pad(i === 0 ? "risks" : "")}</Text>
          <Text color="yellow">▲ </Text>
          {truncate(r, cap - 2)}
        </Text>
      ))}
      {sections.ifAcceptedBuild ? (
        <Text>
          <Text color="gray" dimColor>{pad("build")}</Text>
          <Text color="green">{truncate(sections.ifAcceptedBuild, cap)}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

function TodayRow({ entry, selected, narrow, cols }: {
  entry: LifecycleEntry;
  selected: boolean;
  narrow: boolean;
  cols: number;
}) {
  const title = entry.title ?? entry.slug;
  const prNum = entry.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  const prSuffix = entry.prUrl ? (prNum ? `PR #${prNum}` : "PR open") : "";

  // Trail glyphs in chronological order (oldest first). The latest stage
  // drives the trail's color so the eye lands on "where this idea is now"
  // without losing the progression.
  const trail = entry.trail.map((k) => todayGlyph(k).glyph).join("");
  const trailColor = todayGlyph(entry.latestKind).color;

  // 4 gutter + 6 time + 2 sp + trail + 1 sp + prSuffix = overhead.
  const overhead = 4 + 6 + 2 + trail.length + 1 + (prSuffix ? prSuffix.length + 1 : 0);
  const titleBudget = Math.max(20, cols - overhead);

  return (
    <Box paddingLeft={2}>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
      <Text color="gray">{timeOfDay(entry.latestTs)} </Text>
      <Text bold={selected}>{truncate(title, titleBudget)}</Text>
      <Text color="gray">  </Text>
      <Text color={trailColor}>{trail}</Text>
      {prSuffix ? (
        <>
          <Text color="gray"> </Text>
          <Text color="green">{prSuffix}</Text>
        </>
      ) : null}
    </Box>
  );
}

function todayGlyph(kind: TodayEntry["kind"]): { glyph: string; color: string } {
  switch (kind) {
    case "captured":      return { glyph: "↓", color: "cyan" };
    case "brainstormed":  return { glyph: "💭", color: "cyan" };
    case "accepted":      return { glyph: "✓", color: "green" };
    case "rejected":      return { glyph: "✗", color: "red" };
    case "needs-thought": return { glyph: "▲", color: "yellow" };
    case "build-start":   return { glyph: "◆", color: "cyan" };
    case "pr-open":       return { glyph: "★", color: "green" };
    case "shipped":       return { glyph: "✓", color: "green" };
    default:              return { glyph: "·", color: "gray" };
  }
}

function HelpOverlay({ cols }: { cols: number }) {
  const sections: { title: string; rows: { keys: string; label: string }[] }[] = [
    {
      title: "navigate",
      rows: [
        { keys: "↑↓ j k",   label: "select row" },
        { keys: "tab",      label: "jump to next zone" },
        { keys: "g G",      label: "first / last row" },
      ],
    },
    {
      title: "in flight",
      rows: [
        { keys: "enter",    label: "zoom into watch TUI fullscreen" },
      ],
    },
    {
      title: "awaiting you",
      rows: [
        { keys: "enter",    label: "expand brainstorm detail inline" },
        { keys: "a",        label: "accept (status → accepted)" },
        { keys: "t",        label: "needs more thought" },
        { keys: "r",        label: "reject" },
        { keys: "b",        label: "build (after accept)" },
        { keys: "o",        label: "open idea file in $EDITOR" },
      ],
    },
    {
      title: "today",
      rows: [
        { keys: "enter",    label: "open idea file" },
      ],
    },
    {
      title: "global",
      rows: [
        { keys: "c",        label: "capture a new idea inline" },
        { keys: ":",        label: "run a verb (brainstorm / ship / doctor / cleanup)" },
        { keys: "p",        label: "cycle project filter" },
        { keys: "?",        label: "this help (esc to close)" },
        { keys: "q ctrl+c", label: "quit" },
      ],
    },
  ];

  const labelWidth = Math.max(20, Math.min(60, cols - 22));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color="cyan" bold>harness keymap </Text>
        <Text color="gray">— press ? or esc to close</Text>
      </Box>
      {sections.map((s) => (
        <Box key={s.title} flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>{s.title}</Text>
          {s.rows.map((r, i) => (
            <Box key={i} paddingLeft={2}>
              <Box width={18}>
                <Text color="cyan">{r.keys}</Text>
              </Box>
              <Text>{truncate(r.label, labelWidth)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function FooterBar({
  hints,
  message,
  narrow,
  cols,
}: {
  hints: { key: string; label: string }[];
  message: string | null;
  narrow: boolean;
  cols: number;
}) {
  // Pack hints into rows so each rendered row fits within cols. The width
  // of a hint when followed by another is `[k] label  ` = 5 + key + label;
  // when last on a row it's `[k] label` = 3 + key + label.
  const budget = Math.max(20, cols - 2);
  const rows: { key: string; label: string }[][] = [[]];
  for (const h of hints) {
    const row = rows[rows.length - 1];
    const trial = [...row, h];
    const rendered = trial.reduce((acc, item, i) => {
      const last = i === trial.length - 1;
      return acc + 3 + item.key.length + item.label.length + (last ? 0 : 2);
    }, 0);
    if (rendered > budget && row.length > 0) {
      rows.push([h]);
    } else {
      row.push(h);
    }
  }

  return (
    <Box paddingX={1} flexDirection="column">
      {rows.map((row, ri) => (
        <Box key={ri}>
          {row.map((h, i) => (
            <React.Fragment key={i}>
              <Text color="cyan">[{h.key}]</Text>
              <Text> {h.label}</Text>
              {i < row.length - 1 ? <Text>  </Text> : null}
            </React.Fragment>
          ))}
        </Box>
      ))}
      {message ? (
        <Box>
          <Text color="yellow">! </Text>
          <Text>{truncate(message, narrow ? 60 : 100)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── main app ────────────────────────────────────────────────────────

export interface DashboardProps {
  /** Initial snapshot — the verb hands it in. */
  initial: DashboardSnapshot;
  /** Re-read disk and return a fresh snapshot. Called on a 1s tick. */
  refresh: () => DashboardSnapshot;
  /** Absolute path to ideas/ — used for reading brainstorm bodies on expand. */
  ideasDir: string;
  callbacks: DashboardCallbacks;
  onAction: (a: DashboardAction) => void;
}

export function Dashboard({ initial, refresh, ideasDir, callbacks, onAction }: DashboardProps) {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize();
  const narrow = cols < 80;

  const [state, setState] = React.useState<DashboardState>({
    ...initial,
    liveByRun: new Map(),
  });
  const [cursor, setCursor] = React.useState<number>(0);
  const [expandedAwait, setExpandedAwait] = React.useState<Set<string>>(new Set());
  const [message, setMessage] = React.useState<string | null>(null);
  const [projectFilter, setProjectFilter] = React.useState<string | null>(null);
  const [capturing, setCapturing] = React.useState<boolean>(false);
  const [captureBuffer, setCaptureBuffer] = React.useState<string>("");
  const [paletteOpen, setPaletteOpen] = React.useState<boolean>(false);
  const [paletteCursor, setPaletteCursor] = React.useState<number>(0);
  const [helpOpen, setHelpOpen] = React.useState<boolean>(false);

  const fleetRef = React.useRef<WatcherFleet | null>(null);
  if (!fleetRef.current) fleetRef.current = new WatcherFleet();

  // Refresh disk-backed slices every second.
  React.useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const snap = refresh();
      setState((prev) => ({ ...snap, liveByRun: prev.liveByRun }));
    };
    const t = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refresh]);

  // Reconcile watcher fleet whenever the active run set changes.
  React.useEffect(() => {
    const fleet = fleetRef.current!;
    fleet.reconcile(
      state.runs.map((r) => ({ runId: r.runId, eventsPath: r.eventsPath })),
      (runId, ev) => {
        setState((prev) => {
          const next = new Map(prev.liveByRun);
          const slice = next.get(runId) ?? { events: [], eventCount: 0 };
          // Cap retained events per run; we only display the latest.
          const events = [...slice.events, ev].slice(-50);
          next.set(runId, { events, eventCount: slice.eventCount + 1 });
          return { ...prev, liveByRun: next };
        });
      }
    );
    return () => { /* fleet stopped on unmount via separate effect */ };
  }, [state.runs.map((r) => r.runId).join("|")]);

  React.useEffect(() => {
    return () => fleetRef.current?.stopAll();
  }, []);

  // Available project facets — drawn from currently-loaded ideas.
  const projects = React.useMemo(() => {
    return Array.from(new Set(state.ideas.map((i) => i.project).filter(Boolean))).sort();
  }, [state.ideas]);

  // Filter sets — pre-compute once per render so all zones see the same view.
  const ideaBySlugRaw = React.useMemo(() => {
    const m = new Map<string, IdeaSummary>();
    for (const i of state.ideas) m.set(i.slug, i);
    return m;
  }, [state.ideas]);

  const filteredRuns = React.useMemo(() => {
    if (!projectFilter) return state.runs;
    return state.runs.filter((r) => {
      if (!r.slug) return false;
      const idea = ideaBySlugRaw.get(r.slug);
      return idea?.project === projectFilter;
    });
  }, [state.runs, projectFilter, ideaBySlugRaw]);

  const filteredAwaiting = React.useMemo(() => {
    const all = awaitingIdeas(state.ideas);
    return projectFilter ? all.filter((i) => i.project === projectFilter) : all;
  }, [state.ideas, projectFilter]);

  const filteredToday = React.useMemo(() => {
    if (!projectFilter) return state.today;
    return state.today.filter((t) => {
      const idea = ideaBySlugRaw.get(t.slug);
      return idea?.project === projectFilter;
    });
  }, [state.today, projectFilter, ideaBySlugRaw]);

  // Build the unified selectable list against filtered slices.
  const items: Selectable[] = React.useMemo(() => {
    const out: Selectable[] = [];
    for (const r of filteredRuns) out.push({ zone: "flight", runId: r.runId });
    for (const i of filteredAwaiting) out.push({ zone: "await", slug: i.slug });
    for (const t of filteredToday) out.push({ zone: "today", slug: t.slug });
    return out;
  }, [filteredRuns, filteredAwaiting, filteredToday]);

  /** First selectable index belonging to a given zone — Tab jumps here. */
  const zoneStart = (zone: Selectable["zone"]): number => {
    return items.findIndex((s) => s.zone === zone);
  };

  // Clamp cursor when the item list shrinks.
  React.useEffect(() => {
    if (items.length === 0) {
      setCursor(0);
      return;
    }
    if (cursor >= items.length) setCursor(items.length - 1);
  }, [items.length, cursor]);

  const next = React.useMemo(() => computeNext(state.ideas), [state.ideas]);
  const selected = items[cursor];
  const ideaBySlug = ideaBySlugRaw;

  // Context-aware action hints derived from the selected row.
  const hints = React.useMemo(
    () => buildHints(selected, ideaBySlug, projects.length > 0),
    [selected, ideaBySlug, projects.length]
  );

  // Palette options. Each entry runs as a child of the harness CLI;
  // long-running ones (brainstorm/ship) produce a runs/<id>/events.ndjson
  // that the dashboard's IN FLIGHT zone will pick up live.
  const paletteOptions: { verb: string; label: string; hint: string }[] = [
    { verb: "brainstorm",  label: "brainstorm",  hint: "score new captures into brainstormed ideas" },
    { verb: "ship",        label: "ship",        hint: "build the next obvious idea (--yes)" },
    { verb: "doctor",      label: "doctor",      hint: "env health check (quick)" },
    { verb: "cleanup",     label: "cleanup",     hint: "remove worktrees for shipped ideas (dry-run)" },
  ];

  // Keyboard
  useInput((input, key) => {
    // Help overlay: only Esc or `?` closes. Block all other keybinds so
    // the user can read without accidentally triggering anything.
    if (helpOpen) {
      if (key.escape || input === "?" || input === "q") {
        setHelpOpen(false);
      }
      return;
    }

    // Palette mode: arrow nav + Enter to spawn + Esc to close.
    if (paletteOpen) {
      if (key.escape) { setPaletteOpen(false); setMessage(null); return; }
      if (key.upArrow || input === "k") {
        setPaletteCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setPaletteCursor((c) => Math.min(paletteOptions.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const choice = paletteOptions[paletteCursor];
        setPaletteOpen(false);
        if (!choice) return;
        try {
          const result = callbacks.onSpawnVerb(choice.verb);
          if (result.message) {
            setMessage(result.message);
          } else if (result.detached) {
            setMessage(`◆ spawned harness ${choice.verb} — watch IN FLIGHT.`);
          }
        } catch (err) {
          setMessage(`spawn failed: ${(err as Error).message}`);
        }
        return;
      }
      return;
    }

    // Capture-input mode swallows almost everything — only Esc cancels and
    // Enter submits. Other keys append to the buffer.
    if (capturing) {
      if (key.escape) {
        setCapturing(false);
        setCaptureBuffer("");
        setMessage(null);
        return;
      }
      if (key.return) {
        const text = captureBuffer.trim();
        setCapturing(false);
        setCaptureBuffer("");
        if (!text) {
          setMessage("capture cancelled — empty input.");
          return;
        }
        try {
          const created = callbacks.onCapture(text);
          if (created) {
            setMessage(`↓ captured ${truncate(text, 50)} → ${created.slug}`);
          }
        } catch (err) {
          setMessage(`capture failed: ${(err as Error).message}`);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setCaptureBuffer((b) => b.slice(0, -1));
        return;
      }
      // Filter control chars; accept anything else as text input.
      if (input && !key.ctrl && !key.meta) {
        setCaptureBuffer((b) => b + input);
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      onAction({ kind: "quit" });
      exit();
      return;
    }
    if (input === "c") {
      setCapturing(true);
      setCaptureBuffer("");
      setMessage(null);
      return;
    }
    if (input === ":") {
      setPaletteOpen(true);
      setPaletteCursor(0);
      setMessage(null);
      return;
    }
    if (input === "?") {
      setHelpOpen(true);
      setMessage(null);
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      setMessage(null);
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(items.length - 1, c + 1));
      setMessage(null);
      return;
    }
    if (input === "g") { setCursor(0); return; }
    if (input === "G") { setCursor(Math.max(0, items.length - 1)); return; }

    // Tab cycles between zones; pressing it lands on the first row of the
    // next non-empty zone after the current selection.
    if (key.tab) {
      const order: Selectable["zone"][] = ["flight", "await", "today"];
      const currentZone = selected?.zone ?? "flight";
      const i = order.indexOf(currentZone);
      for (let step = 1; step <= order.length; step++) {
        const target = order[(i + step) % order.length];
        const idx = zoneStart(target);
        if (idx >= 0) {
          setCursor(idx);
          setMessage(null);
          return;
        }
      }
      return;
    }

    // Project filter cycles: null → projects[0] → … → null.
    if (input === "p") {
      if (projects.length === 0) {
        setMessage("no projects to filter — capture an idea first.");
        return;
      }
      setProjectFilter((cur) => {
        const idx = cur === null ? -1 : projects.indexOf(cur);
        const nextIdx = idx + 1;
        return nextIdx >= projects.length ? null : projects[nextIdx];
      });
      setCursor(0);
      setMessage(null);
      return;
    }

    // Per-zone keybinds
    if (!selected) return;

    if (selected.zone === "flight") {
      if (key.return) {
        const run = state.runs.find((r) => r.runId === selected.runId);
        if (!run) return;
        const idea = run.slug ? ideaBySlug.get(run.slug) : undefined;
        onAction({ kind: "watch", run, idea });
        exit();
        return;
      }
    }

    if (selected.zone === "await") {
      const idea = ideaBySlug.get(selected.slug);
      if (!idea) return;
      if (key.return) {
        setExpandedAwait((prev) => {
          const next = new Set(prev);
          if (next.has(idea.slug)) next.delete(idea.slug);
          else next.add(idea.slug);
          return next;
        });
        return;
      }
      if (input === "a") {
        if (idea.status === "accepted" || idea.status === "building") {
          setMessage(`already ${idea.status}.`);
          return;
        }
        try {
          callbacks.onAccept(idea.slug);
          setMessage(`✓ accepted ${truncate(idea.title, 50)}.`);
        } catch (err) {
          setMessage((err as Error).message);
        }
        return;
      }
      if (input === "r") {
        try {
          callbacks.onReject(idea.slug);
          setMessage(`✗ rejected ${truncate(idea.title, 50)}.`);
        } catch (err) {
          setMessage((err as Error).message);
        }
        return;
      }
      if (input === "t") {
        try {
          callbacks.onNeedsMoreThought(idea.slug);
          setMessage(`▲ needs more thought: ${truncate(idea.title, 50)}.`);
        } catch (err) {
          setMessage((err as Error).message);
        }
        return;
      }
      if (input === "b") {
        if (idea.status === "accepted" || idea.status === "building") {
          onAction({ kind: "build", idea });
          exit();
        } else {
          setMessage("press [a] to accept first.");
        }
        return;
      }
      if (input === "o") {
        onAction({ kind: "open", idea });
        exit();
        return;
      }
    }

    if (selected.zone === "today") {
      if (key.return) {
        const idea = ideaBySlug.get(selected.slug);
        if (idea) {
          onAction({ kind: "open", idea });
          exit();
        }
        return;
      }
    }
  });

  // Render against filtered slices (project filter applied above).
  const flightRuns = filteredRuns;
  const awaiting = filteredAwaiting;
  const today = filteredToday;

  return (
    <Box flexDirection="column">
      <Box paddingX={1} marginTop={0}>
        {(() => {
          const projectChip = projectFilter ? `  ·  project ${projectFilter}` : "";
          // Three candidate forms ordered widest → tightest. Drop labels
          // before truncating with `…` so counts always survive.
          const wide   = `— mission control · ${flightRuns.length} in flight · ${awaiting.length} awaiting you · ${today.length} today${projectChip}`;
          const mid    = `· ${flightRuns.length} flight · ${awaiting.length} await · ${today.length} today${projectChip}`;
          const tight  = `· ${flightRuns.length}/${awaiting.length}/${today.length}${projectChip}`;
          const budget = Math.max(8, cols - 10); // -10 = "harness " + paddingX
          const tail = wide.length <= budget ? wide
            : mid.length <= budget ? mid
            : tight.length <= budget ? tight
            : truncate(tight, budget);
          return (
            <>
              <Text bold color="cyan">harness </Text>
              <Text color="gray">{tail}</Text>
            </>
          );
        })()}
      </Box>

      {helpOpen ? (
        <HelpOverlay cols={cols} />
      ) : (
        <DashboardZones
          next={next}
          narrow={narrow}
          cols={cols}
          flightRuns={flightRuns}
          awaiting={awaiting}
          today={today}
          ideaBySlug={ideaBySlug}
          state={state}
          selected={selected}
          expandedAwait={expandedAwait}
          ideasDir={ideasDir}
        />
      )}

      {!helpOpen && (
        <Box marginTop={1} flexDirection="column">
          {capturing ? (
            <Box paddingX={1}>
              <Text color="cyan" bold>capture › </Text>
              <Text>{captureBuffer}</Text>
              <Text color="gray">
                {truncate(
                  "_  (enter to save · esc to cancel)",
                  Math.max(20, cols - 12 - captureBuffer.length)
                )}
              </Text>
            </Box>
          ) : paletteOpen ? (
            <Box paddingX={1} flexDirection="column">
              <Text color="magenta" bold>: run a verb</Text>
              {paletteOptions.map((opt, i) => {
                const sel = i === paletteCursor;
                return (
                  <Box key={opt.verb}>
                    <Text color={sel ? "cyan" : "gray"}>{sel ? "▸ " : "  "}</Text>
                    <Text bold={sel} color={sel ? "white" : undefined}>
                      {opt.label.padEnd(12)}
                    </Text>
                    <Text color="gray">  {opt.hint}</Text>
                  </Box>
                );
              })}
              <Text color="gray" dimColor>↑↓ navigate · enter run · esc cancel</Text>
            </Box>
          ) : (
            <FooterBar hints={hints} message={message} narrow={narrow} cols={cols} />
          )}
        </Box>
      )}
    </Box>
  );
}

interface DashboardZonesProps {
  next: ReturnType<typeof computeNext>;
  narrow: boolean;
  cols: number;
  flightRuns: ActiveRun[];
  awaiting: IdeaSummary[];
  today: LifecycleEntry[];
  ideaBySlug: Map<string, IdeaSummary>;
  state: DashboardState;
  selected: Selectable | undefined;
  expandedAwait: Set<string>;
  ideasDir: string;
}

function DashboardZones(p: DashboardZonesProps) {
  const { next, narrow, cols, flightRuns, awaiting, today, ideaBySlug, state, selected, expandedAwait, ideasDir } = p;
  return (
    <>
      <NextBar next={next} narrow={narrow} cols={cols} />

      <ZoneHeader glyph="◆" label="IN FLIGHT" count={flightRuns.length} color="cyan" />
      {flightRuns.length === 0 ? (
        <Box paddingLeft={4}>
          <Text color="gray">
            {truncate("nothing running. try `harness brainstorm` or accept something below.", Math.max(20, cols - 6))}
          </Text>
        </Box>
      ) : (
        flightRuns.slice(0, narrow ? 3 : 5).map((r) => {
          const sel = selected?.zone === "flight" && selected.runId === r.runId;
          return (
            <FlightRow
              key={r.runId}
              run={r}
              idea={r.slug ? ideaBySlug.get(r.slug) : undefined}
              live={state.liveByRun.get(r.runId)}
              selected={sel}
              narrow={narrow}
            />
          );
        })
      )}

      <ZoneHeader glyph="▲" label="AWAITING YOU" count={awaiting.length} color="yellow" />
      {awaiting.length === 0 ? (
        <Box paddingLeft={4}>
          <Text color="gray" dimColor>
            {truncate("inbox zero. nothing brainstormed is waiting.", Math.max(20, cols - 6))}
          </Text>
        </Box>
      ) : (
        awaiting.slice(0, narrow ? 4 : 8).map((i) => {
          const sel = selected?.zone === "await" && selected.slug === i.slug;
          return (
            <AwaitRow
              key={i.slug}
              idea={i}
              selected={sel}
              expanded={sel || expandedAwait.has(i.slug)}
              narrow={narrow}
              cols={cols}
              ideasDir={ideasDir}
            />
          );
        })
      )}

      <ZoneHeader glyph="✓" label="TODAY" count={today.length} color="green" />
      {today.length === 0 ? (
        <Box paddingLeft={4}>
          <Text color="gray" dimColor>
            {truncate("quiet day. no idea state changes in the last 24h.", Math.max(20, cols - 6))}
          </Text>
        </Box>
      ) : (
        today.slice(0, narrow ? 5 : 10).map((t) => {
          const sel = selected?.zone === "today" && selected.slug === t.slug;
          return <TodayRow key={t.slug} entry={t} selected={sel} narrow={narrow} cols={cols} />;
        })
      )}
    </>
  );
}

// ── context-aware footer hint computation ───────────────────────────

function buildHints(
  selected: Selectable | undefined,
  ideaBySlug: Map<string, IdeaSummary>,
  hasProjects: boolean
): { key: string; label: string }[] {
  const base: { key: string; label: string }[] = [
    { key: "↑↓", label: "select" },
  ];

  // Per-zone primary actions
  if (selected?.zone === "flight") {
    base.push({ key: "enter", label: "watch" });
  } else if (selected?.zone === "await") {
    const idea = ideaBySlug.get(selected.slug);
    if (idea) {
      base.push({ key: "enter", label: "expand" });
      if (idea.status === "brainstormed" || idea.status === "needs-critic-review") {
        base.push({ key: "a", label: "accept" });
        base.push({ key: "t", label: "think more" });
        base.push({ key: "r", label: "reject" });
      }
      if (idea.status === "accepted" || idea.status === "building") {
        base.push({ key: "b", label: "build" });
      }
      base.push({ key: "o", label: "open" });
    }
  } else if (selected?.zone === "today") {
    base.push({ key: "enter", label: "open idea" });
  }

  // Universal navigation hints
  base.push({ key: "c", label: "capture" });
  base.push({ key: ":", label: "run verb" });
  base.push({ key: "?", label: "help" });
  base.push({ key: "tab", label: "next zone" });
  if (hasProjects) base.push({ key: "p", label: "project" });
  base.push({ key: "q", label: "quit" });
  return base;
}

// ── public render entry ─────────────────────────────────────────────

export interface RenderDashboardResult {
  action: DashboardAction;
}

export async function renderDashboard(opts: {
  initial: DashboardSnapshot;
  refresh: () => DashboardSnapshot;
  ideasDir: string;
  callbacks: DashboardCallbacks;
}): Promise<RenderDashboardResult> {
  let chosen: DashboardAction = { kind: "quit" };
  await withAltScreen(async () => {
    const { waitUntilExit } = render(
      <Dashboard
        initial={opts.initial}
        refresh={opts.refresh}
        ideasDir={opts.ideasDir}
        callbacks={opts.callbacks}
        onAction={(a) => { chosen = a; }}
      />
    );
    await waitUntilExit();
  });
  return { action: chosen };
}
