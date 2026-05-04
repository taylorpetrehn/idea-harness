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

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

export type IdeaStatus =
  | "raw"
  | "brainstormed"
  | "needs-critic-review"
  | "accepted"
  | "rejected"
  | "needs-more-thought"
  | "building"
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

  const actionMatch = content.match(/\*\*Recommended action:\*\*\s*(\w[\w-]*)/);
  const confidenceMatch = content.match(/\*\*Confidence:\*\*\s*(high|medium|low)/i);
  const buildMatch = content.match(/\*\*If accepted, build:\*\*\s*(.+)/);

  return {
    filename,
    slug,
    id: get("id"),
    title: get("title"),
    status: (get("status") as IdeaStatus) || "raw",
    project: get("project") || "letsbarker",
    captured_at: get("captured_at"),
    brainstormed_at: get("brainstormed_at"),
    decided_at: get("decided_at"),
    github_issue: get("github_issue"),
    loop_count: parseInt(get("loop_count") || "0", 10),
    recommended_action: actionMatch?.[1] as IdeaSummary["recommended_action"],
    confidence: confidenceMatch?.[1].toLowerCase() as IdeaSummary["confidence"],
    if_accepted_build: buildMatch?.[1]?.trim(),
  };
}
