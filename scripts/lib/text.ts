/**
 * scripts/lib/text.ts
 *
 * Pure string utilities: slug generation and fuzzy title matching.
 * No I/O, no dependencies on other harness modules.
 */

/**
 * Slugify a title to a URL-safe kebab-case identifier.
 * Keeps lowercase alphanumerics and hyphens, max 50 chars.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

/**
 * Fuzzy-match two titles. Returns true if they're "the same idea" by
 * normalized comparison. Used to dedupe Reminders against existing ideas.
 *
 * Strategy:
 *   1. Normalize both (lowercase, drop punctuation, collapse whitespace).
 *   2. Exact match on normalized form → true.
 *   3. Token-set jaccard >= 0.7 → true.
 */
export function fuzzyTitleMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    if (shorter / longer >= 0.6) return true;
  }
  const tokensA = new Set(na.split(/\s+/).filter(Boolean));
  const tokensB = new Set(nb.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union >= 0.7;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
