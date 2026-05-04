/**
 * scripts/commands/ship.ts
 *
 * `harness ship` — "do the obvious next thing". Picks the newest
 * eligible idea (accepted | building | brainstormed-then-auto-accept)
 * and graduates or resumes it. The original `scripts/ship.ts` ported.
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb, IdeaStatusSchema, IdeaSummarySchema } from "../lib/contracts";
import { startRun, finalizeRun } from "../lib/runs";
import { listIdeas, setStatus, IdeaSummary } from "../lib/ideas";
import { resetLoopCount } from "../lib/loops";
import { recordMetric } from "../lib/metrics";
import { resolveIdeaShortSlug } from "../lib/slug";
import { graduateOne } from "../lib/graduator";

export interface ShipArgs {
  slug?: string;
  variant?: string;
  dry?: boolean;
  yes?: boolean;
}

const ShipData = z.object({
  picked: IdeaSummarySchema.nullable(),
  intent: z.enum(["build", "resume"]).nullable(),
  outcome: z.enum(["passed", "failed", "dry", "crashed", "skipped"]).nullable(),
  pr_url: z.string().nullable(),
  branch: z.string().nullable(),
  worktree_path: z.string().nullable(),
});

registerVerb({
  verb: "ship",
  description: "Pick the next eligible idea and graduate or resume it.",
  data: ShipData,
});

interface Pick {
  idea: IdeaSummary;
  intent: "build" | "resume";
  needsAutoAccept: boolean;
}

function classify(idea: IdeaSummary): Pick {
  if (idea.status === "building") {
    return { idea, intent: "resume", needsAutoAccept: false };
  }
  if (idea.status === "brainstormed") {
    return { idea, intent: "build", needsAutoAccept: true };
  }
  return { idea, intent: "build", needsAutoAccept: false };
}

function pickNext(args: ShipArgs): Pick | null {
  const sortNewest = (xs: IdeaSummary[]) =>
    [...xs].sort((a, b) => (b.captured_at || "").localeCompare(a.captured_at || ""));

  const accepted = sortNewest(listIdeas("accepted"));
  const building = sortNewest(listIdeas("building"));
  const brainstormed = sortNewest(listIdeas("brainstormed"));
  const all = [...accepted, ...building, ...brainstormed];

  if (args.slug) {
    const match = resolveIdeaShortSlug(args.slug, all);
    return match ? classify(match) : null;
  }
  if (accepted.length) return classify(accepted[0]);
  if (building.length) return classify(building[0]);
  if (brainstormed.length) return classify(brainstormed[0]);
  return null;
}

export async function run(args: ShipArgs, out: Output): Promise<void> {
  const pick = pickNext(args);
  if (!pick) {
    out.result(
      { picked: null, intent: null, outcome: null, pr_url: null, branch: null, worktree_path: null },
      args.slug
        ? `No idea matches "${args.slug}".`
        : "Nothing to ship — no accepted, building, or brainstormed ideas."
    );
    return;
  }

  const { idea, intent, needsAutoAccept } = pick;

  if (needsAutoAccept) {
    if (out.mode === "pretty") {
      out.stdout(`Next idea is brainstormed: ${idea.slug}\n  ${idea.title}\n`);
      if (idea.recommended_action) {
        out.stdout(`  → ${idea.recommended_action} (${idea.confidence ?? "?"})\n`);
      }
      if (idea.if_accepted_build) {
        out.stdout(`  build: ${idea.if_accepted_build}\n`);
      }
    }

    if (!args.yes && !args.dry && out.mode === "pretty") {
      // Interactive confirmation only makes sense in pretty mode. In
      // json/ndjson modes, skipping --yes is an error — agents should
      // pass --yes explicitly when they intend to auto-accept.
      const ok = await confirmTty(`Auto-accept ${idea.slug} and ship it?`);
      if (!ok) {
        out.error("BAD_INPUT", "Aborted by user.", {
          recoverable: true,
          hint: "Pass --yes to skip the prompt.",
        });
        return;
      }
    } else if (!args.yes && !args.dry) {
      out.error("BAD_INPUT", "Auto-accept requires --yes in non-interactive mode.", {
        recoverable: true,
        hint: "Re-run with --yes to confirm.",
      });
      return;
    }

    if (!args.dry) {
      setStatus(idea.slug, "accepted", "Auto-accepted by `harness ship`.");
      resetLoopCount(idea.slug);
      recordMetric("decision.accept", 1);
      idea.status = "accepted";
    }
  }

  out.info(`${intent === "resume" ? "Resuming" : "Shipping"} ${idea.slug}…`);

  const runRec = startRun({ trigger: "ship", flags: args });
  const outcome = await graduateOne(idea, runRec, {
    intent,
    variant: args.variant,
    dry: args.dry,
  });
  finalizeRun(runRec, { status: "complete", slug: idea.slug, intent, outcome });

  // Re-read the idea to surface the post-build PR URL if any.
  const after = listIdeas().find((i) => i.slug === idea.slug) ?? idea;

  if (outcome === "passed") {
    out.result(
      {
        picked: after,
        intent,
        outcome,
        pr_url: after.github_pr || null,
        branch: null,
        worktree_path: null,
      },
      after.github_pr ? `PR opened: ${after.github_pr}` : undefined
    );
    return;
  }

  if (outcome === "dry") {
    out.result(
      { picked: after, intent, outcome, pr_url: null, branch: null, worktree_path: null },
      "Dry run — prompt prepared, nothing spawned."
    );
    return;
  }

  out.error(
    outcome === "crashed" ? "BUILD_CRASHED" : "BUILD_FAILED",
    `${intent} did not reach PR for ${idea.slug}.`,
    {
      recoverable: true,
      hint: `Try: \`harness resume ${idea.slug}\``,
    }
  );
}

async function confirmTty(question: string): Promise<boolean> {
  // Lazy import — only used in pretty mode.
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
