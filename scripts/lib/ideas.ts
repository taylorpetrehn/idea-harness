/**
 * scripts/lib/ideas.ts
 *
 * Read/write helpers for ideas/<slug>.md files. The single source of
 * truth for idea state. All other modules go through this library —
 * never read or write idea files directly elsewhere.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fuzzyTitleMatch, slugify } from "./text";
import { atomicWriteFileSync } from "./atomic";
import { appendJournal } from "./journal";
import { log } from "./log";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

/** Per-process set of idea files we've already warned about for verdict drift. */
const warnedDriftFiles = new Set<string>();

export type IdeaStatus =
  | "raw"
  | "brainstormed"
  | "needs-critic-review"
  | "accepted"
  | "rejected"
  | "needs-more-thought"
  | "building"
  | "pr-open"
  // Phase 3 (PR follow-through): the engine watches the PR after it
  // opens and reacts to CI / review state. `pr-open` is the entry
  // point; the watcher then drives the idea through these.
  | "ci-running"
  | "ci-failed"
  | "review-changes-requested"
  | "merged"
  | "shipped";

export interface IdeaSummary {
  filename: string;
  slug: string;
  id: string;
  title: string;
  status: IdeaStatus;
  project: string;
  captured_at: string;
  brainstormed_at: string;
  decided_at: string;
  github_issue: string;
  github_pr: string;
  loop_count: number;
  // Parsed verdict fields if brainstormed
  recommended_action?: "accept" | "reject" | "needs-more-thought";
  confidence?: "high" | "medium" | "low";
  if_accepted_build?: string;
}

