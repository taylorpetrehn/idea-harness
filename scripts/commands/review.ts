/**
 * scripts/commands/review.ts
 *
 * Conversational review verbs. These are what the `idea-to-pr` skill
 * (or a human) calls during the "what should I look at?" loop.
 *
 *   harness review next            — JSON envelope for the next idea
 *   harness review in-flight       — accepted | building | pr-open buckets
 *   harness review accept <slug>   — mark accepted, reset loop, optional --variant + --note
 *   harness review reject <slug>
 *   harness review thought <slug>  — needs-more-thought, ++loop_count
 *   harness review set <slug> <status> — escape hatch, advanced
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb, IdeaStatusSchema, IdeaSummarySchema } from "../lib/contracts";
import {
  listIdeas,
  setStatus,
  incrementLoopCount,
  IdeaStatus,
} from "../lib/ideas";
import { resetLoopCount, bumpLoopCount } from "../lib/loops";
import { recordMetric } from "../lib/metrics";

const VALID_STATUSES: IdeaStatus[] = [
  "raw",
  "brainstormed",
  "needs-critic-review",
  "accepted",
  "rejected",
  "needs-more-thought",
  "building",
  "pr-open",
  "shipped",
];

// ── review next ─────────────────────────────────────────────────────

export interface ReviewNextArgs {}

const ReviewNextData = z.object({
  has_waiting: z.boolean(),
  total_waiting: z.number(),
  next: IdeaSummarySchema.nullable(),
});

registerVerb({
  verb: "review.next",
  description: "JSON envelope for the next idea Taylor should review.",
  data: ReviewNextData,
});

export async function runNext(_args: ReviewNextArgs, out: Output): Promise<void> {
  const waiting = [...listIdeas("brainstormed"), ...listIdeas("needs-critic-review")];

  if (waiting.length === 0) {
    out.info("No ideas waiting.");
    out.result({ has_waiting: false, total_waiting: 0, next: null });
    return;
  }

  const next = waiting[0];
  if (out.mode === "pretty") {
    out.stdout(`${next.slug}\n  ${next.title}\n`);
    if (next.recommended_action) {
      out.stdout(`  → ${next.recommended_action} (${next.confidence ?? "?"})\n`);
    }
    if (next.if_accepted_build) {
      out.stdout(`  build: ${next.if_accepted_build}\n`);
    }
    out.stdout(`  (${waiting.length} waiting)\n`);
  }

  out.result(
    { has_waiting: true, total_waiting: waiting.length, next },
    "Decide: `harness review accept|reject|thought <slug>`"
  );
}

// ── review in-flight ────────────────────────────────────────────────

export interface ReviewInFlightArgs {}

const ReviewInFlightData = z.object({
  accepted: z.array(IdeaSummarySchema),
  building: z.array(IdeaSummarySchema),
  pr_open: z.array(IdeaSummarySchema),
  totals: z.object({ accepted: z.number(), building: z.number(), pr_open: z.number() }),
});

registerVerb({
  verb: "review.in-flight",
  description: "Bucket in-flight ideas by status (accepted | building | pr-open).",
  data: ReviewInFlightData,
});

export async function runInFlight(_args: ReviewInFlightArgs, out: Output): Promise<void> {
  const accepted = listIdeas("accepted");
  const building = listIdeas("building");
  const prOpen = listIdeas("pr-open");

  if (out.mode === "pretty") {
    if (accepted.length + building.length + prOpen.length === 0) {
      out.stdout("Nothing in flight.\n");
    } else {
      if (accepted.length) {
        out.stdout(`\nAccepted, awaiting build (${accepted.length}):\n`);
        for (const i of accepted) out.stdout(`  ${i.slug}  →  ${i.title}\n`);
      }
      if (building.length) {
        out.stdout(`\nBuilding (${building.length}):\n`);
        for (const i of building) out.stdout(`  ${i.slug}  →  ${i.title}\n`);
      }
      if (prOpen.length) {
        out.stdout(`\nPRs open (${prOpen.length}):\n`);
        for (const i of prOpen) out.stdout(`  ${i.slug}  →  ${i.github_pr || "(no url)"}\n`);
      }
    }
  }

  out.result({
    accepted,
    building,
    pr_open: prOpen,
    totals: { accepted: accepted.length, building: building.length, pr_open: prOpen.length },
  });
}

// ── review accept / reject / thought / set ──────────────────────────

export interface ReviewMutateArgs {
  slug: string;
  note?: string;
  /** accept-only: variant choice, appended as a dated note. */
  variant?: string;
}

