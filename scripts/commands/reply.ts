/**
 * scripts/commands/reply.ts
 *
 * `harness reply <slug> "<answer>"`
 *
 * Phase 2 verb — answers the most recent `## Open Question` the
 * sharpener appended to an idea body. The next brainstorm pass picks
 * the reply up automatically because the brainstormer reads the whole
 * body each call (no special wiring required here).
 *
 * Side effects:
 *   - Appends `### Reply` under the most recent `## Open Question`.
 *   - Bumps `loop_count` (the brainstormer hasn't run yet, but the
 *     idea has logically taken another lap through the loop).
 *   - Journals `idea.replied` for the dashboard / inspector.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { findIdea, incrementLoopCount } from "../lib/ideas";
import { atomicWriteFileSync } from "../lib/atomic";
import { appendJournal } from "../lib/journal";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

export interface ReplyArgs {
  slug: string;
  answer: string;
}

const ReplyData = z.object({
  slug: z.string(),
  loop_count: z.number(),
  question: z.string().nullable(),
  reply_appended: z.string(),
});

registerVerb({
  verb: "reply",
  description: "Answer the most recent Open Question the sharpener posed to an idea.",
  data: ReplyData,
});

export async function runReply(args: ReplyArgs, out: Output): Promise<void> {
  const answer = args.answer?.trim();
  if (!answer) {
    out.error("BAD_INPUT", "Answer must be non-empty.", {
      hint: 'Usage: harness reply <slug> "the answer"',
    });
    return;
  }

  const idea = findIdea(args.slug);
  if (!idea) {
    out.error("NOT_FOUND", `No idea matched "${args.slug}".`, {
      hint: "Run `harness ideas list` to find the slug.",
    });
    return;
  }
  const filepath = path.join(IDEAS_DIR, idea.filename);

  let body: string;
  try {
    body = fs.readFileSync(filepath, "utf8");
  } catch (err) {
    out.error("NOT_FOUND", `Failed reading ${idea.filename}: ${(err as Error).message}`);
    return;
  }

  const { question, updated } = appendReply(body, answer);
  if (!question) {
    out.error("BAD_INPUT", `No Open Question section found in ${idea.slug}.`, {
      hint: "The sharpener has not asked a question — nothing to reply to.",
    });
    return;
  }

  atomicWriteFileSync(filepath, updated);
  const newLoop = incrementLoopCount(idea.slug);
  appendJournal({
    type: "idea.replied",
    slug: idea.slug,
    data: { question, answer },
  });

  if (out.mode === "pretty") {
    out.stdout(`✓ ${idea.slug} ← reply (loop_count: ${newLoop})\n`);
  }
  out.result(
    {
      slug: idea.slug,
      loop_count: newLoop,
      question,
      reply_appended: answer,
    },
    "Re-run `harness brainstorm` to refresh the verdict with the answer."
  );
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Find the LAST `## Open Question` block, append a `### Reply`
 * subsection under it (or after any prior reply), and return the
 * whole updated document plus the question text. Returns
 * `question: null` when no Open Question exists.
 */
function appendReply(body: string, answer: string):
  { question: string | null; updated: string } {
  const re = /^##\s+Open Question\s*\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/img;
  let last: { full: string; inner: string; index: number } | null = null;
  for (const m of body.matchAll(re)) {
    last = {
      full: m[0],
      inner: m[1],
      index: m.index ?? 0,
    };
  }
  if (!last) return { question: null, updated: body };

  const question = firstParagraph(last.inner);
  const dated = new Date().toISOString().slice(0, 10);
  const replyBlock = `\n\n### Reply (${dated})\n\n${answer}\n`;

  // Insert the reply at the END of the last Open Question block —
  // preserves any prior replies and the question text itself.
  const blockEnd = last.index + last.full.length;
  const trimmedBefore = body.slice(0, blockEnd).replace(/\n+$/, "");
  const after = body.slice(blockEnd);
  const updated = `${trimmedBefore}${replyBlock}${after}`;
  return { question, updated };
}

function firstParagraph(s: string): string {
  const lines = s.split(/\n/);
  const para: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (para.length) break;
      continue;
    }
    if (/^#{2,3}\s/.test(line)) break;
    para.push(line.trim());
  }
  return para.join(" ").trim();
}
