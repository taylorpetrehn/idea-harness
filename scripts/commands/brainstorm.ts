/**
 * scripts/commands/brainstorm.ts
 *
 * `harness brainstorm` — the L2-L5 pipeline.
 *
 *   plan → harvest (reminders → raw) → brainstorm (per idea, fresh context)
 *        → schema check → critic → commit-or-escalate
 *
 * Ported from the prior `scripts/garden.ts`. Logic is identical; only
 * the I/O surface changed (Output instead of console, structured
 * envelope instead of stdout-printed text).
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { plan, RunPlan, BrainstormItem } from "../agents/initializer";
import { harvest } from "../agents/harvester";
import { brainstorm, BrainstormResult } from "../agents/brainstormer";
import { critique } from "../agents/critic";
import { checkBrainstormSchema } from "../lib/schema";
import { writeRunArtifact, finalizeRun, startRun, Run } from "../lib/runs";
import { recordMetric } from "../lib/metrics";
import { openRunEvents, RunEvents } from "../lib/events";
import { acquireLock, LockHeldError } from "../lib/lock";

export interface BrainstormArgs {
  idea?: string;
  dry?: boolean;
}

const BrainstormData = z.object({
  run_id: z.string(),
  status: z.string(),
  harvested: z.number(),
  brainstormed: z.number(),
  escalated: z.number(),
  skipped: z.number(),
  estimated_cost_usd: z.number(),
});

registerVerb({
  verb: "brainstorm",
  description: "Run the plan → harvest → brainstorm → schema → critic pipeline.",
  data: BrainstormData,
  events: {
    "plan.ready": z.object({
      harvest: z.number(),
      brainstorm: z.number(),
      skip: z.number(),
      estimated_cost_usd: z.number(),
    }),
    "harvest.start": z.object({ title: z.string() }),
    "brainstorm.start": z.object({ slug: z.string() }),
    "brainstorm.tokens": z.object({ slug: z.string(), tokens: z.number() }),
    "schema.fail": z.object({ slug: z.string(), failures: z.number() }),
    "critic.verdict": z.object({ slug: z.string(), verdict: z.string() }),
    "brainstorm.committed": z.object({ slug: z.string() }),
    "brainstorm.escalated": z.object({ slug: z.string() }),
  },
});

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

async function validateAndCommit(args: {
  item: BrainstormItem;
  run: Run;
  brainstormResult: BrainstormResult;
  out: Output;
  events: RunEvents;
}): Promise<Outcome> {
  const { item, run, out, events } = args;
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
      events.emit("critic.verdict", { slug, verdict: critic.verdict });
    } else {
      out.warn(`Schema check failed for ${slug}: ${schema.failures.length} issue(s).`);
      events.emit("schema.fail", { slug, failures: schema.failures.length });
      recordMetric("schema.fail", 1);
    }

    const passed = schema.ok && critic?.verdict === "pass";
    if (passed) {
      try {
        await current.commit();
        recordMetric(revisionUsed ? "brainstorm.pass_after_revision" : "brainstorm.pass", 1);
        events.emit("brainstorm.committed", { slug });
        return "passed";
      } catch (err) {
        out.warn(`Commit refused for ${slug}: ${(err as Error).message}`);
        recordMetric("brainstorm.commit_refused", 1);
        return "skipped";
      }
    }

    const feedback = [
      schema.ok ? "" : schema.feedback,
      critic && critic.verdict !== "pass" ? `Critic: ${critic.feedback}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (revisionUsed) {
      try {
        await current.commitAsNeedsCriticReview(feedback);
        recordMetric("brainstorm.escalated", 1);
        events.emit("brainstorm.escalated", { slug });
        return "escalated";
      } catch (err) {
        out.warn(`Commit refused for ${slug}: ${(err as Error).message}`);
        recordMetric("brainstorm.commit_refused", 1);
        return "skipped";
      }
    }

    out.info(`Revising ${slug} with concatenated schema+critic feedback.`);
    const revised = await brainstorm(item, run, { feedback });
    writeRunArtifact(run, `brainstorm-${slug}-r2.json`, brainstormArtifact(revised));
    recordMetric("brainstorm.tokens", revised.tokensUsed);
    events.emit("brainstorm.tokens", { slug, tokens: revised.tokensUsed });

    if (!revised.output.trim()) {
      out.warn(`Empty revision output for ${slug} — leaving raw, will retry.`);
      recordMetric("brainstorm.empty_output", 1);
      return "skipped";
    }
    current = revised;
    revisionUsed = true;
  }
}

export async function run(args: BrainstormArgs, out: Output): Promise<void> {
  let lock;
  try {
    lock = acquireLock("brainstorm");
  } catch (err) {
    if (err instanceof LockHeldError) {
      out.error("LOCK_HELD", err.message, {
        recoverable: true,
        hint: `Wait for the other run to finish, or remove ${err.message.split('"')[1] ? '' : ''}state/brainstorm.lock if it's stale.`,
      });
      return;
    }
    throw err;
  }

  const r = startRun({ trigger: "manual", flags: args });
  const events = openRunEvents(r, "brainstorm", out);

  try {
    return await runImpl(args, out, r, events);
  } finally {
    events.close();
    lock.release();
  }
}

async function runImpl(
  args: BrainstormArgs,
  out: Output,
  r: Run,
  events: RunEvents
): Promise<void> {
  out.info("Planning run…");
  const runPlan: RunPlan = await plan({ run: r, focusSlug: args.idea });
  writeRunArtifact(r, "plan.json", runPlan);

  events.emit("plan.ready", {
    harvest: runPlan.harvest.length,
    brainstorm: runPlan.brainstorm.length,
    skip: runPlan.skip.length,
    estimated_cost_usd: runPlan.estimated_cost_usd,
  });

  if (runPlan.harvest.length === 0 && runPlan.brainstorm.length === 0) {
    finalizeRun(r, { status: "empty" });
    out.result(
      {
        run_id: r.id,
        status: "empty",
        harvested: 0,
        brainstormed: 0,
        escalated: 0,
        skipped: 0,
        estimated_cost_usd: runPlan.estimated_cost_usd,
      },
      "Nothing to do. Capture more ideas first."
    );
    return;
  }

  out.info(
    `Plan: harvest ${runPlan.harvest.length}, brainstorm ${runPlan.brainstorm.length}, skip ${runPlan.skip.length}`
  );
  out.info(`Estimated cost: $${runPlan.estimated_cost_usd.toFixed(3)}`);

  if (args.dry) {
    finalizeRun(r, { status: "dry_run" });
    out.result(
      {
        run_id: r.id,
        status: "dry_run",
        harvested: 0,
        brainstormed: 0,
        escalated: 0,
        skipped: runPlan.skip.length,
        estimated_cost_usd: runPlan.estimated_cost_usd,
      },
      "Dry run — re-run without --dry to execute."
    );
    return;
  }

  for (const item of runPlan.harvest) {
    events.emit("harvest.start", { title: item.title });
    await harvest(item, r);
  }

  let passed = 0;
  let escalated = 0;
  for (const item of runPlan.brainstorm) {
    const slug = item.slug;
    out.info(`Brainstorming: ${slug}`);
    events.emit("brainstorm.start", { slug });

    let result: BrainstormResult;
    try {
      result = await brainstorm(item, r);
    } catch (err) {
      out.warn(`Brainstorm failed for ${slug}: ${(err as Error).message}`);
      writeRunArtifact(r, `brainstorm-${slug}.error.json`, {
        slug,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      recordMetric("brainstorm.error", 1);
      continue;
    }
    writeRunArtifact(r, `brainstorm-${slug}.json`, brainstormArtifact(result));
    recordMetric("brainstorm.tokens", result.tokensUsed);
    events.emit("brainstorm.tokens", { slug, tokens: result.tokensUsed });

    const outcome = await validateAndCommit({ item, run: r, brainstormResult: result, out, events });
    if (outcome === "passed") passed++;
    else if (outcome === "escalated") escalated++;
  }

  finalizeRun(r, {
    status: "complete",
    harvested: runPlan.harvest.length,
    brainstormed: passed,
    escalated,
    skipped: runPlan.skip.length,
  });

  out.result(
    {
      run_id: r.id,
      status: "complete",
      harvested: runPlan.harvest.length,
      brainstormed: passed,
      escalated,
      skipped: runPlan.skip.length,
      estimated_cost_usd: runPlan.estimated_cost_usd,
    },
    passed > 0 ? "Next: `harness review next` to triage the new brainstorms." : undefined
  );
}
