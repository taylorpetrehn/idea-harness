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
import { checkBrainstormSchema } from "./lib/schema";
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

type Outcome = "passed" | "escalated" | "skipped";

/**
 * Validate one brainstorm. Allows up to one revision pass total — schema
 * fail or critic-revise both consume it. Commits on success, escalates on
 * persistent failure, or returns "skipped" when the brainstormer produced
 * empty output (the idea stays raw for the next run).
 *
 * Why structured this way:
 *   - schema check is deterministic and free → run first, save critic tokens
 *   - LLM critic only checks qualitative criteria once schema is sound
 *   - feedback is concatenated when both layers fail so the brainstormer
 *     fixes everything in one revision rather than ping-ponging
 */
async function validateAndCommit(args: {
  item: import("./agents/initializer").BrainstormItem;
  run: import("./lib/runs").Run;
  brainstormResult: BrainstormResult;
}): Promise<Outcome> {
  const { item, run } = args;
  const slug = item.slug;
  let current = args.brainstormResult;
  let revisionUsed = false;

  while (true) {
    const phase = revisionUsed ? "r2" : "r1";

    const schema = checkBrainstormSchema(current.output);
    writeRunArtifact(run, `schema-${slug}-${phase}.json`, schema);

    let critic: Awaited<ReturnType<typeof critique>> | null = null;
    if (schema.ok) {
      critic = await critique({
        brainstorm: current.output,
        rawIdea: current.rawIdea,
        run,
      });
      writeRunArtifact(run, `critic-${slug}-${phase}.json`, critic);
      recordMetric("critic.tokens", critic.tokensUsed);
    } else {
      log.warn(`  Schema check failed for ${slug}: ${schema.failures.length} issue(s).`);
      recordMetric("schema.fail", 1);
    }

    const passed = schema.ok && critic?.verdict === "pass";
    if (passed) {
      try {
        await current.commit();
        recordMetric(revisionUsed ? "brainstorm.pass_after_revision" : "brainstorm.pass", 1);
        return "passed";
      } catch (err) {
        log.error(`  Commit refused for ${slug}:`, err);
        recordMetric("brainstorm.commit_refused", 1);
        return "skipped";
      }
    }

    // Compose feedback: whichever layer failed contributes.
    const feedback = [
      schema.ok ? "" : schema.feedback,
      critic && critic.verdict !== "pass" ? `Critic: ${critic.feedback}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (revisionUsed) {
      // Out of revisions — escalate with whatever feedback we have.
      try {
        await current.commitAsNeedsCriticReview(feedback);
        recordMetric("brainstorm.escalated", 1);
        return "escalated";
      } catch (err) {
        log.error(`  Commit refused for ${slug}:`, err);
        recordMetric("brainstorm.commit_refused", 1);
        return "skipped";
      }
    }

    log.info(`  Revising ${slug} with concatenated schema+critic feedback.`);
    const revised = await brainstorm(item, run, { feedback });
    writeRunArtifact(run, `brainstorm-${slug}-r2.json`, brainstormArtifact(revised));
    recordMetric("brainstorm.tokens", revised.tokensUsed);

    if (!revised.output.trim()) {
      log.warn(`  Empty revision output for ${slug} — leaving raw, will retry.`);
      recordMetric("brainstorm.empty_output", 1);
      return "skipped";
    }
    current = revised;
    revisionUsed = true;
  }
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

    // Validate (schema then critic), allow up to one revision, commit or escalate.
    const outcome = await validateAndCommit({ item, run, brainstormResult });
    if (outcome === "passed") passed++;
    else if (outcome === "escalated") escalated++;
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
