/**
 * scripts/lib/context.ts
 *
 * L3: Context. Loads context tiers per contracts/context-budget.md.
 *
 * Tier 1 is loaded synchronously at the start of every brainstorm.
 * Tier 2 and Tier 3 are loaded on request from the brainstormer.
 *
 * Repo-grounded helpers (loadCodebaseRead, loadSchemaHistory) read from
 * the path resolved by `repoPathFor(project)`. Override per-project with
 * env vars; fall back to the projects.yml local_path.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { listIdeas, IdeaSummary } from "./ideas";
import { loadProjects, defaultProjectKey } from "./projects";
import { log } from "./log";
import { BUDGETS } from "./budgets";
import { estimateTokens, truncateToTokens } from "./tokens";

const execFileAsync = promisify(execFile);

const CONTEXT_DIR = path.join(__dirname, "..", "..", "context");

export interface Tier1Context {
  product: string;
  decisions: string;
  pastIdeasIndex: string;
  /** Per-section token estimates after trimming. Surfaces in run logs. */
  tokenBreakdown: {
    product: number;
    decisions: number;
    pastIdeasIndex: number;
    total: number;
  };
}

export async function loadTier1Context(): Promise<Tier1Context> {
  const product = trimProduct(
    readOrDefault(
      path.join(CONTEXT_DIR, "product.md"),
      "(context/product.md not yet filled in — brainstorms will be generic)"
    )
  );
  const decisions = trimDecisions(
    readOrDefault(
      path.join(CONTEXT_DIR, "decisions.md"),
      "(no conscious decisions recorded yet)"
    )
  );
  const pastIdeasIndex = trimPastIdeasIndex(listIdeas());

  const breakdown = {
    product: estimateTokens(product),
    decisions: estimateTokens(decisions),
    pastIdeasIndex: estimateTokens(pastIdeasIndex),
    total: 0,
  };
  breakdown.total = breakdown.product + breakdown.decisions + breakdown.pastIdeasIndex;

  if (breakdown.total > BUDGETS.tier1TotalMaxTokens) {
    log.warn(
      `Tier 1 context still ${breakdown.total} tokens after per-section trim ` +
        `(cap ${BUDGETS.tier1TotalMaxTokens}); this is unusual — check sub-caps in budgets.ts.`
    );
  } else {
    log.debug(
      `Tier 1 token breakdown: product=${breakdown.product} decisions=${breakdown.decisions} ` +
        `index=${breakdown.pastIdeasIndex} total=${breakdown.total}`
    );
  }

  return { product, decisions, pastIdeasIndex, tokenBreakdown: breakdown };
}

function trimProduct(raw: string): string {
  const max = BUDGETS.tier1ProductMaxTokens;
  const r = truncateToTokens(raw, max, {
    headRatio: 0.75,
    marker:
      "\n\n…[product.md trimmed by context budget — request a Tier 2 codebase_read for specifics]…\n\n",
  });
  if (r.truncated) {
    log.warn(
      `Tier 1: product.md trimmed from ~${r.originalTokens} to ~${r.finalTokens} tokens ` +
        `(cap ${max}). Consider shortening context/product.md.`
    );
  }
  return r.text;
}

function trimDecisions(raw: string): string {
  const max = BUDGETS.tier1DecisionsMaxTokens;
  const before = estimateTokens(raw);
  if (before <= max) return raw;

  // decisions.md is an append-only ledger of dated entries. Keep the most
  // recent entries (they're most likely to still be load-bearing) and
  // summarize the older ones as a count, rather than blunt head/tail.
  const entries = splitDecisionEntries(raw);
  if (entries.length <= 1) {
    // Single block — fall back to head+tail truncation.
    const r = truncateToTokens(raw, max, { headRatio: 0.6 });
    log.warn(
      `Tier 1: decisions.md trimmed from ~${r.originalTokens} to ~${r.finalTokens} tokens (cap ${max}).`
    );
    return r.text;
  }

  const header = entries[0].isHeader ? entries[0].text : "";
  const dated = entries.filter((e) => !e.isHeader);
  // Walk from newest to oldest, keep until we approach the cap.
  const reversed = [...dated].reverse();
  const kept: typeof dated = [];
  let runningTokens = estimateTokens(header);
  const budgetMargin = 100; // leave room for the elision marker
  for (const e of reversed) {
    const t = estimateTokens(e.text);
    if (runningTokens + t > max - budgetMargin) break;
    kept.unshift(e);
    runningTokens += t;
  }
  const droppedCount = dated.length - kept.length;
  const droppedRange =
    droppedCount > 0
      ? `\n> _[${droppedCount} older decision(s) elided to fit context budget — see context/decisions.md for full ledger]_\n`
      : "";

  const result =
    (header ? header.trim() + "\n\n" : "") +
    droppedRange +
    kept.map((e) => e.text).join("\n");

  log.warn(
    `Tier 1: decisions.md kept ${kept.length}/${dated.length} entries ` +
      `(~${estimateTokens(result)}/${before} tokens, cap ${max}).`
  );
  return result;
}

