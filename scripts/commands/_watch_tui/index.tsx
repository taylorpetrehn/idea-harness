/**
 * scripts/commands/_watch_tui/index.tsx
 *
 * Ink renderer for `harness build watch`. Reads runs/<id>/events.ndjson
 * (already-streamed lines + a tail) and presents a live, full-screen
 * view: header card with idea metadata, scrolling event log, and a
 * footer with elapsed time + last milestone.
 *
 * Stays out of the JSON contract: only invoked when stdout is a TTY and
 * Output.mode === "pretty". The `--ndjson` and `--json` paths still go
 * through the line-printer in build.ts so agents see the raw stream.
 */

import * as React from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import Spinner from "ink-spinner";
import * as fs from "fs";

import type { IdeaSummary } from "../../lib/ideas";
import { withAltScreen } from "./altscreen";

export { withAltScreen };

interface ParsedEvent {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

interface WatchTuiProps {
  idea: IdeaSummary;
  eventsPath: string;
  /** When true, exit on terminal events (build.done / build.failed). */
  exitOnTerminal?: boolean;
  /** Override the "q to quit" footer hint. When the dashboard zooms
   *  into the watch TUI, q returns to the dashboard rather than
   *  ending the session — the caller can pass a clearer label here. */
  exitHint?: string;
  /** When set, drives synthetic events instead of tailing a file. */
  demoFeed?: AsyncIterable<ParsedEvent>;
}

// ── styling helpers ─────────────────────────────────────────────────

const TYPE_STYLES: Record<string, { color: string; glyph: string }> = {
  "build.spawn":         { color: "cyan",    glyph: "◆" },
  "build.stdout":        { color: "gray",    glyph: "·" },
  "build.pr_url":        { color: "green",   glyph: "★" },
  "build.done":          { color: "green",   glyph: "✓" },
  "build.failed":        { color: "red",     glyph: "✗" },
  "brainstorm.start":    { color: "cyan",    glyph: "◆" },
  "brainstorm.tokens":   { color: "gray",    glyph: "·" },
  "brainstorm.done":     { color: "green",   glyph: "✓" },
  "critic.verdict":      { color: "yellow",  glyph: "▲" },
  "capture.created":     { color: "cyan",    glyph: "+" },
  "done":                { color: "green",   glyph: "✓" },
};

function styleFor(type: string): { color: string; glyph: string } {
  return TYPE_STYLES[type] ?? { color: "white", glyph: "·" };
}

function statusColor(status: string): string {
  if (status === "shipped" || status === "pr-open") return "green";
  if (status === "building") return "cyan";
  if (status === "rejected") return "red";
  if (status === "needs-more-thought") return "yellow";
  return "white";
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function summarizeData(type: string, data: Record<string, unknown>): string {
  if (type === "build.pr_url") return String(data.url ?? "");
  if (type === "build.spawn") {
    const cmd = data.cmd ?? data.command;
    return cmd ? String(cmd) : "spawning Claude session…";
  }
  if (type === "build.stdout") return String(data.line ?? data.chunk ?? "").trimEnd();
  if (type === "brainstorm.tokens") {
    const t = data.tokens ?? data.count;
    return t !== undefined ? `${t} tokens` : "";
  }
  if (type === "critic.verdict") {
    const verdict = data.verdict ?? data.recommended_action ?? "";
    const conf = data.confidence ? ` (${data.confidence})` : "";
    return `${verdict}${conf}`;
  }
  if (type === "build.done" || type === "done") {
    return data.outcome ? `outcome=${data.outcome}` : "complete";
  }
  if (type === "build.failed") {
    return String(data.message ?? data.reason ?? "failed");
  }
  // Generic fallback — single-line key=value summary, capped.
  const keys = Object.keys(data);
  if (keys.length === 0) return "";
  return keys
    .slice(0, 3)
    .map((k) => `${k}=${truncate(String((data as any)[k]), 40)}`)
    .join(" ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// ── components ──────────────────────────────────────────────────────

function Header({ idea, runId, compact }: { idea: IdeaSummary; runId: string; compact: boolean }) {
  if (compact) {
    return (
      <Box paddingX={1}>
        <Text bold color="cyan">harness </Text>
        <Text>build </Text>
        <Text bold color={statusColor(idea.status)}>{idea.status}</Text>
        <Text color="gray"> · </Text>
        <Text>{truncate(idea.title, 50)}</Text>
      </Box>
    );
  }
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Box>
        <Text bold color="cyan">harness </Text>
        <Text bold>build watch </Text>
        <Text color="gray">— </Text>
        <Text bold color="white">{idea.slug}</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="gray">title </Text>
        <Text>{truncate(idea.title, 80)}</Text>
      </Box>
      <Box>
        <Text color="gray">status </Text>
        <Text bold color={statusColor(idea.status)}>{idea.status}</Text>
        <Text color="gray">    project </Text>
        <Text>{idea.project}</Text>
        <Text color="gray">    run </Text>
        <Text>{runId}</Text>
      </Box>
      {idea.github_pr ? (
        <Box>
          <Text color="gray">PR </Text>
          <Text color="green">{idea.github_pr}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function EventRow({ ev }: { ev: ParsedEvent }) {
  const { color, glyph } = styleFor(ev.type);
  const time = ev.ts.slice(11, 19);  // HH:MM:SS
  const summary = summarizeData(ev.type, ev.data);
  return (
    <Box>
      <Text color="gray">{time} </Text>
      <Text color={color}>{glyph} </Text>
      <Text color={color} bold>{padEnd(ev.type, 22)}</Text>
      {summary ? <Text color="white"> {truncate(summary, 100)}</Text> : null}
    </Box>
  );
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function Footer({
  events,
  startedAt,
  done,
  prUrl,
  compact,
  exitHint,
}: {
  events: ParsedEvent[];
  startedAt: number;
  done: { ok: boolean; reason: string } | null;
  prUrl: string | null;
  compact: boolean;
  exitHint?: string;
}) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsed = fmtElapsed(now - startedAt);
  const last = events[events.length - 1];

  if (compact) {
    return (
      <Box paddingX={1}>
        {done ? (
          <Text color={done.ok ? "green" : "red"} bold>{done.ok ? "✓" : "✗"} </Text>
        ) : (
          <Text color="cyan"><Spinner type="dots" /> </Text>
        )}
        <Text color="gray">{elapsed} · </Text>
        <Text>{events.length} ev</Text>
        {prUrl ? (
          <>
            <Text color="gray"> · </Text>
            <Text color="green">PR </Text>
            <Text>{truncate(prUrl, 40)}</Text>
          </>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={done ? (done.ok ? "green" : "red") : "cyan"}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        {done ? (
          <Text color={done.ok ? "green" : "red"} bold>
            {done.ok ? "✓ done" : "✗ failed"}
          </Text>
        ) : (
          <Text color="cyan">
            <Spinner type="dots" />
            <Text> running</Text>
          </Text>
        )}
        <Text color="gray">    elapsed </Text>
        <Text bold>{elapsed}</Text>
        <Text color="gray">    events </Text>
        <Text bold>{events.length}</Text>
        {last && !done ? (
          <>
            <Text color="gray">    last </Text>
            <Text color={styleFor(last.type).color}>{last.type}</Text>
          </>
        ) : null}
      </Box>
      {prUrl ? (
        <Box>
          <Text color="green">★ PR </Text>
          <Text>{prUrl}</Text>
        </Box>
      ) : null}
      <Box>
        <Text color="gray" dimColor>{exitHint ?? "q to quit · ctrl+c to exit"}</Text>
      </Box>
    </Box>
  );
}

// ── main TUI ────────────────────────────────────────────────────────

export function WatchTui({ idea, eventsPath, exitOnTerminal, exitHint, demoFeed }: WatchTuiProps) {
  const { exit } = useApp();
  const [events, setEvents] = React.useState<ParsedEvent[]>([]);
  const [done, setDone] = React.useState<{ ok: boolean; reason: string } | null>(null);
  const [prUrl, setPrUrl] = React.useState<string | null>(idea.github_pr || null);
  const startedAtRef = React.useRef<number>(Date.now());
  const runId = React.useMemo(() => {
    const m = eventsPath.match(/runs\/([^/]+)\/events\.ndjson$/);
    return m ? m[1] : "—";
  }, [eventsPath]);

  // Keyboard
  useInput((input: string, key: { ctrl: boolean }) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  // Live feed: either tail the file or consume a synthetic async iterable.
  React.useEffect(() => {
    let cancelled = false;

    const ingest = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        const ev: ParsedEvent = {
          ts: parsed.ts ?? new Date().toISOString(),
          type: parsed.type ?? "unknown",
          data: parsed.data ?? {},
        };
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "build.pr_url" && typeof ev.data.url === "string") {
          setPrUrl(ev.data.url);
        }
        if (ev.type === "build.done" || ev.type === "done" || ev.type === "build.dry") {
          setDone({ ok: true, reason: String(ev.data.outcome ?? ev.type.replace("build.", "")) });
          if (exitOnTerminal) setTimeout(() => exit(), 800);
        }
        if (ev.type === "build.failed") {
          setDone({ ok: false, reason: String(ev.data.message ?? "failed") });
          if (exitOnTerminal) setTimeout(() => exit(), 800);
        }
      } catch {
        // skip malformed lines
      }
    };

    if (demoFeed) {
      (async () => {
        for await (const ev of demoFeed) {
          if (cancelled) return;
          setEvents((prev) => [...prev, ev]);
          if (ev.type === "build.pr_url" && typeof ev.data.url === "string") {
            setPrUrl(ev.data.url);
          }
          if (ev.type === "build.done") {
            setDone({ ok: true, reason: String(ev.data.outcome ?? "complete") });
            if (exitOnTerminal) setTimeout(() => exit(), 800);
          }
          if (ev.type === "build.failed") {
            setDone({ ok: false, reason: String(ev.data.message ?? "failed") });
            if (exitOnTerminal) setTimeout(() => exit(), 800);
          }
        }
      })();
      return () => { cancelled = true; };
    }

    let position = 0;
    let leftover = "";

    // Splits a chunk into complete lines + any trailing partial line, so a
    // poll boundary that lands mid-write doesn't feed JSON.parse a half-line.
    const drainChunk = (chunk: string) => {
      const combined = leftover + chunk;
      const nl = combined.lastIndexOf("\n");
      if (nl < 0) {
        leftover = combined;
        return;
      }
      const complete = combined.slice(0, nl);
      leftover = combined.slice(nl + 1);
      for (const line of complete.split("\n")) ingest(line);
    };

    if (fs.existsSync(eventsPath)) {
      const initial = fs.readFileSync(eventsPath, "utf8");
      drainChunk(initial);
      position = initial.length;
    }

    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(eventsPath)) return;
        const { size } = fs.statSync(eventsPath);
        if (size > position) {
          const fd = fs.openSync(eventsPath, "r");
          const buf = Buffer.alloc(size - position);
          fs.readSync(fd, buf, 0, size - position, position);
          fs.closeSync(fd);
          drainChunk(buf.toString("utf8"));
          position = size;
        } else if (size < position) {
          position = 0;
          leftover = "";
        }
      } catch {
        // file vanished — keep polling
      }
    }, 400);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventsPath, demoFeed, exit, exitOnTerminal]);

  // Tail the event list to fit in remaining terminal height.
  const rows = process.stdout.rows ?? 30;
  // < 16 rows: collapse to single-line header + footer, no borders, no
  // top/bottom margins — anything bordered ghosts in the VS Code pane.
  const compact = rows < 16;
  // Compact: header 1 + footer 1 = 2 rows of chrome.
  // Full:    header ~6 + footer ~5 + margins ~2 = ~13 rows of chrome.
  const cap = Math.max(3, rows - (compact ? 3 : 13));
  const visible = events.slice(-cap);
  const dropped = events.length - visible.length;

  return (
    <Box flexDirection="column">
      <Header idea={idea} runId={runId} compact={compact} />
      <Box flexDirection="column" paddingX={1} marginTop={compact ? 0 : 1}>
        {dropped > 0 ? (
          <Text color="gray" dimColor>… {dropped} earlier event{dropped === 1 ? "" : "s"} hidden</Text>
        ) : null}
        {visible.length === 0 ? (
          <Text color="gray" dimColor>waiting for events…</Text>
        ) : (
          visible.map((ev, i) => <EventRow key={i + (events.length - visible.length)} ev={ev} />)
        )}
      </Box>
      <Box marginTop={compact ? 0 : 1}>
        <Footer
          events={events}
          startedAt={startedAtRef.current}
          done={done}
          prUrl={prUrl}
          compact={compact}
          exitHint={exitHint}
        />
      </Box>
    </Box>
  );
}

// ── public render entry ─────────────────────────────────────────────

export interface RenderWatchOptions {
  idea: IdeaSummary;
  eventsPath: string;
  exitOnTerminal?: boolean;
  exitHint?: string;
  demoFeed?: AsyncIterable<ParsedEvent>;
}

export async function renderWatchTui(opts: RenderWatchOptions): Promise<void> {
  await withAltScreen(async () => {
    const { waitUntilExit } = render(
      <WatchTui
        idea={opts.idea}
        eventsPath={opts.eventsPath}
        exitOnTerminal={opts.exitOnTerminal}
        exitHint={opts.exitHint}
        demoFeed={opts.demoFeed}
      />
    );
    await waitUntilExit();
  });
}

// ── demo feed generator ─────────────────────────────────────────────

/**
 * Synthesizes a believable build event sequence for screenshots / docs /
 * `harness build watch <slug> --demo` without needing a live session.
 */
export async function* demoEventStream(): AsyncIterable<ParsedEvent> {
  const seq: Array<{ delay: number; type: string; data: Record<string, unknown> }> = [
    { delay: 200,  type: "build.spawn",  data: { cmd: "claude code --resume", cwd: "worktrees/dm-cohorts" } },
    { delay: 600,  type: "build.stdout", data: { line: "reading project context…" } },
    { delay: 700,  type: "build.stdout", data: { line: "found contracts/ and references/" } },
    { delay: 800,  type: "build.stdout", data: { line: "drafting plan from brainstorm.md" } },
    { delay: 900,  type: "build.stdout", data: { line: "plan: 4 files to touch, 1 new module" } },
    { delay: 1100, type: "build.stdout", data: { line: "editing scripts/lib/cohorts.ts" } },
    { delay: 800,  type: "build.stdout", data: { line: "editing scripts/commands/cohorts.ts" } },
    { delay: 700,  type: "build.stdout", data: { line: "editing tests/cohorts.test.ts" } },
    { delay: 1000, type: "build.stdout", data: { line: "running typecheck" } },
    { delay: 1200, type: "build.stdout", data: { line: "typecheck passed" } },
    { delay: 800,  type: "build.stdout", data: { line: "running tests" } },
    { delay: 1500, type: "build.stdout", data: { line: "12 passed, 0 failed" } },
    { delay: 800,  type: "build.stdout", data: { line: "git add -A && git commit" } },
    { delay: 500,  type: "build.stdout", data: { line: "git push -u origin dm-cohorts-build" } },
    { delay: 700,  type: "build.stdout", data: { line: "gh pr create" } },
    { delay: 600,  type: "build.pr_url", data: { url: "https://github.com/example/repo/pull/482" } },
    { delay: 400,  type: "build.done",   data: { outcome: "passed" } },
  ];
  for (const step of seq) {
    await new Promise((r) => setTimeout(r, step.delay));
    yield {
      ts: new Date().toISOString(),
      type: step.type,
      data: step.data,
    };
  }
}
