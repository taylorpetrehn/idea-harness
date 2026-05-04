#!/usr/bin/env ts-node
/**
 * scripts/ship.ts
 *
 * "Do the obvious next thing" command. No slug required.
 *
 * Selection order (newest by captured_at within each bucket):
 *   1. accepted    → graduate it (build path)
 *   2. building    → resume it (recover the in-flight branch)
 *   3. brainstormed→ auto-accept then graduate (with a confirmation prompt
 *                    unless --yes is passed)
 *
 * Usage:
 *   npm run ship                # pick the next eligible idea, ship it
 *   npm run ship <slug>         # like graduate/resume but auto-detects intent
 *   npm run ship -- --dry       # preview the prompt
 *   npm run ship -- --yes       # auto-accept brainstormed ideas without asking
 *
 * Slug is matched permissively (unique prefix or substring is fine).
 */

import * as readline from "readline";
import { startRun, finalizeRun } from "./lib/runs";
import { listIdeas, setStatus, IdeaSummary } from "./lib/ideas";
import { resetLoopCount } from "./lib/loops";
import { recordMetric } from "./lib/metrics";
import { resolveIdeaShortSlug } from "./lib/slug";
import { graduateOne } from "./lib/graduator";
import { log } from "./lib/log";

interface Flags {
  slug?: string;
  variant?: string;
  dry: boolean;
  yes: boolean;
}

function parseFlags(argv: string[]): Flags {
  const positional = argv.filter((a) => !a.startsWith("--"));
  return {
    slug: positional[0],
    variant: argv.find((a) => a.startsWith("--variant="))?.split("=")[1],
    dry: argv.includes("--dry"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

interface Pick {
  idea: IdeaSummary;
  intent: "build" | "resume";
  needsAutoAccept: boolean;
}

function pickNext(flags: Flags): Pick | null {
  // Buckets sorted newest-first within each.
  const sortNewest = (xs: IdeaSummary[]) =>
    [...xs].sort((a, b) => (b.captured_at || "").localeCompare(a.captured_at || ""));

  const accepted = sortNewest(listIdeas("accepted"));
  const building = sortNewest(listIdeas("building"));
  const brainstormed = sortNewest(listIdeas("brainstormed"));
  const all = [...accepted, ...building, ...brainstormed];

  if (flags.slug) {
    const match = resolveIdeaShortSlug(flags.slug, all);
    if (!match) return null;
    return classify(match);
  }

  if (accepted.length) return classify(accepted[0]);
  if (building.length) return classify(building[0]);
  if (brainstormed.length) return classify(brainstormed[0]);
  return null;
}

function classify(idea: IdeaSummary): Pick {
  if (idea.status === "building") {
    return { idea, intent: "resume", needsAutoAccept: false };
  }
  if (idea.status === "brainstormed") {
    return { idea, intent: "build", needsAutoAccept: true };
  }
  // accepted
  return { idea, intent: "build", needsAutoAccept: false };
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return await new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const pick = pickNext(flags);
  if (!pick) {
    log.info("Nothing to ship — no accepted, building, or brainstormed ideas.");
    process.exit(0);
  }
  const { idea, intent, needsAutoAccept } = pick;

  if (needsAutoAccept) {
    log.info(`Next idea is brainstormed: ${idea.slug}`);
    log.info(`  ${idea.title}`);
    if (idea.recommended_action) {
      log.info(`  → ${idea.recommended_action} (${idea.confidence ?? "?"})`);
    }
    if (idea.if_accepted_build) {
      log.info(`  build: ${idea.if_accepted_build}`);
    }
    if (!flags.yes && !flags.dry) {
      const ok = await confirm(`Auto-accept ${idea.slug} and ship it?`);
      if (!ok) {
        log.info("Aborted.");
        process.exit(1);
      }
    }
    if (!flags.dry) {
      setStatus(idea.slug, "accepted", "Auto-accepted by `npm run ship`.");
      resetLoopCount(idea.slug);
      recordMetric("decision.accept", 1);
      // Refresh status field on the in-memory copy so graduator sees it.
      idea.status = "accepted";
    }
  }

  log.info(`${intent === "resume" ? "Resuming" : "Shipping"} ${idea.slug}…`);

  const run = startRun({ trigger: "ship", flags });
  const outcome = await graduateOne(idea, run, {
    intent,
    variant: flags.variant,
    dry: flags.dry,
  });
  finalizeRun(run, {
    status: "complete",
    slug: idea.slug,
    intent,
    outcome,
  });

  if (outcome === "passed" || outcome === "dry") process.exit(0);
  process.exit(1);
}

main().catch((err) => {
  log.error("Ship failed:", err);
  process.exit(1);
});
