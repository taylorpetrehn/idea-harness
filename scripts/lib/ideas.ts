/**
 * scripts/lib/ideas.ts
 *
 * Read/write helpers for ideas/<slug>.md files. The single source of
 * truth for idea state. All other modules go through this library —
 * never read or write idea files directly elsewhere.
 */

import * as fs from "fs";
import * as path from "path";
import { fuzzyTitleMatch } from "./text";
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

export function setStatusInFile(filepath: string, status: IdeaStatus): void {
  let content = fs.readFileSync(filepath, "utf8");
  content = content.replace(/^status: .+$/m, `status: ${status}`);
  if (status === "brainstormed") {
    content = content.replace(/^brainstormed_at: .+$/m, `brainstormed_at: ${new Date().toISOString()}`);
  }
  if (status === "accepted" || status === "rejected" || status === "needs-more-thought") {
    content = content.replace(/^decided_at: .+$/m, `decided_at: ${new Date().toISOString()}`);
  }
  fs.writeFileSync(filepath, content, "utf8");
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
  fs.writeFileSync(filepath, content, "utf8");
}

export function incrementLoopCount(slug: string): number {
  const filepath = resolveFilepath(slug);
  if (!filepath) throw new Error(`Idea not found: ${slug}`);
  let content = fs.readFileSync(filepath, "utf8");
  const match = content.match(/^loop_count:\s*(\d+)/m);
  const current = match ? parseInt(match[1], 10) : 0;
  const next = current + 1;
  content = content.replace(/^loop_count:\s*\d+$/m, `loop_count: ${next}`);
  fs.writeFileSync(filepath, content, "utf8");
  return next;
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

interface ParsedVerdict {
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
function parseVerdict(content: string): ParsedVerdict {
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
