/**
 * scripts/lib/budgets.ts
 *
 * Token budget policy from contracts/context-budget.md.
 * Single source of truth — agent code reads from here, never hardcodes.
 *
 * Override at runtime via env vars:
 *   IDEA_HARNESS_PER_IDEA_TARGET
 *   IDEA_HARNESS_PER_IDEA_HARD_CAP
 *   IDEA_HARNESS_PER_RUN_CAP
 *   IDEA_HARNESS_CRITIC_PER_IDEA
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const BUDGETS = {
  perIdeaTarget: envInt("IDEA_HARNESS_PER_IDEA_TARGET", 10_000),
  perIdeaHardCap: envInt("IDEA_HARNESS_PER_IDEA_HARD_CAP", 25_000),
  perRunCap: envInt("IDEA_HARNESS_PER_RUN_CAP", 100_000),
  criticPerIdea: envInt("IDEA_HARNESS_CRITIC_PER_IDEA", 3_000),
  tier2PerRequest: envInt("IDEA_HARNESS_TIER2_PER_REQUEST", 5_000),
  tier2MaxRequests: envInt("IDEA_HARNESS_TIER2_MAX_REQUESTS", 3),

  // Tier 1 sub-caps. The contract budgets ~3,000 tokens for ALL of Tier 1
  // combined (product + decisions + raw idea + past-ideas index). We split
  // it like this to keep each section bounded independently — one runaway
  // section (e.g., a 50k-line product.md) can't starve the others. The
  // sum exceeds 3,000 on purpose: most sections come in well under their
  // cap, and we'd rather have headroom than truncate when not necessary.
  tier1ProductMaxTokens: envInt("IDEA_HARNESS_TIER1_PRODUCT_MAX", 1_400),
  tier1DecisionsMaxTokens: envInt("IDEA_HARNESS_TIER1_DECISIONS_MAX", 800),
  tier1PastIdeasMaxTokens: envInt("IDEA_HARNESS_TIER1_PAST_IDEAS_MAX", 800),
  tier1PastIdeasMaxRows: envInt("IDEA_HARNESS_TIER1_PAST_IDEAS_MAX_ROWS", 60),
  tier1TotalMaxTokens: envInt("IDEA_HARNESS_TIER1_TOTAL_MAX", 3_500),
};

export type Budgets = typeof BUDGETS;
