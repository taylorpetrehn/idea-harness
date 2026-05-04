/**
 * scripts/agents/initializer.ts
 *
 * L2: Control. The initializer is the first agent in the harness.
 * It does no creative work — it plans the run.
 *
 * Inputs:
 *   - Current state of ideas/ folder
 *   - Current state of Apple Reminders "App Ideas" list
 *   - Last run log (if any)
 *   - Loop detection state
 *
 * Outputs:
 *   A RunPlan written to runs/<timestamp>/plan.json
 *
 * Contract:
 *   - Empty plan → harness exits silently
 *   - Total token budget never exceeds run cap
 *   - Loop-detected ideas are surfaced, not auto-rebrewed
 */

import { listIdeas } from "../lib/ideas";
import { listReminders, Reminder } from "../lib/reminders";
import { fuzzyTitleMatch, slugify } from "../lib/text";
import { getLoopState } from "../lib/loops";
import { Run } from "../lib/runs";
import { resolveProject } from "../lib/projects";
import { BUDGETS } from "../lib/budgets";

export interface HarvestItem {
  reminder_id: string;
  title: string;
  notes: string;
  project: string | null;     // null = needs Taylor's resolution
  action: "create_raw";
}

export interface BrainstormItem {
  slug: string;
  context_tier: "minimal" | "extended";
  budget_tokens: number;
}

export interface SkipItem {
  slug: string;
  reason: string;
}

export interface RunPlan {
  run_id: string;
  trigger: string;
  harvest: HarvestItem[];
  brainstorm: BrainstormItem[];
  skip: SkipItem[];
  estimated_cost_usd: number;
  estimated_duration_seconds: number;
}

export async function plan(opts: { run: Run; focusSlug?: string }): Promise<RunPlan> {
  const { run, focusSlug } = opts;
  const existingIdeas = listIdeas();
  const reminders = await listReminders("App Ideas");
  const loops = getLoopState();

  // ── Plan harvests ────────────────────────────────────────────────────
  const harvest: HarvestItem[] = [];
  const existingTitles = new Set(existingIdeas.map((i) => i.title.toLowerCase()));

  for (const reminder of reminders) {
    if ([...existingTitles].some((t) => fuzzyTitleMatch(t, reminder.title))) continue;
    harvest.push({
      reminder_id: reminder.id,
      title: reminder.title,
      notes: reminder.notes ?? "",
      project: resolveProject(reminder.title, reminder.notes),
      action: "create_raw",
    });
  }

  // ── Plan brainstorms ─────────────────────────────────────────────────
  // Candidates: ideas that are `raw` AFTER harvest, plus any `needs-more-thought`
  // that should rebrew (loop_count < 3).
  // If a focusSlug is given, only that slug is brainstormed.
  const brainstorm: BrainstormItem[] = [];
  const skip: SkipItem[] = [];

  // Minimal shape — we only need slug, title, loop_count for planning.
  // The harvester will create the actual file; the brainstormer will read it.
  interface Candidate {
    slug: string;
    title: string;
    loop_count: number;
  }

  const candidates: Candidate[] = [
    // raw → never been brainstormed
    ...existingIdeas
      .filter((i) => i.status === "raw")
      .map((i) => ({ slug: i.slug, title: i.title, loop_count: i.loop_count })),
    // needs-more-thought → rebrew until loop_count >= 3 (cap enforced below)
    ...existingIdeas
      .filter((i) => i.status === "needs-more-thought")
      .map((i) => ({ slug: i.slug, title: i.title, loop_count: i.loop_count })),
    // newly-harvested reminders that just became raw files
    ...harvest.map((h) => ({
      slug: slugify(h.title),
      title: h.title,
      loop_count: 0,
    })),
  ];

  let usedTokens = 0;

  for (const candidate of candidates) {
    if (focusSlug && candidate.slug !== focusSlug) continue;

    // Loop state has two sources: state/loops.json (durable) and the idea
    // frontmatter (human-visible). Either hitting 3 surfaces the idea.
    const loopCount = Math.max(loops[candidate.slug] ?? 0, candidate.loop_count ?? 0);
    if (loopCount >= 3) {
      skip.push({
        slug: candidate.slug,
        reason: `bounced ${loopCount}x — awaiting decision, not auto-rebrewing`,
      });
      continue;
    }

    // Check budget
    const budget = BUDGETS.perIdeaTarget;
    if (usedTokens + budget > BUDGETS.perRunCap) {
      skip.push({
        slug: candidate.slug,
        reason: `run budget cap reached — picked up next run`,
      });
      continue;
    }

    brainstorm.push({
      slug: candidate.slug,
      context_tier: "minimal",
      budget_tokens: budget,
    });
    usedTokens += budget;
  }

  // ── Cost estimate ────────────────────────────────────────────────────
  // Brainstormer: ~$3/M input tokens. Critic: ~$0.30/M (smaller model).
  const brainstormCost = (usedTokens / 1_000_000) * 3.0;
  const criticCost = (brainstorm.length * BUDGETS.criticPerIdea / 1_000_000) * 0.3;
  const estimated_cost_usd = brainstormCost + criticCost;

  return {
    run_id: run.id,
    trigger: run.trigger,
    harvest,
    brainstorm,
    skip,
    estimated_cost_usd,
    estimated_duration_seconds: brainstorm.length * 30 + harvest.length * 2,
  };
}
