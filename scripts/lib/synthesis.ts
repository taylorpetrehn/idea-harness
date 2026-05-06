/**
 * scripts/lib/synthesis.ts
 *
 * Phase 4 cross-idea synthesis. Cheap-and-local similarity scan: for
 * a given title + raw body, find any past idea whose title+raw is
 * "near enough" to flag as a likely duplicate / supersedence.
 *
 * The original roadmap mentioned LLM embeddings as one option; we
 * pick the cheap path here — Jaccard over normalized word-bigrams.
 * No model call, no extra dep, deterministic, fine for the
 * order-of-100s ideas a single user accumulates.
 *
 * Threshold defaults to 0.7 (matches roadmap "if >70% similarity to
 * an existing idea"); override with `IDEA_HARNESS_SYNTHESIS_THRESHOLD`.
 *
 * Surfaced through:
 *   - `findSimilar(title, body, ideas)` for any caller (the
 *     dashboard's NEXT bar uses it; brainstormer Tier 1 prompt
 *     can include the result).
 */

import * as fs from "fs";
import * as path from "path";
import { IdeaSummary } from "./ideas";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

export interface SynthesisHit {
  slug: string;
  title: string;
  similarity: number;
}

export interface SynthesisOptions {
  /** Override the similarity threshold (0-1). Default 0.7 or
   *  IDEA_HARNESS_SYNTHESIS_THRESHOLD env. */
  threshold?: number;
  /** Include the candidate's raw body when scoring (default true).
   *  Pass false for "title-only" mode when only titles are
   *  available (e.g., from the past-ideas index). */
  includeBody?: boolean;
  /** Cap on hits returned. Default 3. */
  limit?: number;
  /** Optional override for the corpus. Default reads
   *  ideas/<slug>.md raw body lazily for each candidate. */
  corpus?: Array<{ slug: string; title: string; body?: string }>;
}

/**
 * Find ideas in `pool` similar to the new `(title, body)` pair.
 * Pool entries with the same slug as `excludeSlug` are skipped.
 * Returns ranked hits above the threshold; empty when nothing
 * meaningful matches.
 */
export function findSimilar(
  title: string,
  body: string,
  pool: IdeaSummary[],
  opts: SynthesisOptions = {},
  excludeSlug?: string
): SynthesisHit[] {
  const threshold = opts.threshold ?? parseFloat(
    process.env.IDEA_HARNESS_SYNTHESIS_THRESHOLD ?? "0.7"
  );
  const includeBody = opts.includeBody ?? true;
  const limit = opts.limit ?? 3;

  const target = bigrams(normalizeText(`${title}\n${includeBody ? body : ""}`));
  if (target.size === 0) return [];

  const corpus = opts.corpus ?? buildCorpusFromIdeas(pool, includeBody);
  const hits: SynthesisHit[] = [];
  for (const c of corpus) {
    if (excludeSlug && c.slug === excludeSlug) continue;
    const candidate = bigrams(normalizeText(`${c.title}\n${includeBody ? c.body ?? "" : ""}`));
    if (candidate.size === 0) continue;
    const sim = jaccard(target, candidate);
    if (sim >= threshold) {
      hits.push({ slug: c.slug, title: c.title, similarity: round(sim) });
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}

// ── helpers ───────────────────────────────────────────────────────

function buildCorpusFromIdeas(
  pool: IdeaSummary[],
  includeBody: boolean
): Array<{ slug: string; title: string; body?: string }> {
  const out: Array<{ slug: string; title: string; body?: string }> = [];
  for (const i of pool) {
    let body: string | undefined;
    if (includeBody) {
      try {
        const raw = fs.readFileSync(path.join(IDEAS_DIR, i.filename), "utf8");
        body = extractRawIdea(raw);
      } catch { /* missing files are OK — fall back to title-only */ }
    }
    out.push({ slug: i.slug, title: i.title, body });
  }
  return out;
}

function extractRawIdea(content: string): string {
  const m = content.match(/^##\s+Raw Idea\s*\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/im);
  return m ? m[1].trim() : "";
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const tokens = s.split(/\s+/).filter((w) => w.length > 1);
  if (tokens.length === 0) return new Set();
  if (tokens.length === 1) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    out.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  // Always include unigrams too — short titles otherwise score 0.
  for (const t of tokens) out.add(t);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
