/**
 * scripts/agents/brainstormer.ts
 *
 * L4: Execution. Takes one BrainstormItem and produces a brainstorm
 * artifact matching contracts/brainstorm-output.md.
 *
 * Each call gets a FRESH context window. No cross-idea replay.
 *
 * The brainstormer is responsible for:
 *   - Loading Tier 1 context
 *   - Optionally requesting Tier 2 context (max 3 requests)
 *   - Producing a brainstorm that passes the critic
 *   - Returning a `commit()` callback that writes the result on critic pass
 *
 * It does NOT:
 *   - Update frontmatter directly (the harness does that)
 *   - Decide whether the brainstorm is good (the critic does that)
 *   - Make decisions across ideas
 */

import * as fs from "fs";
import * as path from "path";
import { BrainstormItem } from "./initializer";
import { Run } from "../lib/runs";
import { loadTier1Context, loadTier2, Tier2Request } from "../lib/context";
import { callBrainstormerModel } from "../lib/llm";
import { setStatusInFile, appendNote } from "../lib/ideas";
import { log } from "../lib/log";
import { BUDGETS } from "../lib/budgets";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");
const CONTRACTS_DIR = path.join(__dirname, "..", "..", "contracts");
const REFERENCES_DIR = path.join(__dirname, "..", "..", "references");

// Read once at module load — the contract files are part of the deploy and
// don't change mid-run. Re-reading per call would just risk drift if a file
// is being edited while a long run is in flight.
const BRAINSTORM_CONTRACT = readFileOrThrow(path.join(CONTRACTS_DIR, "brainstorm-output.md"));
const IDEA_SCHEMA_REFERENCE = readFileOrThrow(path.join(REFERENCES_DIR, "idea-schema.md"));
const WORKED_EXAMPLE = extractWorkedExample(IDEA_SCHEMA_REFERENCE);

function readFileOrThrow(p: string): string {
  if (!fs.existsSync(p)) throw new Error(`Required harness file missing: ${p}`);
  return fs.readFileSync(p, "utf8");
}

/**
 * Pull the "Worked Example" markdown block out of references/idea-schema.md.
 * The reference doc owns the canonical example; we don't want to duplicate
 * it in the prompt and let it drift.
 */