export function listIdeas(filterStatus?: IdeaStatus): IdeaSummary[] {
  if (!fs.existsSync(IDEAS_DIR)) return [];
  return fs
    .readdirSync(IDEAS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseIdeaFile(path.join(IDEAS_DIR, f)))
    .filter((i) => !filterStatus || i.status === filterStatus)
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

export function findIdea(slugOrTitle: string): IdeaSummary | null {
  const ideas = listIdeas();
  const exact = ideas.find((i) => i.slug === slugOrTitle || i.filename === slugOrTitle);
  if (exact) return exact;
  return ideas.find((i) => fuzzyTitleMatch(i.title, slugOrTitle)) ?? null;
}

export function readIdeaFile(slug: string): string {
  const filepath = resolveFilepath(slug);
  if (!filepath) throw new Error(`Idea not found: ${slug}`);
  return fs.readFileSync(filepath, "utf8");
}

// ── creation ──────────────────────────────────────────────────────────

export interface CreateRawIdeaInput {
  title: string;
  notes?: string;
  project?: string;
  source?: string;
}

export interface CreatedIdea {
  slug: string;
  filename: string;
  id: string;
  title: string;
  project: string;
}

/**
 * Write a fresh `raw` idea to ideas/<slug>.md. Single home for the
 * frontmatter shape so callers (capture verb, dashboard inline capture,
 * external integrations) all produce identical files.
 *
 * Caller resolves the project before calling — this lib doesn't reach
 * into projects.yml on its own to avoid pulling that dep into every
 * caller. The capture verb does it via `resolveProject`; the dashboard
 * passes `project` through directly.
 */
export function createRawIdea(input: CreateRawIdeaInput): CreatedIdea {
  if (!fs.existsSync(IDEAS_DIR)) fs.mkdirSync(IDEAS_DIR, { recursive: true });

  const id = crypto.randomBytes(4).toString("hex");
  const slug = `${slugify(input.title)}-${id.slice(0, 4)}`;
  const filepath = path.join(IDEAS_DIR, `${slug}.md`);
  const project = input.project ?? "letsbarker";
  const source = input.source ?? "capture";
  const title = input.title.replace(/"/g, '\\"');

  const content = `---
id: ${id}
title: "${title}"
status: raw
source: ${source}
project: ${project}
captured_at: ${new Date().toISOString()}
brainstormed_at: ~
decided_at: ~
github_issue: ~
github_pr: ~
loop_count: 0
---

## Raw Idea

${input.title}
${input.notes ? "\n## Notes\n\n" + input.notes + "\n" : ""}
## Brainstorm

<!-- Filled by the brainstormer. -->
`;

  atomicWriteFileSync(filepath, content);
  appendJournal({
    type: "idea.captured",
    slug,
    data: { project, source, title: input.title },
  });
  return { slug, filename: `${slug}.md`, id, title: input.title, project };
}

export function setStatusInFile(filepath: string, status: IdeaStatus): void {
  let content = fs.readFileSync(filepath, "utf8");
  const prior = content.match(/^status:\s*(.+)$/m)?.[1].trim();
  content = content.replace(/^status: .+$/m, `status: ${status}`);
  if (status === "brainstormed") {
    content = content.replace(/^brainstormed_at: .+$/m, `brainstormed_at: ${new Date().toISOString()}`);
  }
  if (status === "accepted" || status === "rejected" || status === "needs-more-thought") {
    content = content.replace(/^decided_at: .+$/m, `decided_at: ${new Date().toISOString()}`);
  }
  // Phase 3 PR-followthrough states never re-stamp decided_at — that
  // moment was when the human (or auto-flow) accepted the idea, not
  // every CI flap afterwards.
  atomicWriteFileSync(filepath, content);
  appendJournal({
    type: "idea.status",
    slug: path.basename(filepath, ".md"),
    data: { from: prior, to: status },
  });
}

export function setStatus(slugOrTitle: string, status: IdeaStatus, note?: string): void {
  const filepath = resolveFilepath(slugOrTitle);
  if (!filepath) throw new Error(`Idea not found: ${slugOrTitle}`);
  setStatusInFile(filepath, status);
  if (note) appendNote(filepath, note);
}

export function appendNote(filepath: string, note: string): void {
  let content = fs.readFileSync(filepath, "utf8");
  const dated = `> ${new Date().toISOString().slice(0, 10)}: ${note}`;

  if (content.includes("## Notes\n\n")) {
    content = content.replace(
      /(## Notes\n\n)([\s\S]*?)(?=\n## )/,
      (_, header, body) => `${header}${body.trim()}\n${dated}\n\n`
    );
  } else {
    // Insert a Notes section right before Brainstorm
    content = content.replace(
      /\n## Brainstorm/,
      `\n## Notes\n\n${dated}\n\n## Brainstorm`
    );
  }
  atomicWriteFileSync(filepath, content);
}

export function incrementLoopCount(slug: string): number {
  const filepath = resolveFilepath(slug);
  if (!filepath) throw new Error(`Idea not found: ${slug}`);
  let content = fs.readFileSync(filepath, "utf8");
  const match = content.match(/^loop_count:\s*(\d+)/m);
  const current = match ? parseInt(match[1], 10) : 0;
  const next = current + 1;
  content = content.replace(/^loop_count:\s*\d+$/m, `loop_count: ${next}`);
  atomicWriteFileSync(filepath, content);
  appendJournal({ type: "idea.loop_count", slug: path.basename(filepath, ".md"), data: { from: current, to: next } });
  return next;
}

/**
 * Single-writer for individual frontmatter fields. Rather than have
 * builder.ts hand-roll regex updates of `github_pr`, every caller goes
 * through here so we have one place that knows the file layout.
 */
export function setFrontmatterField(slugOrPath: string, key: string, value: string): void {
  const filepath = slugOrPath.endsWith(".md") && fs.existsSync(slugOrPath)
    ? slugOrPath
    : resolveFilepath(slugOrPath);
  if (!filepath) throw new Error(`Idea not found: ${slugOrPath}`);
  let content = fs.readFileSync(filepath, "utf8");
  const line = `${key}: ${value}`;
  if (new RegExp(`^${key}:`, "m").test(content)) {
    content = content.replace(new RegExp(`^${key}:.+$`, "m"), line);
  } else {
    // Insert just before the closing `---` of the frontmatter.
    content = content.replace(/^---\n([\s\S]*?)\n---/, (_, fm) => `---\n${fm}\n${line}\n---`);
  }
  atomicWriteFileSync(filepath, content);
  appendJournal({
    type: "idea.frontmatter",
    slug: path.basename(filepath, ".md"),
    data: { key, value },
  });
}

// ── Internal ──────────────────────────────────────────────────────────

function resolveFilepath(slugOrTitle: string): string | null {
  if (!fs.existsSync(IDEAS_DIR)) return null;
  const exact = path.join(IDEAS_DIR, slugOrTitle.endsWith(".md") ? slugOrTitle : `${slugOrTitle}.md`);
  if (fs.existsSync(exact)) return exact;

  for (const f of fs.readdirSync(IDEAS_DIR)) {
    if (f.startsWith(slugOrTitle) && f.endsWith(".md")) {
      return path.join(IDEAS_DIR, f);
    }
  }

  // Fuzzy title match
  for (const f of fs.readdirSync(IDEAS_DIR)) {
    if (!f.endsWith(".md")) continue;
    const summary = parseIdeaFile(path.join(IDEAS_DIR, f));
    if (fuzzyTitleMatch(summary.title, slugOrTitle)) {
      return path.join(IDEAS_DIR, f);
    }
  }
  return null;
}

export function parseIdeaFile(filepath: string): IdeaSummary {
  const content = fs.readFileSync(filepath, "utf8");
  const filename = path.basename(filepath);
  const slug = filename.replace(/\.md$/, "");

  const get = (key: string): string => {
    const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!m) return "";
    return m[1].trim().replace(/^"|"$/g, "").replace(/^~$/, "");
  };

  const status = (get("status") as IdeaStatus) || "raw";
  const verdict = parseVerdict(content);

  // A `brainstormed` file with no parseable verdict is a bug — usually a
  // contract drift the schema check should have caught. Warn once per file
  // per process so the noise doesn't drown out real run output.
  if (status === "brainstormed" && !verdict.recommended_action && !warnedDriftFiles.has(filepath)) {
    warnedDriftFiles.add(filepath);
    log.warn(
      `parseIdeaFile: ${filename} is marked "brainstormed" but has no parseable ` +
        `**Recommended action:** line. Frontmatter and body have drifted — re-run ` +
        `the brainstormer or fix the verdict block manually.`
    );
  }

  return {
    filename,
    slug,
    id: get("id"),
    title: get("title"),
    status,
    project: get("project") || "letsbarker",
    captured_at: get("captured_at"),
    brainstormed_at: get("brainstormed_at"),
    decided_at: get("decided_at"),
    github_issue: get("github_issue"),
    github_pr: get("github_pr"),
    loop_count: parseInt(get("loop_count") || "0", 10),
    recommended_action: verdict.recommended_action,
    confidence: verdict.confidence,
    if_accepted_build: verdict.if_accepted_build,
  };
}

export interface ParsedVerdict {
  recommended_action?: IdeaSummary["recommended_action"];
  confidence?: IdeaSummary["confidence"];
  if_accepted_build?: string;
}

/**
 * Parse the four canonical verdict lines from a brainstorm body.
 *
 * Strict on the contract format (\`**Recommended action:** ...\`). Tolerant
 * only of trailing-asterisk drift (\`**Verdict: build**\` showed up in the
 * dm-cohorts run before the schema gate landed). Anything else returns
 * empty fields, and the caller decides whether to warn.
 */
export function parseVerdict(content: string): ParsedVerdict {
  const action = matchBoldLabel(content, "Recommended action");
  const confidence = matchBoldLabel(content, "Confidence");
  const build = matchBoldLabel(content, "If accepted, build");

  const normalizedAction = action?.toLowerCase();
  const recommended_action: ParsedVerdict["recommended_action"] = (
    normalizedAction === "accept" || normalizedAction === "reject" || normalizedAction === "needs-more-thought"
      ? normalizedAction
      : undefined
  );

  const normalizedConfidence = confidence?.toLowerCase();
  const confidenceField: ParsedVerdict["confidence"] = (
    normalizedConfidence === "high" || normalizedConfidence === "medium" || normalizedConfidence === "low"
      ? normalizedConfidence
      : undefined
  );

  return {
    recommended_action,
    confidence: confidenceField,
    if_accepted_build: build || undefined,
  };
}

function matchBoldLabel(content: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match either "**Label:** value" (canonical) or "**Label: value**" (drift).
  const canonical = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, "i");
  const drift = new RegExp(`\\*\\*${escaped}:\\s*([^*\\n]+?)\\*\\*`, "i");
  const m = content.match(canonical) ?? content.match(drift);
  return m ? m[1].trim() : null;
}
