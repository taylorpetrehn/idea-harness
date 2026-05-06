/**
 * scripts/commands/_dashboard/data.ts
 *
 * Pure data primitives for the dashboard. Functions here either operate
 * on inputs the caller hands in or read directly from the filesystem
 * (runs/, ideas/<slug>.md). They deliberately do NOT import from
 * scripts/lib/* at runtime — tsx loads this file via the ESM loader,
 * and named imports against the CJS lib modules break under that path
 * (see commit history for the bug). The verb runs in CJS, calls the
 * lib helpers, and passes results in.
 */

import * as fs from "fs";
import * as path from "path";

// Type-only imports are fine — they're erased at runtime. The renderer
// can be loaded by either the CJS verb path or an ESM smoke harness;
// keeping data.ts free of __dirname / require lets it work in both.
import type { IdeaSummary, IdeaStatus } from "../../lib/ideas";
import type { JournalEntry } from "../../lib/journal";

// ── NEXT bar ────────────────────────────────────────────────────────

export interface NextPick {
  idea: IdeaSummary;
  intent: "build" | "resume" | "review";
  reason: string;
  primary: { key: string; label: string };
}

/** "Do the obvious next thing" — read-only mirror of harness ship. */
export function computeNext(ideas: IdeaSummary[]): NextPick | null {
  const sortNewest = (xs: IdeaSummary[]) =>
    [...xs].sort((a, b) => (b.captured_at || "").localeCompare(a.captured_at || ""));

  const accepted = sortNewest(ideas.filter((i) => i.status === "accepted"));
  if (accepted.length) {
    return {
      idea: accepted[0],
      intent: "build",
      reason: "ready to build",
      primary: { key: "b", label: "build" },
    };
  }
  const building = sortNewest(ideas.filter((i) => i.status === "building"));
  if (building.length) {
    return {
      idea: building[0],
      intent: "resume",
      reason: "build is in flight",
      primary: { key: "enter", label: "watch" },
    };
  }
  const awaiting = sortNewest(
    ideas.filter((i) => i.status === "brainstormed" || i.status === "needs-critic-review")
  );
  if (awaiting.length) {
    const top = awaiting[0];
    const conf = top.confidence ? ` (${top.confidence})` : "";
    const verb = top.recommended_action === "needs-more-thought"
      ? "needs your call"
      : top.recommended_action === "accept"
      ? "ready to accept"
      : top.recommended_action === "reject"
      ? "leaning reject"
      : "awaiting verdict";
    return {
      idea: top,
      intent: "review",
      reason: `${verb}${conf}`,
      primary: top.recommended_action === "accept"
        ? { key: "a", label: "accept" }
        : { key: "enter", label: "expand" },
    };
  }
  return null;
}

// ── IN FLIGHT zone: active runs ─────────────────────────────────────

export interface ActiveRun {
  runId: string;
  dir: string;
  eventsPath: string;
  verb: string;
  slug: string | null;
  startedAt: string;
  latestEvent: ParsedEvent | null;
  eventCount: number;
  /** True when the latest event is older than the stall threshold —
   *  builder probably crashed without reaching finalizeRun. Renderer
   *  shows these dimmed with a different glyph so they don't look
   *  like active streaming work. */
  stalled: boolean;
}

