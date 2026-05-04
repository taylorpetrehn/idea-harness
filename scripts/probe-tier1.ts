#!/usr/bin/env ts-node
/**
 * scripts/probe-tier1.ts
 *
 * Loads Tier 1 context with the *current* state of the working dir
 * (whatever is in context/ and ideas/) and prints the per-section
 * token breakdown. Useful for verifying budget enforcement is working
 * after inflating product.md or seeding fake ideas.
 */

import { loadTier1Context } from "./lib/context";
import { BUDGETS } from "./lib/budgets";

async function main() {
  const t1 = await loadTier1Context();
  const { product, decisions, pastIdeasIndex, tokenBreakdown } = t1;

  process.stdout.write(
    JSON.stringify(
      {
        caps: {
          product: BUDGETS.tier1ProductMaxTokens,
          decisions: BUDGETS.tier1DecisionsMaxTokens,
          pastIdeasIndex: BUDGETS.tier1PastIdeasMaxTokens,
          totalSoftCap: BUDGETS.tier1TotalMaxTokens,
        },
        tokens: tokenBreakdown,
        sizes: {
          product_chars: product.length,
          decisions_chars: decisions.length,
          pastIdeasIndex_chars: pastIdeasIndex.length,
        },
        product_truncated: product.includes("[product.md trimmed"),
        decisions_truncated:
          decisions.includes("older decision(s) elided") ||
          decisions.includes("[trimmed for context budget]"),
        index_truncated: pastIdeasIndex.includes("older terminal idea(s) omitted"),
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
