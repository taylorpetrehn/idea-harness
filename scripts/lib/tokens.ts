/**
 * scripts/lib/tokens.ts
 *
 * Token estimation. We don't ship a real tokenizer (would add a heavy
 * dep just for budget enforcement). Anthropic's published rule of thumb
 * is ~4 chars/token for English prose, which holds for our context
 * shape (markdown product docs, idea titles, English decisions). We
 * use 3.6 as a slightly conservative ratio so estimates skew high — it
 * is better to trim a little too aggressively than to blow the budget.
 *
 * Override per-environment with IDEA_HARNESS_CHARS_PER_TOKEN if you
 * find the real cost is consistently off in one direction.
 */

const DEFAULT_CHARS_PER_TOKEN = 3.6;

function charsPerToken(): number {
  const raw = process.env.IDEA_HARNESS_CHARS_PER_TOKEN;
  if (!raw) return DEFAULT_CHARS_PER_TOKEN;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHARS_PER_TOKEN;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken());
}

/**
 * Truncate text to fit within `maxTokens`. Returns the original text
 * unchanged if it fits, or a head+tail slice with a marker in between
 * when it doesn't. Head/tail split is 70/30 by default — leading
 * sections of product/decisions docs tend to carry more weight.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  opts: { headRatio?: number; marker?: string } = {}
): { text: string; truncated: boolean; originalTokens: number; finalTokens: number } {
  const originalTokens = estimateTokens(text);
  if (originalTokens <= maxTokens) {
    return { text, truncated: false, originalTokens, finalTokens: originalTokens };
  }

  const cpt = charsPerToken();
  const marker = opts.marker ?? "\n\n…[trimmed for context budget]…\n\n";
  const markerTokens = estimateTokens(marker);
  const budgetChars = Math.max(0, Math.floor((maxTokens - markerTokens) * cpt));
  const headRatio = opts.headRatio ?? 0.7;
  const headChars = Math.max(0, Math.floor(budgetChars * headRatio));
  const tailChars = Math.max(0, budgetChars - headChars);

  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const trimmed = head + marker + tail;

  return {
    text: trimmed,
    truncated: true,
    originalTokens,
    finalTokens: estimateTokens(trimmed),
  };
}
