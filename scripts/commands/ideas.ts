/**
 * scripts/commands/ideas.ts
 *
 * `harness ideas list | show | waiting`
 *
 * Read-only inspection of the ideas/ directory. Never mutates state.
 * `waiting` is sugar for "list with status in {brainstormed, needs-critic-review}",
 * sorted oldest-first so first-in shows first-out.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb, IdeaStatusSchema, IdeaSummarySchema } from "../lib/contracts";
import { listIdeas, readIdeaFile, IdeaStatus, IdeaSummary, parseIdeaFile } from "../lib/ideas";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

// ── ideas list ──────────────────────────────────────────────────────

export interface IdeasListArgs {
  status?: string;
  project?: string;
}

const IdeasListData = z.object({
  total: z.number(),
  ideas: z.array(IdeaSummarySchema),
});

registerVerb({
  verb: "ideas.list",
  description: "List ideas, optionally filtered by status or project key.",
  data: IdeasListData,
});

export async function runList(args: IdeasListArgs, out: Output): Promise<void> {
  const status = args.status as IdeaStatus | undefined;
  let ideas = status ? listIdeas(status) : listIdeas();
  if (args.project) ideas = ideas.filter((i) => i.project === args.project);

  if (out.mode === "pretty") {
    if (ideas.length === 0) {
      out.info("No matching ideas.");
    } else {
      for (const i of ideas) {
        out.stdout(`${i.slug}  [${i.status}]  ${i.title}\n`);
      }
    }
  }

  out.result({ total: ideas.length, ideas });
}

// ── ideas show ──────────────────────────────────────────────────────

export interface IdeasShowArgs {
  slug: string;
  section?: "frontmatter" | "brainstorm" | "notes" | "raw";
}

const IdeasShowData = z.object({
  slug: z.string(),
  filename: z.string(),
  section: z.string(),
  content: z.string(),
});

registerVerb({
  verb: "ideas.show",
  description: "Show one idea — full file or a single section.",
  data: IdeasShowData,
});

export async function runShow(args: IdeasShowArgs, out: Output): Promise<void> {
  const summary = findOne(args.slug);
  if (!summary) {
    out.error("NOT_FOUND", `No idea matches "${args.slug}".`, {
      hint: "Run `harness ideas list` to see all ideas.",
    });
    return;
  }
  const full = readIdeaFile(summary.slug);
  const content = args.section ? extractSection(full, args.section) : full;

  if (out.mode === "pretty") {
    out.stdout(content);
    if (!content.endsWith("\n")) out.stdout("\n");
  }

  out.result({
    slug: summary.slug,
    filename: summary.filename,
    section: args.section ?? "all",
    content,
  });
}

// ── ideas waiting ───────────────────────────────────────────────────

export interface IdeasWaitingArgs {}

const IdeasWaitingData = z.object({
  total_waiting: z.number(),
  ideas: z.array(IdeaSummarySchema),
});

registerVerb({
  verb: "ideas.waiting",
  description: "List ideas waiting for review (brainstormed | needs-critic-review).",
  data: IdeasWaitingData,
});

export async function runWaiting(_args: IdeasWaitingArgs, out: Output): Promise<void> {
  const waiting = [...listIdeas("brainstormed"), ...listIdeas("needs-critic-review")];

  if (out.mode === "pretty") {
    if (waiting.length === 0) {
      out.info("No ideas waiting.");
    } else {
      for (const i of waiting) {
        const tag = i.status === "needs-critic-review" ? "  [⚠ critic escalated]" : "";
        out.stdout(`${i.slug}${tag}\n  ${i.title}\n`);
        if (i.recommended_action) {
          out.stdout(`  → ${i.recommended_action} (${i.confidence ?? "?"})\n`);
        }
        if (i.if_accepted_build) {
          out.stdout(`  build: ${i.if_accepted_build}\n`);
        }
        out.stdout("\n");
      }
    }
  }

  out.result(
    { total_waiting: waiting.length, ideas: waiting },
    waiting.length > 0 ? "Pick one with `harness review next` or accept directly." : undefined
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function findOne(slug: string): IdeaSummary | null {
  const candidates = listIdeas();
  const exact = candidates.find((i) => i.slug === slug);
  if (exact) return exact;
  // permissive prefix
  const prefix = candidates.filter((i) => i.slug.startsWith(slug));
  if (prefix.length === 1) return prefix[0];
  // permissive substring
  const sub = candidates.filter((i) => i.slug.includes(slug));
  if (sub.length === 1) return sub[0];
  // fall back to a direct file lookup (handles the .md extension case)
  const filepath = path.join(IDEAS_DIR, slug.endsWith(".md") ? slug : `${slug}.md`);
  if (fs.existsSync(filepath)) return parseIdeaFile(filepath);
  return null;
}

function extractSection(content: string, section: NonNullable<IdeasShowArgs["section"]>): string {
  switch (section) {
    case "frontmatter": {
      const m = content.match(/^---\n([\s\S]*?)\n---/);
      return m ? m[1] : "";
    }
    case "brainstorm": {
      const m = content.match(/## Brainstorm\n+([\s\S]*?)(?=\n## (?!Brainstorm)|$)/);
      return (m?.[1] ?? "").trim();
    }
    case "notes": {
      const m = content.match(/## Notes\n+([\s\S]*?)(?=\n## )/);
      return (m?.[1] ?? "").trim();
    }
    case "raw": {
      const m = content.match(/## Raw Idea\n+([\s\S]*?)(?=\n## )/);
      return (m?.[1] ?? "").trim();
    }
  }
}
