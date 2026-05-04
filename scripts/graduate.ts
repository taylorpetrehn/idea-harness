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
 * Status flow:
 *   accepted → building → pr-open
 *
 * On success: the idea file gets `github_pr` in frontmatter, status moves
 * to `pr-open`, and a `## PR` section is appended.
 *
 * On failure: status reverts to `accepted` so the idea stays in the queue.
 */

import { startRun, finalizeRun, writeRunArtifact } from "./lib/runs";
import { listIdeas, setStatus, IdeaSummary } from "./lib/ideas";
import { recordMetric } from "./lib/metrics";
import { build, recordPrOnIdea } from "./agents/builder";
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
  // Allow re-graduating ideas that already moved to `building` (e.g. a prior
  // build crashed and we want to try again without manually flipping status
  // back to accepted).
  const eligible = [...listIdeas("accepted"), ...listIdeas("building")];
  if (flags.all) return listIdeas("accepted");
  if (flags.slugs.length === 0) {
    log.error("No slug given. Pass a slug, or --all to build every accepted idea.");
    process.exit(2);
  }
  const picked: IdeaSummary[] = [];
  for (const slug of flags.slugs) {
    const match = eligible.find((i) => i.slug === slug || i.slug.startsWith(slug));
    if (!match) {
      log.error(`No accepted/building idea matches "${slug}".`);
      log.error(
        `Accepted: ${listIdeas("accepted").map((i) => i.slug).join(", ") || "(none)"}`
      );
      log.error(
        `Building: ${listIdeas("building").map((i) => i.slug).join(", ") || "(none)"}`
      );
      process.exit(2);
    }
    picked.push(match);
  }
  return picked;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.dry) {
    process.env.IDEA_HARNESS_BUILDER = "dry";
  }

  const ideas = pickIdeas(flags);
  if (ideas.length === 0) {
    log.info("No accepted ideas to build.");
    process.exit(0);
  }

  const run = startRun({ trigger: "graduate", flags });
  let succeeded = 0;
  let failed = 0;

  for (const idea of ideas) {
    log.info(`Graduating ${idea.slug}…`);
    // Don't flip status in dry mode — the user is just inspecting the prompt.
    // In live/offline modes, we move to `building` so concurrent `npm run waiting`
    // callers see the in-flight work.
    if (!flags.dry) {
      setStatus(idea.slug, "building");
      recordMetric("build.started", 1);
    }

    try {
      const result = await build(idea, run, { variant: flags.variant });

      if (result.status === "pr-open" && result.pr_url) {
        recordPrOnIdea(idea, result.pr_url);
        log.info(`✓ ${idea.slug} → ${result.pr_url}`);
        recordMetric("build.pr_open", 1);
        succeeded++;
      } else if (result.status === "dry") {
        // Dry mode keeps status at building so the user can re-run live;
        // alternatively, undo by calling `npm run review set <slug> accepted`.
        log.info(`(dry) ${idea.slug} prompt prepared.`);
        succeeded++;
      } else {
        log.error(`✗ ${idea.slug} build failed (exit ${result.exitCode}).`);
        log.error(`  stdout tail:\n${result.stdoutTail}`);
        log.error(`  stderr tail:\n${result.stderrTail}`);
        setStatus(idea.slug, "accepted", `Build failed at ${new Date().toISOString()} — see runs/${run.id}/build-${idea.slug}.json`);
        recordMetric("build.failed", 1);
        failed++;
      }
    } catch (err) {
      log.error(`✗ ${idea.slug} crashed:`, err);
      writeRunArtifact(run, `build-${idea.slug}.error.json`, {
        slug: idea.slug,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      setStatus(idea.slug, "accepted", `Build crashed: ${(err as Error).message}`);
      recordMetric("build.crashed", 1);
      failed++;
    }
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
