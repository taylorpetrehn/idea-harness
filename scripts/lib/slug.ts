/**
 * scripts/lib/slug.ts
 *
 * Permissive slug matching for the user-facing CLIs (build / resume / ship).
 *
 * Given a short string from the command line, find the unique idea it refers
 * to in a list of candidates. Match strategies, in order:
 *
 *   1. Exact slug match.
 *   2. Unique prefix match.
 *   3. Unique substring match.
 *
 * Ambiguity (multiple matches) is treated as an error — we'd rather make the
 * user disambiguate than silently pick one. Misses are also errors.
 *
 * Logs candidates to stderr on miss/ambiguity so the user can fix the input
 * without re-running `harness ideas waiting`.
 */

import { IdeaSummary } from "./ideas";
import { log } from "./log";

export function resolveIdeaShortSlug(
  input: string,
  candidates: IdeaSummary[]
): IdeaSummary | null {
  if (candidates.length === 0) {
    log.error(`No matching ideas to choose from for "${input}".`);
    return null;
  }

  const exact = candidates.find((i) => i.slug === input);
  if (exact) return exact;

  const prefix = candidates.filter((i) => i.slug.startsWith(input));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    log.error(`"${input}" is an ambiguous prefix. Matches:`);
    for (const c of prefix) log.error(`  ${c.slug}  (${c.status})`);
    return null;
  }

  const substring = candidates.filter((i) => i.slug.includes(input));
  if (substring.length === 1) return substring[0];
  if (substring.length > 1) {
    log.error(`"${input}" matches multiple slugs:`);
    for (const c of substring) log.error(`  ${c.slug}  (${c.status})`);
    return null;
  }

  log.error(`No idea matches "${input}". Candidates:`);
  for (const c of candidates) log.error(`  ${c.slug}  (${c.status})`);
  return null;
}
