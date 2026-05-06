/**
 * scripts/agents/sharpener.ts
 *
 * Phase 2: scope sharpener. Invoked after the brainstormer commits a
 * `needs-more-thought` verdict. Reads the brainstorm body, picks the
 * single highest-leverage clarifying question, appends an
 * `## Open Question` section to the idea body, and (best-effort)
 * pushes the question back at the originating source — typically the
 * Apple Reminder that captured the idea — so the user can answer
 * where they brain-dumped it.
 *
 * Boundaries:
 *   - Does NOT change the idea's status. The body grows, but it stays
 *     `brainstormed` until `harness reply <slug>` answers the question
 *     and re-runs the brainstormer.
 *   - Does NOT loop on its own. One question per invocation. Repeated
 *     calls would just append more `## Open Question` blocks, which is
 *     fine but rarely useful.
 *   - Failure is non-fatal. The caller (brainstormer.commit) wraps the
 *     call in a try/catch and logs only — never breaks the brainstorm
 *     commit.
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "../lib/atomic";
import { appendJournal } from "../lib/journal";
import { callSharpenerModel } from "../lib/llm";
import { log } from "../lib/log";

export interface SharpenResult {
  /** The clarifying question the model produced — single sentence. */
  question: string;
  /** True if the question was successfully written into the idea body. */
  written: boolean;
  /** True if a write-back to the originating source succeeded. */
  pushedBack: boolean;
  tokensUsed: number;
}

export interface SharpenOptions {
  /** Optional: an already-loaded source-write-back hook (Reminders et al.).
   *  When supplied AND the model produced a question, the harness pushes
   *  the question back at the upstream item. */
  pushBack?: (text: string) => Promise<boolean>;
}

/**
 * Run the sharpener against a single idea file. Returns the question
 * the model produced and what was done with it. Caller decides
 * whether to journal or surface the result; this function only
 * touches the idea body and (optionally) the source.
 */
export async function sharpen(
  filepath: string,
  opts: SharpenOptions = {}
): Promise<SharpenResult> {
  if (!fs.existsSync(filepath)) {
    throw new Error(`sharpener: idea file not found: ${filepath}`);
  }
  const body = fs.readFileSync(filepath, "utf8");

  const risks = extractSection(body, "Risks and open questions") ??
    extractSection(body, "Risks") ?? "";
  const why = matchBoldLabel(body, "Why") ?? "";
  const problem = extractSection(body, "Problem") ?? "";

  const prompt = buildPrompt({ problem, why, risks });
  const result = await callSharpenerModel({ prompt });
  const question = sanitize(result.output);

  if (!question) {
    log.warn(`sharpener: empty output for ${path.basename(filepath)}; skipping body update.`);
    return { question: "", written: false, pushedBack: false, tokensUsed: result.tokensUsed };
  }

  const updated = appendOpenQuestion(body, question);
  atomicWriteFileSync(filepath, updated);

  const slug = path.basename(filepath, ".md");
  appendJournal({
    type: "idea.sharpened",
    slug,
    data: { question },
  });
  log.info(`    ❓ Sharpened ${path.basename(filepath)}: "${question}"`);

  let pushedBack = false;
  if (opts.pushBack) {
    try {
      pushedBack = await opts.pushBack(question);
    } catch (err) {
      log.warn(`sharpener: source write-back failed: ${(err as Error).message}`);
    }
  }

  return { question, written: true, pushedBack, tokensUsed: result.tokensUsed };
}

// ── helpers ─────────────────────────────────────────────────────────

function buildPrompt(opts: { problem: string; why: string; risks: string }): string {
  const { problem, why, risks } = opts;
  return `You are the scope sharpener inside the LetsBarker idea harness.
The brainstormer just decided this idea needs more thought before it
can be evaluated. Your job: pick the SINGLE highest-leverage clarifying
question — the answer to which would let the brainstormer produce a
confident accept/reject on the next attempt.

Output exactly ONE sentence ending with a question mark. No preamble,
no bullet points, no quotes, no commentary. Just the question.

## Problem (verbatim from the brainstorm)
${problem.trim() || "(missing)"}

## Why the brainstormer hesitated (verbatim from the verdict)
${why.trim() || "(missing)"}

## Risks and open questions (verbatim from the brainstorm)
${risks.trim() || "(missing)"}

Now produce the one clarifying question.`;
}

function extractSection(content: string, heading: string): string | null {
  const re = new RegExp(
    `^#{2,3}\\s+${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=^#{2,3}\\s+|$(?![\\s\\S]))`,
    "im"
  );
  return content.match(re)?.[1].trim() ?? null;
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

function sanitize(s: string): string {
  // Strip surrounding quotes / asterisks the model sometimes wraps in,
  // collapse whitespace to a single line so the body stays clean.
  return s
    .trim()
    .replace(/^["'`*]+|["'`*]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Append a fresh `## Open Question` block to the idea body. Multiple
 * runs accumulate (we never overwrite a prior question — the user's
 * answer stays under it), but most ideas only get one.
 */
function appendOpenQuestion(body: string, question: string): string {
  const trimmed = body.replace(/\n+$/, "");
  return `${trimmed}\n\n## Open Question\n\n${question}\n`;
}
