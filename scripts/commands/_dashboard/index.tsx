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
import { Box, Text, useApp, useInput, render } from "ink";
import Spinner from "ink-spinner";

import type { IdeaSummary, IdeaStatus } from "../../lib/ideas";
import { withAltScreen } from "../_watch_tui/altscreen";

import {
  ActiveRun,
  ParsedEvent,
  TodayEntry,
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
}

// ── selection model ─────────────────────────────────────────────────
//
// The dashboard collapses three lists into one cursor. Each entry below
// is one focusable row; non-selectable lines (zone headers, hints) are
// not represented here.

type Selectable =
  | { zone: "flight"; runId: string }
  | { zone: "await"; slug: string }
  | { zone: "today"; ts: string };

export interface DashboardState {
  ideas: IdeaSummary[];
  runs: ActiveRun[];
  today: TodayEntry[];
  /** Tail-driven slice: latest event(s) per run id. */
  liveByRun: Map<string, { events: ParsedEvent[]; eventCount: number }>;
}

/** Snapshot the verb hands the dashboard on each refresh tick. */
export interface DashboardSnapshot {
  ideas: IdeaSummary[];
  runs: ActiveRun[];
  today: TodayEntry[];
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
  const [size, setSize] = React.useState({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 30,
  });
  React.useEffect(() => {
    const onResize = () => setSize({
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 30,
    });
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);
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
    return (
      <Box paddingX={1}>
        <Text color="gray" dimColor>NEXT  </Text>
        <Text color="gray">nothing waiting — capture an idea or run </Text>
        <Text color="cyan">harness brainstorm</Text>
      </Box>
    );
  }
  const glyph = actionGlyph(next.idea.recommended_action);
  // Reserve room for the trailing "<reason>  [k] label" suffix so the
  // title gets a deterministic budget instead of letting Ink wrap it
  // mid-word and push everything else onto a second visual row.
  const suffix = `${next.reason}  [${next.primary.key}] ${next.primary.label}`;
  const titleBudget = Math.max(20, cols - suffix.length - 12);

  return (
    <Box paddingX={1} flexDirection={narrow ? "column" : "row"}>
      <Box>
        <Text color="cyan" bold>NEXT </Text>
        <Text color={glyph.color}> {glyph.glyph} </Text>
        <Text bold>{truncate(next.idea.title, titleBudget)}</Text>
      </Box>
      <Box marginLeft={narrow ? 0 : 2}>
        <Text color="gray">{next.reason}</Text>
        <Text color="gray">  </Text>
        <Text color="cyan">[{next.primary.key}]</Text>
        <Text> {next.primary.label}</Text>
      </Box>
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
  ideasDir,
}: {
  idea: IdeaSummary;
  selected: boolean;
  expanded: boolean;
  narrow: boolean;
  ideasDir: string;
}) {
  const glyph = actionGlyph(idea.recommended_action);
  const conf = idea.confidence ? `${idea.confidence} conf` : "low signal";
  const verdict = idea.recommended_action ?? "no verdict";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
        <Text color={glyph.color}>{glyph.glyph} </Text>
        <Text bold={selected}>{truncate(idea.title, narrow ? 50 : 70)}</Text>
      </Box>
      <Box paddingLeft={4} flexDirection={narrow ? "column" : "row"}>
        <Text color="gray">{idea.project}</Text>
        <Text color="gray">{narrow ? "" : "  ·  "}</Text>
        <Text color={glyph.color}>{verdict}</Text>
        <Text color="gray">{narrow ? "" : "  ·  "}</Text>
        <Text color="gray">{conf}</Text>
        <Text color="gray">{narrow ? "" : "  ·  "}</Text>
        <Text color="gray">{relTime(idea.brainstormed_at || idea.captured_at)}</Text>
      </Box>
      {expanded ? <AwaitDetail idea={idea} narrow={narrow} ideasDir={ideasDir} /> : null}
    </Box>
  );
}

