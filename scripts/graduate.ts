#!/usr/bin/env ts-node
/**
 * scripts/graduate.ts
 *
 * Take an accepted idea and turn it into a real PR by spawning Claude Code
 * inside the target repo. This is the bridge between conversational review
 * and the codebase — the final step of the harness.
 *
 * Usage:
 *   npm run graduate <slug>                # build the named accepted idea
 *   npm run graduate -- --all              # build every accepted idea
 *   npm run graduate <slug> --variant=v2   # override the chosen variant
 *   npm run graduate <slug> --dry          # print the prompt, don't spawn
 *
 * Slug matching is permissive: a unique prefix or unique substring of the
 * full slug works (e.g. `dm-cohorts` resolves to the long capture). On
 * ambiguity the script lists candidates and exits.
 *
 * Status flow:
 *   accepted → building → pr-open
 *
 * On success: the idea file gets `github_pr` in frontmatter, status moves
 * to `pr-open`, and a `## PR` section is appended.
 *
 * On failure: status stays at `building` so `npm run resume <slug>` can
 * recover any work already on the branch.
 */

import { startRun, finalizeRun } from "./lib/runs";
import { listIdeas, IdeaSummary } from "./lib/ideas";
import { graduateOne } from "./lib/graduator";
import { resolveIdeaShortSlug } from "./lib/slug";
import { log } from "./lib/log";

interface Flags {
  slugs: string[];
  all: boolean;
  variant?: string;
  dry: boolean;
}

function parseFlags(argv: string[]): Flags {
  const slugs = argv.filter((a) => !a.startsWith("--"));
  return {
    slugs,
    all: argv.includes("--all"),
    variant: argv.find((a) => a.startsWith("--variant="))?.split("=")[1],
    dry: argv.includes("--dry"),
  };
}

function pickIdeas(flags: Flags): IdeaSummary[] {
  if (flags.all) return listIdeas("accepted");
  if (flags.slugs.length === 0) {
    log.error("No slug given. Pass a slug, or --all to build every accepted idea.");
    log.error("Tip: `npm run ship` picks the next eligible idea automatically.");
    process.exit(2);
  }
  // Eligible: accepted (fresh build) or building (retry — graduator decides
  // whether to revert; today it stays `building` and the retry works).
  const eligible = [...listIdeas("accepted"), ...listIdeas("building")];
  const picked: IdeaSummary[] = [];
  for (const slug of flags.slugs) {
    const match = resolveIdeaShortSlug(slug, eligible);
    if (!match) process.exit(2);
    picked.push(match);
  }
  return picked;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const ideas = pickIdeas(flags);
  if (ideas.length === 0) {
    log.info("No accepted ideas to build.");
    process.exit(0);
  }

  const run = startRun({ trigger: "graduate", flags });
  let succeeded = 0;
  let failed = 0;

  for (const idea of ideas) {
    const outcome = await graduateOne(idea, run, {
      intent: "build",
      variant: flags.variant,
      dry: flags.dry,
    });
    if (outcome === "passed" || outcome === "dry") succeeded++;
    else failed++;
  }

  finalizeRun(run, {
    status: "complete",
    requested: ideas.length,
    succeeded,
    failed,
  });

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  log.error("Graduate failed:", err);
  process.exit(1);
});