interface DecisionEntry {
  text: string;
  isHeader: boolean; // the prologue (everything before the first ### YYYY-MM-DD)
}

function splitDecisionEntries(raw: string): DecisionEntry[] {
  // Split on `### ` headings that begin a line. The first chunk is the
  // file header (title + intro paragraph, before any decision entry).
  const lines = raw.split("\n");
  const entries: DecisionEntry[] = [];
  let buffer: string[] = [];
  let isHeader = true;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n").replace(/\n+$/, "");
    if (text.trim()) entries.push({ text, isHeader });
    buffer = [];
  };

  for (const line of lines) {
    if (/^### /.test(line)) {
      flush();
      isHeader = false;
    }
    buffer.push(line);
  }
  flush();
  return entries;
}

function trimPastIdeasIndex(ideas: IdeaSummary[]): string {
  if (ideas.length === 0) return "(no past ideas)";

  // Priority order for what stays in the index:
  //   1. Active states first (raw, brainstormed, needs-critic-review,
  //      needs-more-thought, building) — these are decisions in flight.
  //   2. Then accepted (recently graduated, often referenced).
  //   3. Then most recent shipped/rejected.
  // Sort each bucket newest-first by captured_at.
  const ACTIVE = new Set([
    "raw",
    "brainstormed",
    "needs-critic-review",
    "needs-more-thought",
    "building",
  ]);
  const byBucket = (i: IdeaSummary) =>
    ACTIVE.has(i.status) ? 0 : i.status === "accepted" ? 1 : 2;
  const sorted = [...ideas].sort((a, b) => {
    const bucket = byBucket(a) - byBucket(b);
    if (bucket !== 0) return bucket;
    return (b.captured_at || "").localeCompare(a.captured_at || "");
  });

  const maxRows = BUDGETS.tier1PastIdeasMaxRows;
  const maxTokens = BUDGETS.tier1PastIdeasMaxTokens;

  const formatRow = (i: IdeaSummary) => `- [${i.status}] ${i.title} (${i.slug})`;
  const rows: string[] = [];
  let droppedTerminal = 0;
  let runningTokens = 0;

  for (const idea of sorted) {
    if (rows.length >= maxRows) {
      droppedTerminal++;
      continue;
    }
    const row = formatRow(idea);
    const t = estimateTokens(row + "\n");
    if (runningTokens + t > maxTokens) {
      droppedTerminal++;
      continue;
    }
    rows.push(row);
    runningTokens += t;
  }

  let body = rows.join("\n");
  if (droppedTerminal > 0) {
    const note = `\n_[${droppedTerminal} older terminal idea(s) omitted — request a Tier 2 past_idea_body for any specific slug]_`;
    body += note;
    log.warn(
      `Tier 1: past-ideas index kept ${rows.length}/${ideas.length} rows ` +
        `(~${estimateTokens(body)} tokens, cap ${maxTokens}, row cap ${maxRows}).`
    );
  }
  return body || "(no past ideas)";
}

export interface Tier2Request {
  kind: "past_idea_body" | "codebase_read" | "schema_history";
  target: string;
  reason: string;
  project?: string;
}

export async function loadTier2(req: Tier2Request): Promise<string> {
  switch (req.kind) {
    case "past_idea_body":
      return loadPastIdeaBody(req.target);
    case "codebase_read":
      return loadCodebaseRead(req.target, req.project);
    case "schema_history":
      return loadSchemaHistory(req.target, req.project);
  }
}

// ── Internal ──────────────────────────────────────────────────────────