function extractWorkedExample(ref: string): string {
  const m = ref.match(/## Worked Example\s*\n+```markdown\n([\s\S]*?)\n```/);
  return m ? m[1].trim() : "";
}

export interface BrainstormResult {
  slug: string;
  output: string;          // markdown brainstorm content
  rawIdea: string;
  notes: string;
  contextRequests: ContextRequest[];
  tier1Tokens: {
    product: number;
    decisions: number;
    pastIdeasIndex: number;
    total: number;
  };
  tokensUsed: number;
  durationMs: number;
  commit: () => Promise<void>;
  commitAsNeedsCriticReview: (feedback: string) => Promise<void>;
}

export interface ContextRequest {
  tier: 2 | 3;
  kind: "past_idea_body" | "codebase_read" | "schema_history" | "broad_walk";
  target: string;
  reason: string;
  loaded_at: string;
}

export interface BrainstormOptions {
  feedback?: string;       // critic feedback for revision
}

export async function brainstorm(
  item: BrainstormItem,
  run: Run,
  opts: BrainstormOptions = {}
): Promise<BrainstormResult> {
  const start = Date.now();
  const filepath = resolveIdeaPath(item.slug);
  if (!filepath) throw new Error(`No idea file for slug: ${item.slug}`);

  const ideaText = fs.readFileSync(filepath, "utf8");
  const rawIdea = extractSection(ideaText, "Raw Idea") ?? "";
  const notes = extractSection(ideaText, "Notes") ?? "";
  const project = extractFrontmatterValue(ideaText, "project") ?? undefined;

  // ── L3: Context — Tier 1 ─────────────────────────────────────────────
  const context = await loadTier1Context();

  // ── Round-trip Tier 2 context_request loop ──────────────────────────
  // The brainstormer may emit context_request JSON blocks. We satisfy up
  // to BUDGETS.tier2MaxRequests of them, then call the model once more
  // with the resolved data appended.
  //
  // Two failure modes we explicitly guard against, both seen in live runs:
  //   1. The model produces a great brainstorm on iteration 1, then on
  //      iteration 2 emits ONLY more context_requests (no body). We must
  //      never overwrite a non-empty output with a later empty one.
  //   2. The model keeps asking for context past the cap. Once we've hit
  //      tier2MaxRequests we tell the model "finalize now — no more
  //      requests" so it stops emitting them.
  let totalTokens = 0;
  const allRequests: ContextRequest[] = [];
  const resolvedTier2: Array<{ req: ContextRequest; body: string }> = [];
  let bestOutput = "";

  let prompt = buildPrompt({
    item,
    rawIdea,
    notes,
    context,
    revisionFeedback: opts.feedback,
    resolvedTier2,
    capReached: false,
  });

  let result = await callBrainstormerModel({ prompt, budgetTokens: item.budget_tokens });
  totalTokens += result.tokensUsed;
  allRequests.push(...result.contextRequests);
  if (result.output.trim()) bestOutput = result.output;

  let pendingRequests = dedupeRequests(result.contextRequests, resolvedTier2).slice(
    0,
    BUDGETS.tier2MaxRequests - resolvedTier2.length
  );

  while (pendingRequests.length > 0 && resolvedTier2.length < BUDGETS.tier2MaxRequests) {
    for (const req of pendingRequests) {
      if (resolvedTier2.length >= BUDGETS.tier2MaxRequests) break;
      try {
        const body = await loadTier2({
          kind: req.kind as Tier2Request["kind"],
          target: req.target,
          reason: req.reason,
          project,
        });
        resolvedTier2.push({ req, body });
      } catch (err) {
        log.warn(`    Tier 2 load failed for ${req.kind}/${req.target}: ${(err as Error).message}`);
      }
    }

    const capReached = resolvedTier2.length >= BUDGETS.tier2MaxRequests;
    prompt = buildPrompt({
      item,
      rawIdea,
      notes,
      context,
      revisionFeedback: opts.feedback,
      resolvedTier2,
      capReached,
    });
    result = await callBrainstormerModel({ prompt, budgetTokens: item.budget_tokens });
    totalTokens += result.tokensUsed;
    if (result.output.trim()) bestOutput = result.output;
    else log.warn(`    Tier 2 iteration produced empty output; keeping prior best.`);

    const newRequests = dedupeRequests(result.contextRequests, resolvedTier2);
    allRequests.push(...newRequests);
    pendingRequests = capReached
      ? []
      : newRequests.slice(0, BUDGETS.tier2MaxRequests - resolvedTier2.length);
  }

  const output = bestOutput;
  const tokensUsed = totalTokens;
  const contextRequests = allRequests;

  return {
    slug: item.slug,
    output,
    rawIdea,
    notes,
    contextRequests,
    tier1Tokens: context.tokenBreakdown,
    tokensUsed,
    durationMs: Date.now() - start,

    commit: async () => {
      if (!output.trim()) {
        // Defensive: never write a blank brainstorm. The idea stays `raw`
        // and gets retried on the next run. This should not happen given
        // the loop guards, but if it does we want to fail loudly rather
        // than silently ship empty content to Taylor's review queue.
        log.error(
          `    ✗ Refusing to commit empty brainstorm for ${path.basename(filepath)}; ` +
            `idea stays raw for retry on next run.`
        );
        appendNote(filepath, "Brainstormer returned empty output — retried.");
        throw new Error(`Brainstormer produced empty output for ${item.slug}`);
      }
      let content = fs.readFileSync(filepath, "utf8");
      content = content.replace(
        /## Brainstorm\n\n<!-- Filled by the brainstormer\. -->/,
        `## Brainstorm\n\n${output}`
      );
      fs.writeFileSync(filepath, content, "utf8");
      setStatusInFile(filepath, "brainstormed");
      log.info(`    ✓ Wrote brainstorm to ${path.basename(filepath)}`);
    },

    commitAsNeedsCriticReview: async (feedback: string) => {
      if (!output.trim()) {
        // Same guard: don't escalate an empty brainstorm — it just makes
        // Taylor read a blank entry. Surface the failure mode in notes.
        log.error(
          `    ✗ Refusing to escalate empty brainstorm for ${path.basename(filepath)}; ` +
            `idea stays raw for retry.`
        );
        appendNote(
          filepath,
          `Brainstormer returned empty output during critic-escalation path. Critic feedback was: ${feedback}`
        );
        throw new Error(`Brainstormer produced empty output for ${item.slug}`);
      }
      let content = fs.readFileSync(filepath, "utf8");
      content = content.replace(
        /## Brainstorm\n\n<!-- Filled by the brainstormer\. -->/,
        `## Brainstorm\n\n${output}`
      );
      fs.writeFileSync(filepath, content, "utf8");
      setStatusInFile(filepath, "needs-critic-review");
      appendNote(filepath, `Critic escalated: ${feedback}`);
      log.warn(`    ⚠ Escalated ${path.basename(filepath)} to needs-critic-review`);
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function resolveIdeaPath(slug: string): string | null {
  const exact = path.join(IDEAS_DIR, `${slug}.md`);
  if (fs.existsSync(exact)) return exact;

  for (const f of fs.readdirSync(IDEAS_DIR)) {
    if (f.startsWith(slug) && f.endsWith(".md")) return path.join(IDEAS_DIR, f);
  }
  return null;
}

function extractSection(text: string, heading: string): string | null {
  const re = new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`);
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

function extractFrontmatterValue(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!m) return null;
  const v = m[1].trim().replace(/^"|"$/g, "");
  return v === "~" ? null : v;
}

function dedupeRequests(
  requests: ContextRequest[],
  resolved: Array<{ req: ContextRequest; body: string }>
): ContextRequest[] {
  const seen = new Set(resolved.map((r) => `${r.req.kind}::${r.req.target}`));
  const out: ContextRequest[] = [];
  for (const r of requests) {
    const key = `${r.kind}::${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function buildPrompt(opts: {
  item: BrainstormItem;
  rawIdea: string;
  notes: string;
  context: { product: string; decisions: string; pastIdeasIndex: string };
  revisionFeedback?: string;
  resolvedTier2?: Array<{ req: ContextRequest; body: string }>;
  capReached?: boolean;
}): string {
  const { item, rawIdea, notes, context, revisionFeedback, resolvedTier2, capReached } = opts;
  const tier2Block =
    resolvedTier2 && resolvedTier2.length
      ? `\n## Tier 2 Context (you requested these)\n\n` +
        resolvedTier2
          .map(
            (r) =>
              `### ${r.req.kind}: ${r.req.target}\n_Reason given: ${r.req.reason}_\n\n${r.body}`
          )
          .join("\n\n") +
        "\n"
      : "";

  return `You are the brainstormer agent in the LetsBarker idea harness. Your
job is to evaluate this idea honestly and help Taylor decide whether to build
it. You are not an enthusiast — you are an evaluator.

Your output MUST conform exactly to the contract below. A deterministic
schema check runs before the critic and will reject any drift in section
names, ordering, or verdict-line format. After that the critic checks
quality. Both must pass for the brainstorm to reach Taylor.

${revisionFeedback ? `\n## REVISION REQUESTED\n\nA previous attempt was rejected. The exact feedback follows. Fix only what's flagged — do not regenerate the parts that already passed.\n\n${revisionFeedback}\n` : ""}

## Contract: Brainstorm Output (verbatim)

${BRAINSTORM_CONTRACT}

${WORKED_EXAMPLE ? `## Worked Example (a brainstorm that would pass)\n\nThis is from references/idea-schema.md. Match this STRUCTURE — section names verbatim, verdict lines exactly four bold-prefixed lines.\n\n${WORKED_EXAMPLE}\n\n---\n` : ""}

## Tier 1 Context

### Product
${context.product}

### Conscious Decisions
${context.decisions}

### Past Ideas Index
${context.pastIdeasIndex}
${tier2Block}
## The Idea

Raw capture:
${rawIdea}

${notes ? `Additional notes:\n${notes}\n` : ""}

## Your Output

Produce ONLY the brainstorm markdown content. It MUST:

1. Start with the line \`### Problem\` (H3, exact spelling).
2. Contain these eight H3 sections IN THIS ORDER, names verbatim:
   ### Problem
   ### Audience and frequency
   ### Existing footprint
   ### Simplest version
   ### Variants
   ### Risks and open questions
   ### Past idea overlap
   ### Verdict
3. End with EXACTLY these four bold-prefixed lines under \`### Verdict\`:
   **Recommended action:** accept | reject | needs-more-thought
   **Confidence:** high | medium | low
   **Why:** <one sentence specific to THIS idea>
   **If accepted, build:** <simplest version | variant 1 | variant 2 | etc>

Do not invent additional sections (no "Effort estimate", no "Recommendation",
no "Fit with current focus" — fold that content into Verdict / Risks / Variants).
Do not rename sections. Do not change verdict-line wording. The schema
check is mechanical and will catch any deviation.

No preamble, no closing remarks, no meta-commentary.

${
  capReached
    ? `**Tier 2 cap reached.** Do NOT emit any more context_request blocks. \
Produce the complete brainstorm now using the Tier 1 + Tier 2 context above. \
If something you wanted is still missing, say so in "Risks and open questions" \
and verdict accordingly — but do not stall.`
    : `If you need Tier 2 context (a past idea body, a specific codebase file, \
or schema history), emit a context_request as a JSON object on its own line, \
exactly like this, and stop output until the harness re-prompts you with \
the resolved data:

{ "tool": "context_request", "tier": 2, "kind": "codebase_read", "target": "<repo-relative path>", "reason": "<why you need it>" }

Valid kinds: "past_idea_body" | "codebase_read" | "schema_history".
Maximum 3 requests per idea (hard cap). Only request what the brainstorm \
genuinely depends on — every request is logged. If you can produce a useful \
brainstorm without Tier 2, just produce the brainstorm.`
}

CRITICAL: Your final response MUST contain the brainstorm body — never reply \
with only context_request blocks AND no brainstorm content. If you've already \
gathered what you need, write the brainstorm. An empty brainstorm is treated \
as a failure.

Be honest. If the idea is too vague to evaluate, say so explicitly in
"Risks and open questions" and use \`needs-more-thought\` as the recommended
action. Don't pad weak ideas to look like strong ones.${item.budget_tokens > 0 ? `\n\nBudget hint: ~${item.budget_tokens} tokens for this brainstorm.` : ""}`;
}
