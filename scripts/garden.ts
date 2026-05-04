#!/usr/bin/env ts-node
/**
 * scripts/garden.ts
 *
 * Top-level harness orchestrator. Composes the five layers in order.
 * This is the only file that knows about the full sequence — each layer
 * module is independently testable.
 *
 * Usage:
 *   npm run garden                  # full run
 *   npm run garden -- --dry-run     # plan only, no execution
 *   npm run garden -- --idea=<slug> # brainstorm one specific idea
 */

import { plan, RunPlan } from "./agents/initializer";
import { harvest } from "./agents/harvester";
import { brainstorm, BrainstormResult } from "./agents/brainstormer";
import { critique } from "./agents/critic";
import { writeRunArtifact, finalizeRun, startRun } from "./lib/runs";
import { recordMetric } from "./lib/metrics";
import { log } from "./lib/log";

interface Flags {
  dryRun: boolean;
  ideaSlug?: string;
}

function parseFlags(argv: string[]): Flags {
  return {
    dryRun: argv.includes("--dry-run"),
    ideaSlug: argv.find((a) => a.startsWith("--idea="))?.split("=")[1],
  };
}

function brainstormArtifact(result: BrainstormResult) {
  return {
    slug: result.slug,
    output: result.output,
    rawIdea: result.rawIdea,
    notes: result.notes,
    contextRequests: result.contextRequests,
    tier1Tokens: result.tier1Tokens,
    tokensUsed: result.tokensUsed,
    durationMs: result.durationMs,
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const run = startRun({ trigger: "manual", flags });

  // ── L2: Control — plan the run ───────────────────────────────────────
  log.info("Planning run…");
  const runPlan: RunPlan = await plan({ run, focusSlug: flags.ideaSlug });
  writeRunArtifact(run, "plan.json", runPlan);

  if (runPlan.harvest.length === 0 && runPlan.brainstorm.length === 0) {
    // Empty run — exit silently, no artifacts beyond the empty plan
    log.silent("Nothing to do. Exiting.");
    finalizeRun(run, { status: "empty" });
    process.exit(0);
  }

  log.info(
    `Plan: harvest ${runPlan.harvest.length}, brainstorm ${runPlan.brainstorm.length}, skip ${runPlan.skip.length}`
  );
  log.info(`Estimated cost: $${runPlan.estimated_cost_usd.toFixed(3)}`);

  if (flags.dryRun) {
    log.info("Dry run — exiting after planning.");
    finalizeRun(run, { status: "dry_run" });
    process.exit(0);
  }

  // ── Harvest: Reminders → raw idea files ──────────────────────────────
  for (const item of runPlan.harvest) {
    await harvest(item, run);
  }

  // ── L4 + L5: Brainstorm + Critic, per idea ───────────────────────────
  let passed = 0;
  let escalated = 0;

  for (const item of runPlan.brainstorm) {
    const slug = item.slug;
    log.info(`Brainstorming: ${slug}`);

    let brainstormResult;
    try {
      brainstormResult = await brainstorm(item, run);
    } catch (err) {
      log.error(`  Brainstorm failed for ${slug}:`, err);
      writeRunArtifact(run, `brainstorm-${slug}.error.json`, {
        slug,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      recordMetric("brainstorm.error", 1);
      continue;
    }
    writeRunArtifact(run, `brainstorm-${slug}.json`, brainstormArtifact(brainstormResult));
    recordMetric("brainstorm.tokens", brainstormResult.tokensUsed);

    if (!brainstormResult.output.trim()) {
      // The brainstormer ran but produced no body (e.g., the model replied
      // with only context_request blocks across every iteration). Skip the
      // critic, leave the idea `raw`, retry next run.
      log.warn(`  Empty brainstorm output for ${slug} — leaving raw, will retry.`);
      recordMetric("brainstorm.empty_output", 1);
      continue;
    }

    const criticResult = await critique({
      brainstorm: brainstormResult.output,
      rawIdea: brainstormResult.rawIdea,
      run,
    });
    writeRunArtifact(run, `critic-${slug}.json`, criticResult);
    recordMetric("critic.tokens", criticResult.tokensUsed);

    if (criticResult.verdict === "pass") {
      try {
        await brainstormResult.commit();
        passed++;
        recordMetric("brainstorm.pass", 1);
      } catch (err) {
        log.error(`  Commit refused for ${slug}:`, err);
        recordMetric("brainstorm.commit_refused", 1);
      }
    } else if (criticResult.verdict === "revise") {
      log.info(`  Critic requested revision: ${criticResult.feedback}`);
      const revised = await brainstorm(item, run, { feedback: criticResult.feedback });
      writeRunArtifact(run, `brainstorm-${slug}-r2.json`, brainstormArtifact(revised));
      recordMetric("brainstorm.tokens", revised.tokensUsed);

      if (!revised.output.trim()) {
        log.warn(`  Empty revision output for ${slug} — leaving raw, will retry.`);
        recordMetric("brainstorm.empty_output", 1);
        continue;
      }

      const reCheck = await critique({
        brainstorm: revised.output,
        rawIdea: revised.rawIdea,
        run,
      });
      writeRunArtifact(run, `critic-${slug}-r2.json`, reCheck);
      recordMetric("critic.tokens", reCheck.tokensUsed);

      try {
        if (reCheck.verdict === "pass") {
          await revised.commit();
          passed++;
          recordMetric("brainstorm.pass_after_revision", 1);
        } else {
          await revised.commitAsNeedsCriticReview(reCheck.feedback);
          escalated++;
          recordMetric("brainstorm.escalated", 1);
        }
      } catch (err) {
        log.error(`  Commit refused for ${slug}:`, err);
        recordMetric("brainstorm.commit_refused", 1);
      }
    } else {
      try {
        await brainstormResult.commitAsNeedsCriticReview(criticResult.feedback);
        escalated++;
        recordMetric("brainstorm.escalated", 1);
      } catch (err) {
        log.error(`  Commit refused for ${slug}:`, err);
        recordMetric("brainstorm.commit_refused", 1);
      }
    }
  }

  // ── Run summary ──────────────────────────────────────────────────────
  finalizeRun(run, {
    status: "complete",
    harvested: runPlan.harvest.length,
    brainstormed: passed,
    escalated,
    skipped: runPlan.skip.length,
  });

  log.info(`\n✓ Run complete.`);
  log.info(`  Harvested: ${runPlan.harvest.length}`);
  log.info(`  Brainstormed: ${passed}`);
  if (escalated > 0) log.info(`  Escalated to needs-critic-review: ${escalated}`);

  if (passed > 0) {
    log.info(`\nOpen Claude and ask: "What ideas are waiting for me?"`);
  }
}

main().catch((err) => {
  log.error("Run failed:", err);
  process.exit(1);
});