export interface ParsedEvent {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

/** Runs idle longer than this are flagged stalled — likely crashed
 *  builders that died without writing summary.json. Picked
 *  conservatively: the longest legitimate brainstorm we've observed
 *  is ~3min; a Claude Code build is bounded by IDEA_HARNESS_BUILDER_
 *  TIMEOUT_MS (default 30 min) but events stream throughout. 5
 *  minutes of total silence is a strong "this is wedged" signal. */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Scan runs/ for runs that haven't finalized yet. Pure fs read; safe to
 * call from the renderer on a tick. Caller supplies the runs dir.
 */
export function scanActiveRuns(runsDir: string): ActiveRun[] {
  if (!fs.existsSync(runsDir)) return [];

  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const out: ActiveRun[] = [];
  const now = Date.now();

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(runsDir, e.name);
    const summaryPath = path.join(dir, "summary.json");
    if (fs.existsSync(summaryPath)) continue;
    const eventsPath = path.join(dir, "events.ndjson");
    if (!fs.existsSync(eventsPath)) continue;

    const startedPath = path.join(dir, "started.json");
    let started: { trigger?: string; startedAt?: string; flags?: { slug?: string } } = {};
    try {
      started = JSON.parse(fs.readFileSync(startedPath, "utf8"));
    } catch { /* started.json may be missing on very young runs */ }

    const tail = readLastEvent(eventsPath);
    const eventCount = countLines(eventsPath);
    const slug = inferSlug(started, tail) ?? null;
    const verb = inferVerb(tail) ?? started.trigger ?? "run";
    const lastActivityTs = tail?.ts ?? started.startedAt ?? e.name;
    const lastActivityMs = new Date(lastActivityTs).getTime();
    const stalled = !Number.isNaN(lastActivityMs) &&
      (now - lastActivityMs) > STALL_THRESHOLD_MS;

    out.push({
      runId: e.name,
      dir,
      eventsPath,
      verb,
      slug,
      startedAt: started.startedAt ?? e.name,
      latestEvent: tail,
      eventCount,
      stalled,
    });
  }

  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function readLastEvent(eventsPath: string): ParsedEvent | null {
  try {
    const raw = fs.readFileSync(eventsPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return {
      ts: last.ts ?? new Date().toISOString(),
      type: last.type ?? "unknown",
      data: last.data ?? {},
    };
  } catch {
    return null;
  }
}

function countLines(filepath: string): number {
  try {
    const raw = fs.readFileSync(filepath, "utf8");
    return raw.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function inferSlug(
  started: { flags?: { slug?: string } },
  ev: ParsedEvent | null
): string | null {
  const fromEvent = ev?.data?.slug;
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  const fromFlags = started.flags?.slug;
  if (typeof fromFlags === "string" && fromFlags) return fromFlags;
  return null;
}

function inferVerb(ev: ParsedEvent | null): string | null {
  if (!ev) return null;
  const dot = ev.type.indexOf(".");
  if (dot < 0) return ev.type;
  return ev.type.slice(0, dot);
}

// ── AWAITING YOU zone: brainstorm body parsing ──────────────────────

export interface BrainstormSections {
  problem: string | null;
  /** The verdict's one-sentence rationale (`**Why:** …`). Highest-signal
   *  field for a reviewer — explains why the recommendation is what it is
   *  in domain terms, not generic feature speak. */
  why: string | null;
  variants: { label: string; body: string }[];
  topRisks: string[];
  ifAcceptedBuild: string | null;
}

export function parseBrainstormSections(filepath: string): BrainstormSections {
  let content: string;
  try {
    content = fs.readFileSync(filepath, "utf8");
  } catch {
    return { problem: null, why: null, variants: [], topRisks: [], ifAcceptedBuild: null };
  }

  const problem = extractSection(content, "Problem");
  const variantsBlock = extractSection(content, "Variants");
  const risksBlock =
    extractSection(content, "Risks and open questions") ?? extractSection(content, "Risks");
  const ifAcceptedBuild = matchBoldLabel(content, "If accepted, build");
  const why = matchBoldLabel(content, "Why");

  return {
    problem: problem ? firstParagraph(problem) : null,
    why: why ? stripMarkdown(why) : null,
    variants: variantsBlock ? parseVariants(variantsBlock) : [],
    topRisks: risksBlock ? parseBullets(risksBlock).slice(0, 3) : [],
    ifAcceptedBuild,
  };
}

function extractSection(content: string, heading: string): string | null {
  const re = new RegExp(
    `^#{2,3}\\s+${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=^#{2,3}\\s+|\\Z)`,
    "im"
  );
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function firstParagraph(s: string): string {
  const lines = s.split(/\n/);
  const para: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(line.trim());
  }
  return para.join(" ").trim();
}

function parseVariants(block: string): { label: string; body: string }[] {
  const out: { label: string; body: string }[] = [];
  const lines = block.split(/\n/);
  let current: { label: string; body: string } | null = null;

  for (const line of lines) {
    const m = line.match(/^\s*\d+\.\s+(.+)$/);
    if (m) {
      if (current) out.push(current);
      const head = m[1].trim();
      const lead = head.match(/^\*\*([^*]+)\*\*\s*[—:-]?\s*(.*)$/);
      if (lead) {
        current = { label: lead[1].trim(), body: lead[2].trim() };
      } else {
        current = { label: head.slice(0, 60), body: head };
      }
    } else if (current && line.trim()) {
      current.body = (current.body + " " + line.trim()).trim();
    }
  }
  if (current) out.push(current);
  return out;
}

function parseBullets(block: string): string[] {
  const out: string[] = [];
  const lines = block.split(/\n/);
  let current: string | null = null;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) {
      if (current) out.push(stripMarkdown(current.trim()));
      current = m[1].trim();
    } else if (current && line.trim()) {
      current = current + " " + line.trim();
    }
  }
  if (current) out.push(stripMarkdown(current.trim()));
  return out;
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function matchBoldLabel(content: string, label: string): string | null {
  const escaped = escapeRegex(label);
  const canonical = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, "i");
  const drift = new RegExp(`\\*\\*${escaped}:\\s*([^*\\n]+?)\\*\\*`, "i");
  const m = content.match(canonical) ?? content.match(drift);
  return m ? m[1].trim() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ideaFilepath(ideasDir: string, filename: string): string {
  return path.join(ideasDir, filename);
}

// ── TODAY zone: rolling activity ────────────────────────────────────

export interface TodayEntry {
  ts: string;
  kind: "captured" | "brainstormed" | "accepted" | "rejected" | "build-start" | "pr-open" | "shipped" | "needs-thought" | "other";
  slug: string;
  title?: string;
  detail?: string;
  /** True when this transition was made by the engine (auto-flow) rather
   *  than the human. The renderer surfaces a `⚡` glyph so the user
   *  always sees what the machine decided. */
  autoFlowed?: boolean;
}

/**
 * Build the TODAY feed from caller-provided idea + journal arrays.
 * Pure function — no fs reads.
 */
export function buildTodayFeed(
  ideas: IdeaSummary[],
  journal: JournalEntry[],
  opts: { windowMs?: number; limit?: number } = {}
): TodayEntry[] {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const since = Date.now() - windowMs;

  const titleBySlug = new Map<string, string>();
  for (const i of ideas) titleBySlug.set(i.slug, i.title);

  const out: TodayEntry[] = [];

  for (const i of ideas) {
    if (i.captured_at && new Date(i.captured_at).getTime() >= since) {
      out.push({ ts: i.captured_at, kind: "captured", slug: i.slug, title: i.title });
    }
  }

  for (const e of journal) {
    if (new Date(e.ts).getTime() < since) continue;
    const slug = e.slug ?? "—";
    const title = titleBySlug.get(slug);
    const entry = mapJournalEntry(e, slug, title);
    if (entry) out.push(entry);
  }

  out.sort((a, b) => b.ts.localeCompare(a.ts));

  const deduped: TodayEntry[] = [];
  for (const e of out) {
    const dup = deduped.find(
      (x) => x.slug === e.slug && x.kind === e.kind &&
        Math.abs(new Date(x.ts).getTime() - new Date(e.ts).getTime()) < 5000
    );
    if (dup) {
      const eDetailIsUrl = e.detail?.startsWith("http");
      const dupDetailIsUrl = dup.detail?.startsWith("http");
      if (eDetailIsUrl && !dupDetailIsUrl) dup.detail = e.detail;
      else if (!dup.detail && e.detail) dup.detail = e.detail;
      if (e.autoFlowed) dup.autoFlowed = true;
      continue;
    }
    deduped.push(e);
  }

  if (opts.limit) return deduped.slice(0, opts.limit);
  return deduped;
}

// ── lifecycle collapse: one row per idea, with the full trail ──────

export interface LifecycleEntry {
  slug: string;
  title?: string;
  /** Latest activity timestamp — used for sort + display. */
  latestTs: string;
  /** Earliest activity timestamp — for "X minutes/hours of progress" math. */
  earliestTs: string;
  /** Chronological list of kinds the slug went through, oldest first.
   *  Each kind appears at most once (we collapse repeats). */
  trail: TodayEntry["kind"][];
  /** Most recent kind in the trail — drives the row's primary color. */
  latestKind: TodayEntry["kind"];
  /** PR URL if the lifecycle reached pr-open / shipped. */
  prUrl?: string;
  /** True if any transition in the trail was auto-flowed by the engine.
   *  Drives the `⚡` glyph in the lifecycle row + NEXT bar prefix. */
  autoFlowed?: boolean;
}

/**
 * Collapse the per-event TODAY feed into one row per slug. Lifecycle
 * progression is captured as the `trail` array; the renderer turns
 * those kinds into a compact glyph string. Sorted newest first by
 * latest activity.
 *
 * Orphan filter: by default, entries whose slug has no current idea
 * file are dropped. The journal is append-only and never garbage-
 * collected, so an idea deleted yesterday would otherwise haunt
 * TODAY forever. Pass `includeOrphans: true` for debugging / audit
 * surfaces.
 */
export function buildTodayLifecycle(
  ideas: IdeaSummary[],
  journal: JournalEntry[],
  opts: { windowMs?: number; limit?: number; includeOrphans?: boolean } = {}
): LifecycleEntry[] {
  // Reuse the existing feed builder to dedupe and apply the time window.
  const flat = buildTodayFeed(ideas, journal, { windowMs: opts.windowMs });
  const bySlug = new Map<string, LifecycleEntry>();

  // We want trail order = chronological (oldest first), so iterate the
  // flat feed in reverse since it's sorted newest-first.
  for (let i = flat.length - 1; i >= 0; i--) {
    const e = flat[i];
    let entry = bySlug.get(e.slug);
    if (!entry) {
      entry = {
        slug: e.slug,
        title: e.title,
        latestTs: e.ts,
        earliestTs: e.ts,
        trail: [],
        latestKind: e.kind,
      };
      bySlug.set(e.slug, entry);
    }
    if (e.ts < entry.earliestTs) entry.earliestTs = e.ts;
    if (e.ts > entry.latestTs) {
      entry.latestTs = e.ts;
      entry.latestKind = e.kind;
    }
    if (!entry.trail.includes(e.kind)) entry.trail.push(e.kind);
    if (e.kind === "pr-open" && e.detail?.startsWith("http") && !entry.prUrl) {
      entry.prUrl = e.detail;
    }
    if (e.autoFlowed) entry.autoFlowed = true;
    if (!entry.title && e.title) entry.title = e.title;
  }

  // Stage-rank sort the trail. Same-timestamp events (e.g. captured_at
  // == brainstormed_at when a brainstorm runs immediately after capture)
  // get ordered by the lifecycle's known progression rather than by
  // insertion order, which is unstable across runs.
  for (const entry of bySlug.values()) {
    entry.trail.sort((a, b) => stageRank(a) - stageRank(b));
  }

  // Drop orphan entries by default — slug has no matching idea file.
  // We detect orphans by absence from titleBySlug rather than by
  // entry.title === undefined because an idea could legitimately have
  // an empty title (corrupted frontmatter). titleBySlug is the
  // authoritative "this slug exists" set.
  const slugsWithFiles = new Set(ideas.map((i) => i.slug));
  let entries = Array.from(bySlug.values());
  if (!opts.includeOrphans) {
    entries = entries.filter((e) => slugsWithFiles.has(e.slug));
  }

  const out = entries.sort((a, b) =>
    b.latestTs.localeCompare(a.latestTs)
  );

  if (opts.limit) return out.slice(0, opts.limit);
  return out;
}

const STAGE_RANK: Record<TodayEntry["kind"], number> = {
  captured: 0,
  brainstormed: 1,
  "needs-thought": 2,
  rejected: 2,
  accepted: 3,
  "build-start": 4,
  "pr-open": 5,
  shipped: 6,
  other: 7,
};

function stageRank(kind: TodayEntry["kind"]): number {
  return STAGE_RANK[kind] ?? 99;
}

function mapJournalEntry(
  e: JournalEntry,
  slug: string,
  title: string | undefined
): TodayEntry | null {
  if (e.type === "idea.status") {
    const to = (e.data?.to ?? "") as IdeaStatus;
    const from = (e.data?.from ?? "") as IdeaStatus;
    let kind: TodayEntry["kind"] = "other";
    if (to === "brainstormed") kind = "brainstormed";
    else if (to === "accepted") kind = "accepted";
    else if (to === "rejected") kind = "rejected";
    else if (to === "needs-more-thought") kind = "needs-thought";
    else if (to === "building") kind = "build-start";
    else if (to === "pr-open") kind = "pr-open";
    else if (to === "shipped") kind = "shipped";
    else return null;
    return { ts: e.ts, kind, slug, title, detail: from && to ? `${from} → ${to}` : undefined };
  }
  if (e.type === "idea.frontmatter" && e.data?.key === "github_pr") {
    return {
      ts: e.ts,
      kind: "pr-open",
      slug,
      title,
      detail: typeof e.data.value === "string" ? e.data.value : undefined,
    };
  }
  if (e.type === "idea.auto_flowed") {
    const to = (e.data?.to ?? "") as IdeaStatus;
    const kind: TodayEntry["kind"] =
      to === "accepted" ? "accepted" : to === "rejected" ? "rejected" : "other";
    return { ts: e.ts, kind, slug, title, autoFlowed: true };
  }
  return null;
}

// ── selection helpers ───────────────────────────────────────────────

export function awaitingIdeas(ideas: IdeaSummary[]): IdeaSummary[] {
  return ideas
    .filter((i) => i.status === "brainstormed" || i.status === "needs-critic-review")
    .sort((a, b) =>
      (b.brainstormed_at || b.captured_at).localeCompare(a.brainstormed_at || a.captured_at)
    );
}

export function buildableIdeas(ideas: IdeaSummary[]): IdeaSummary[] {
  return ideas
    .filter((i) => i.status === "accepted" || i.status === "building")
    .sort((a, b) =>
      (b.decided_at || b.captured_at).localeCompare(a.decided_at || a.captured_at)
    );
}

// ── small formatting utilities ──────────────────────────────────────

export function relTime(iso: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const hh = Math.floor(mm / 60);
  if (hh > 0) return `${hh}h${mm % 60}m`;
  if (mm > 0) return `${mm}m${s % 60}s`;
  return `${s}s`;
}