function AwaitDetail({ idea, narrow, ideasDir }: { idea: IdeaSummary; narrow: boolean; ideasDir: string }) {
  const sections = React.useMemo(
    () => parseBrainstormSections(ideaFilepath(ideasDir, idea.filename)),
    [idea.filename, ideasDir]
  );
  const lineCap = narrow ? 60 : 100;

  return (
    <Box flexDirection="column" paddingLeft={4} marginTop={0}>
      {sections.problem ? (
        <Box>
          <Text color="gray" dimColor>problem  </Text>
          <Text>{truncate(sections.problem, lineCap)}</Text>
        </Box>
      ) : null}
      {sections.variants.slice(0, 3).map((v, i) => (
        <Box key={i}>
          <Text color="gray" dimColor>{i === 0 ? "variants " : "         "}</Text>
          <Text color="cyan">{i + 1}. </Text>
          <Text bold>{truncate(v.label, 32)}</Text>
          <Text color="gray"> — </Text>
          <Text>{truncate(v.body, lineCap - v.label.length - 8)}</Text>
        </Box>
      ))}
      {sections.topRisks.slice(0, 2).map((r, i) => (
        <Box key={i}>
          <Text color="gray" dimColor>{i === 0 ? "risks    " : "         "}</Text>
          <Text color="yellow">▲ </Text>
          <Text>{truncate(r, lineCap)}</Text>
        </Box>
      ))}
      {sections.ifAcceptedBuild ? (
        <Box>
          <Text color="gray" dimColor>build    </Text>
          <Text color="green">{truncate(sections.ifAcceptedBuild, lineCap)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function TodayRow({ entry, selected, narrow, cols }: {
  entry: TodayEntry;
  selected: boolean;
  narrow: boolean;
  cols: number;
}) {
  const { glyph, color } = todayGlyph(entry.kind);
  const title = entry.title ?? entry.slug;
  // For pr-open: show "PR #N" instead of the full URL; the slug already
  // identifies the idea. Keeps each row to one line at any width.
  const prNum = entry.detail?.match(/\/pull\/(\d+)/)?.[1];
  const isPr = entry.kind === "pr-open" && entry.detail?.startsWith("http");
  const prSuffix = isPr ? (prNum ? `PR #${prNum}` : "PR open") : "";
  const titleBudget = Math.max(
    20,
    cols - 4 /* gutter+glyph */ - 6 /* time */ - 2 /* glyph */ - prSuffix.length - 2
  );
  return (
    <Box paddingLeft={2}>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▸ " : "  "}</Text>
      <Text color="gray">{timeOfDay(entry.ts)} </Text>
      <Text color={color}>{glyph} </Text>
      <Text bold={selected}>{truncate(title, narrow ? titleBudget : titleBudget)}</Text>
      {prSuffix ? (
        <>
          <Text color="gray">  </Text>
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

function FooterBar({
  hints,
  message,
  narrow,
}: {
  hints: { key: string; label: string }[];
  message: string | null;
  narrow: boolean;
}) {
  return (
    <Box paddingX={1} flexDirection="column">
      <Box flexWrap={narrow ? "wrap" : undefined}>
        {hints.map((h, i) => (
          <Box key={i} marginRight={2}>
            <Text color="cyan">[{h.key}]</Text>
            <Text> {h.label}</Text>
          </Box>
        ))}
      </Box>
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

  // Build the unified selectable list.
  const items: Selectable[] = React.useMemo(() => {
    const out: Selectable[] = [];
    for (const r of state.runs) out.push({ zone: "flight", runId: r.runId });
    for (const i of awaitingIdeas(state.ideas)) out.push({ zone: "await", slug: i.slug });
    for (const t of state.today) out.push({ zone: "today", ts: t.ts + ":" + t.slug });
    return out;
  }, [state]);

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
  const ideaBySlug = React.useMemo(() => {
    const m = new Map<string, IdeaSummary>();
    for (const i of state.ideas) m.set(i.slug, i);
    return m;
  }, [state.ideas]);

  // Context-aware action hints derived from the selected row.
  const hints = React.useMemo(() => buildHints(selected, ideaBySlug), [selected, ideaBySlug]);

  // Keyboard
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      onAction({ kind: "quit" });
      exit();
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
        const slug = selected.ts.split(":").slice(2).join(":") || selected.ts;
        // We packed `ts:slug` for uniqueness; recover the slug.
        const real = state.today.find(
          (t) => t.ts + ":" + t.slug === selected.ts
        );
        if (!real) return;
        const idea = ideaBySlug.get(real.slug);
        if (idea) {
          onAction({ kind: "open", idea });
          exit();
        }
        return;
      }
    }
  });

  // Render
  const visible = items;  // Future: virtualize. For 50 ideas this is fine.

  // Determine an upper-bound height for rendering — we want zones to
  // collapse rather than scroll past the bottom. For now we let Ink
  // flow and just cap each zone's row count.
  const flightRuns = state.runs;
  const awaiting = awaitingIdeas(state.ideas);
  const today = state.today;

  return (
    <Box flexDirection="column">
      <Box paddingX={1} marginTop={0}>
        <Text bold color="cyan">harness </Text>
        <Text color="gray">— mission control · </Text>
        <Text bold>{flightRuns.length}</Text>
        <Text color="gray"> in flight · </Text>
        <Text bold>{awaiting.length}</Text>
        <Text color="gray"> awaiting you · </Text>
        <Text bold>{today.length}</Text>
        <Text color="gray"> today</Text>
      </Box>

      <NextBar next={next} narrow={narrow} cols={cols} />

      <ZoneHeader glyph="◆" label="IN FLIGHT" count={flightRuns.length} color="cyan" />
      {flightRuns.length === 0 ? (
        <Box paddingLeft={4}>
          <Text color="gray" dimColor>nothing running. </Text>
          <Text color="gray">try </Text>
          <Text color="cyan">harness brainstorm</Text>
          <Text color="gray"> or accept something below.</Text>
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
          <Text color="gray" dimColor>inbox zero. nothing brainstormed is waiting.</Text>
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
              ideasDir={ideasDir}
            />
          );
        })
      )}

      <ZoneHeader glyph="✓" label="TODAY" count={today.length} color="green" />
      {today.length === 0 ? (
        <Box paddingLeft={4}>
          <Text color="gray" dimColor>quiet day. no idea state changes in the last 24h.</Text>
        </Box>
      ) : (
        today.slice(0, narrow ? 5 : 10).map((t) => {
          const tsKey = t.ts + ":" + t.slug;
          const sel = selected?.zone === "today" && selected.ts === tsKey;
          return <TodayRow key={tsKey} entry={t} selected={sel} narrow={narrow} cols={cols} />;
        })
      )}

      <Box marginTop={1}>
        <FooterBar hints={hints} message={message} narrow={narrow} />
      </Box>
    </Box>
  );
}

// ── context-aware footer hint computation ───────────────────────────

function buildHints(
  selected: Selectable | undefined,
  ideaBySlug: Map<string, IdeaSummary>
): { key: string; label: string }[] {
  const base: { key: string; label: string }[] = [
    { key: "↑↓", label: "select" },
  ];

  if (!selected) {
    base.push({ key: "q", label: "quit" });
    return base;
  }

  if (selected.zone === "flight") {
    base.push({ key: "enter", label: "watch" });
    base.push({ key: "q", label: "quit" });
    return base;
  }

  if (selected.zone === "await") {
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
    base.push({ key: "q", label: "quit" });
    return base;
  }

  if (selected.zone === "today") {
    base.push({ key: "enter", label: "open idea" });
    base.push({ key: "q", label: "quit" });
    return base;
  }

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