function readOrDefault(filepath: string, fallback: string): string {
  if (!fs.existsSync(filepath)) return fallback;
  return fs.readFileSync(filepath, "utf8");
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function repoPathFor(projectKey?: string): string | null {
  const key = projectKey || defaultProjectKey();
  const envOverride = process.env[`IDEA_HARNESS_REPO_${key.toUpperCase()}`];
  if (envOverride) return expandHome(envOverride);
  if (process.env.LETSBARKER_REPO_PATH && key === "letsbarker") {
    return expandHome(process.env.LETSBARKER_REPO_PATH);
  }
  const project = loadProjects().find((p) => p.key === key);
  if (!project?.local_path) return null;
  const abs = expandHome(project.local_path);
  return fs.existsSync(abs) ? abs : null;
}

function loadPastIdeaBody(slug: string): string {
  const filepath = path.join(__dirname, "..", "..", "ideas", `${slug}.md`);
  if (!fs.existsSync(filepath)) return `(idea not found: ${slug})`;
  return fs.readFileSync(filepath, "utf8");
}

const MAX_CODEBASE_READ_BYTES = 16 * 1024;

function loadCodebaseRead(target: string, projectKey?: string): string {
  const repo = repoPathFor(projectKey);
  if (!repo) {
    return `(no repo path for project "${projectKey ?? "default"}" — set IDEA_HARNESS_REPO_<KEY> or ensure projects.yml has a valid local_path)`;
  }

  const normalized = path.normalize(target).replace(/^\/+/, "");
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return `(rejected path "${target}": must be relative to repo root)`;
  }

  const fullPath = path.join(repo, normalized);
  if (!fullPath.startsWith(repo + path.sep) && fullPath !== repo) {
    return `(rejected path "${target}": resolves outside repo)`;
  }
  if (!fs.existsSync(fullPath)) return `(not found in repo: ${normalized})`;

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const entries = fs
      .readdirSync(fullPath)
      .map((e) => {
        const sub = path.join(fullPath, e);
        try {
          return fs.statSync(sub).isDirectory() ? `${e}/` : e;
        } catch {
          return e;
        }
      })
      .sort();
    return `# Directory listing: ${normalized}\n\n${entries.join("\n")}`;
  }

  const buf = fs.readFileSync(fullPath);
  if (buf.length > MAX_CODEBASE_READ_BYTES) {
    return (
      `# ${normalized} (truncated to first ${MAX_CODEBASE_READ_BYTES}B of ${buf.length}B)\n\n` +
      buf.slice(0, MAX_CODEBASE_READ_BYTES).toString("utf8")
    );
  }
  return `# ${normalized}\n\n${buf.toString("utf8")}`;
}

async function loadSchemaHistory(area: string, projectKey?: string): Promise<string> {
  const repo = repoPathFor(projectKey);
  if (!repo) {
    return `(no repo path for project "${projectKey ?? "default"}" — set IDEA_HARNESS_REPO_<KEY>)`;
  }

  const schemaCandidates = [
    "db/schema.rb",
    "db/schema.sql",
    "prisma/schema.prisma",
    "schema.sql",
  ];
  let schemaText = "";
  for (const candidate of schemaCandidates) {
    const candidatePath = path.join(repo, candidate);
    if (fs.existsSync(candidatePath)) {
      const content = fs.readFileSync(candidatePath, "utf8");
      schemaText = scopeSchemaToArea(content, area, candidate);
      break;
    }
  }

  const migrations = await recentMigrations(repo, area);

  if (!schemaText && migrations.length === 0) {
    return `(no schema or migrations found for "${area}" in ${repo})`;
  }

  const sections: string[] = [];
  if (schemaText) sections.push(schemaText);
  if (migrations.length) {
    sections.push(`## Recent migrations matching "${area}"\n\n${migrations.join("\n")}`);
  }
  return sections.join("\n\n");
}

function scopeSchemaToArea(content: string, area: string, label: string): string {
  const lines = content.split("\n");
  const areaLower = area.toLowerCase();

  const blocks: string[] = [];
  let buffer: string[] = [];
  let blockMatches = false;

  const isBlockStart = (l: string) =>
    /^(create_table|model |table |create table )/i.test(l.trim());

  const isBlockEnd = (l: string) => {
    const t = l.trim();
    return t === "end" || t === "}" || t === "";
  };

  for (const line of lines) {
    if (isBlockStart(line)) {
      if (blockMatches && buffer.length) blocks.push(buffer.join("\n"));
      buffer = [line];
      blockMatches = line.toLowerCase().includes(areaLower);
    } else {
      buffer.push(line);
      if (!blockMatches && line.toLowerCase().includes(areaLower)) blockMatches = true;
      if (isBlockEnd(line)) {
        if (blockMatches && buffer.length) blocks.push(buffer.join("\n"));
        buffer = [];
        blockMatches = false;
      }
    }
  }
  if (blockMatches && buffer.length) blocks.push(buffer.join("\n"));

  if (blocks.length === 0) {
    return `## ${label}\n\n(no tables/models matched "${area}" — try broader term)`;
  }
  return `## ${label} (matched "${area}")\n\n\`\`\`\n${blocks.join("\n\n").slice(0, MAX_CODEBASE_READ_BYTES)}\n\`\`\``;
}

async function recentMigrations(repo: string, area: string): Promise<string[]> {
  const migrationDirs = ["db/migrate", "prisma/migrations", "migrations"];
  for (const dir of migrationDirs) {
    const full = path.join(repo, dir);
    if (!fs.existsSync(full)) continue;
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const all = fs.readdirSync(full).sort().reverse();
    const matches = all.filter((name) => name.toLowerCase().includes(area.toLowerCase()));
    return matches.slice(0, 10).map((name) => `- ${path.join(dir, name)}`);
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "log", "--name-only", "--pretty=format:%h %s", "-n", "20", "--", `*${area}*`],
      { timeout: 5_000 }
    );
    return stdout.trim() ? [stdout.trim()] : [];
  } catch (err) {
    log.debug(`git log fallback failed: ${(err as Error).message}`);
    return [];
  }
}