const ReviewMutateData = z.object({
  slug: z.string(),
  status: IdeaStatusSchema,
  loop_count: z.number().optional(),
  note_appended: z.string().optional(),
});

for (const verb of ["accept", "reject", "thought"] as const) {
  registerVerb({
    verb: `review.${verb}`,
    description: `Mark an idea as ${verb === "thought" ? "needs-more-thought" : verb + "ed"}.`,
    data: ReviewMutateData,
  });
}

function composeNote(args: ReviewMutateArgs, prefix: string | null): string | undefined {
  const parts = [prefix, args.note].filter(Boolean) as string[];
  return parts.length ? parts.join(" — ") : undefined;
}

export async function runAccept(args: ReviewMutateArgs, out: Output): Promise<void> {
  const variantNote = args.variant ? `Taylor accepted ${args.variant}` : null;
  const note = composeNote(args, variantNote);

  try {
    setStatus(args.slug, "accepted", note);
    resetLoopCount(args.slug);
    recordMetric("decision.accept", 1);
  } catch (err) {
    out.error("NOT_FOUND", (err as Error).message, {
      hint: "Run `harness ideas list` to find the slug.",
    });
    return;
  }

  if (out.mode === "pretty") {
    out.stdout(`✓ ${args.slug} → accepted\n`);
  }
  out.result(
    { slug: args.slug, status: "accepted" as IdeaStatus, note_appended: note },
    "Next: `harness ship` to graduate it."
  );
}

export async function runReject(args: ReviewMutateArgs, out: Output): Promise<void> {
  try {
    setStatus(args.slug, "rejected", args.note);
    resetLoopCount(args.slug);
    recordMetric("decision.reject", 1);
  } catch (err) {
    out.error("NOT_FOUND", (err as Error).message);
    return;
  }
  if (out.mode === "pretty") out.stdout(`✓ ${args.slug} → rejected\n`);
  out.result({ slug: args.slug, status: "rejected" as IdeaStatus, note_appended: args.note });
}

export async function runThought(args: ReviewMutateArgs, out: Output): Promise<void> {
  try {
    setStatus(args.slug, "needs-more-thought", args.note);
    const count = incrementLoopCount(args.slug);
    bumpLoopCount(args.slug);
    recordMetric("decision.needs_more_thought", 1);

    if (out.mode === "pretty") {
      out.stdout(`✓ ${args.slug} → needs-more-thought (loop_count: ${count})\n`);
    }
    if (count >= 3) {
      out.warn(`This idea has bounced ${count} times. Consider rejecting or rephrasing.`);
    }

    out.result({
      slug: args.slug,
      status: "needs-more-thought" as IdeaStatus,
      loop_count: count,
      note_appended: args.note,
    });
  } catch (err) {
    out.error("NOT_FOUND", (err as Error).message);
  }
}

export interface ReviewSetArgs {
  slug: string;
  status: string;
  note?: string;
}

registerVerb({
  verb: "review.set",
  description: "Set arbitrary status on an idea (escape hatch).",
  data: ReviewMutateData,
});

export async function runSet(args: ReviewSetArgs, out: Output): Promise<void> {
  if (!VALID_STATUSES.includes(args.status as IdeaStatus)) {
    out.error("BAD_INPUT", `Invalid status "${args.status}".`, {
      hint: `Valid: ${VALID_STATUSES.join(", ")}`,
    });
    return;
  }
  try {
    setStatus(args.slug, args.status as IdeaStatus, args.note);
    recordMetric(`decision.${args.status.replace(/-/g, "_")}`, 1);
  } catch (err) {
    out.error("NOT_FOUND", (err as Error).message);
    return;
  }
  if (out.mode === "pretty") out.stdout(`✓ ${args.slug} → ${args.status}\n`);
  out.result({
    slug: args.slug,
    status: args.status as IdeaStatus,
    note_appended: args.note,
  });
}
