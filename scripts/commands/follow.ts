/**
 * scripts/commands/follow.ts
 *
 * `harness follow [<slug>]` — Phase 3 verb.
 *
 * One-shot pass through the PR watcher. Without a slug, follows
 * every idea in pr-open / ci-running / ci-failed /
 * review-changes-requested. With a slug, follows just that one.
 *
 * Behavior is gated by `IDEA_HARNESS_AUTO_FOLLOW=true`: when
 * unset, the verb runs in dry mode (reports state but never
 * spawns claude or merges). This matches the cross-cutting
 * default-off principle from the roadmap.
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { listIdeas } from "../lib/ideas";
import { followOne, shouldFollow, FollowResult } from "../agents/pr_watcher";

export interface FollowArgs {
  slug?: string;
}

const FollowResultSchema = z.object({
  slug: z.string(),
  outcome: z.enum([
    "merged",
    "ci-failed-spawned",
    "review-spawned",
    "ci-running",
    "no-pr",
    "noop",
  ]),
  detail: z.string().optional(),
});

const FollowData = z.object({
  followed: z.array(FollowResultSchema),
  skipped: z.number(),
  dry: z.boolean(),
});

registerVerb({
  verb: "follow",
  description: "Poll open PRs and react: address CI failures, review comments, merge when green.",
  data: FollowData,
});

export async function runFollow(args: FollowArgs, out: Output): Promise<void> {
  const dry = process.env.IDEA_HARNESS_AUTO_FOLLOW !== "true";

  const all = listIdeas();
  const targets = args.slug
    ? all.filter((i) => i.slug === args.slug || i.filename === args.slug)
    : all.filter((i) => shouldFollow(i));

  if (targets.length === 0) {
    if (out.mode === "pretty") out.stdout("Nothing to follow.\n");
    out.result({ followed: [], skipped: all.length, dry });
    return;
  }

  if (dry) {
    if (out.mode === "pretty") {
      out.stdout(
        "IDEA_HARNESS_AUTO_FOLLOW is unset — dry mode (no spawn, no merge).\n"
      );
    }
  }

  const followed: FollowResult[] = [];
  for (const idea of targets) {
    if (dry) {
      // In dry mode we still poll the PR for visibility, but the
      // pr_watcher itself doesn't know about a dry flag — so we just
      // skip the spawn-bearing followOne entirely and surface the
      // intent.
      followed.push({
        slug: idea.slug,
        outcome: "noop",
        prStatus: null,
        detail: `dry: would follow status=${idea.status}`,
      });
      continue;
    }
    try {
      const r = await followOne(idea.slug);
      followed.push(r);
      if (out.mode === "pretty") {
        out.stdout(`${r.slug}: ${r.outcome}${r.detail ? ` — ${truncate(r.detail, 80)}` : ""}\n`);
      }
    } catch (err) {
      out.warn(`follow ${idea.slug} failed: ${(err as Error).message}`);
    }
  }

  out.result(
    {
      followed: followed.map((r) => ({ slug: r.slug, outcome: r.outcome, detail: r.detail })),
      skipped: all.length - targets.length,
      dry,
    },
    dry
      ? "Set IDEA_HARNESS_AUTO_FOLLOW=true to actually act on PRs."
      : "Re-run anytime; outcomes journaled."
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
