#!/usr/bin/env ts-node
/**
 * scripts/resume.ts
 *
 * Recover an in-flight build that didn't reach the PR step.
 *
 * Spawns Claude Code in the target repo with the resume system prompt:
 *   - The branch already exists with uncommitted/unpushed work
 *   - Don't re-implement; just commit, push, and open the PR
 *
 * Usage:
 *   npm run resume                 # pick the only/newest building idea
 *   npm run resume <slug>          # named building idea
 *   npm run resume <slug> --dry    # preview the resume prompt
 *
 * Slug is matched permissively (unique prefix or substring works).
 */

import { startRun, finalizeRun } from "./lib/runs";
import { listIdeas, IdeaSummary } from "./lib/ideas";
import { resolveIdeaShortSlug } from "./lib/slug";
import { graduateOne } from "./lib/graduator";
import { log } from "./lib/log";

interface Flags {
  slug?: string;
  variant?: string;
  dry: boolean;
}

function parseFlags(argv: string[]): Flags {
  const positional = argv.filter((a) => !a.startsWith("--"));
  return {
    slug: positional[0],
    variant: argv.find((a) => a.startsWith("--variant="))?.split("=")[1],
    dry: argv.includes("--dry"),
  };
}

function pickIdea(flags: Flags): IdeaSummary | null {
  const building = [...listIdeas("building")].sort((a, b) =>
    (b.captured_at || "").localeCompare(a.captured_at || "")
  );

  if (flags.slug) {
    return resolveIdeaShortSlug(flags.slug, building);
  }

  if (building.length === 0) {
    log.info("No `building` ideas to resume. (`npm run review in-flight` shows the queue.)");
    return null;
  }
  if (building.length === 1) return building[0];

  log.error(`Multiple building ideas — pass a slug:`);
  for (const i of building) log.error(`  ${i.slug}`);
  return null;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const idea = pickIdea(flags);
  if (!idea) process.exit(2);

  const run = startRun({ trigger: "resume", flags });
  const outcome = await graduateOne(idea, run, {
    intent: "resume",
    variant: flags.variant,
    dry: flags.dry,
  });
  finalizeRun(run, {
    status: "complete",
    slug: idea.slug,
    intent: "resume",
    outcome,
  });

  if (outcome === "passed" || outcome === "dry") process.exit(0);
  process.exit(1);
}

main().catch((err) => {
  log.error("Resume failed:", err);
  process.exit(1);
});
