/**
 * scripts/commands/digest.ts
 *
 * `harness digest [--date YYYY-MM-DD]` — Phase 4.
 *
 * Reads the journal and writes a one-page summary to
 * `runs/digest-<date>.md` covering what got captured / brainstormed /
 * accepted / rejected / shipped / auto-flowed / sharpened / merged
 * during that calendar day (UTC). Idempotent: re-running overwrites
 * the file.
 *
 * No external integrations — just journal in, markdown out. A cron
 * job can wrap this for scheduled delivery.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { readJournal, JournalEntry } from "../lib/journal";
import { listIdeas, IdeaSummary } from "../lib/ideas";
import { atomicWriteFileSync } from "../lib/atomic";

const RUNS_DIR = path.join(__dirname, "..", "..", "runs");

export interface DigestArgs {
  date?: string;
  /** Override output dir; primarily for tests. */
  outDir?: string;
  /** Skip writing; return the rendered markdown only. */
  dryRender?: boolean;
}

const DigestData = z.object({
  date: z.string(),
  outFile: z.string().nullable(),
  totals: z.object({
    captured: z.number(),
    brainstormed: z.number(),
    accepted: z.number(),
    rejected: z.number(),
    auto_flowed: z.number(),
    sharpened: z.number(),
    pr_open: z.number(),
    merged: z.number(),
    shipped: z.number(),
  }),
  markdown: z.string(),
});

registerVerb({
  verb: "digest",
  description: "Generate runs/digest-<date>.md from the journal for the chosen UTC day.",
  data: DigestData,
});

export async function runDigest(args: DigestArgs, out: Output): Promise<void> {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    out.error("BAD_INPUT", `Bad date "${date}".`, {
      hint: "Format: YYYY-MM-DD (UTC).",
    });
    return;
  }

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  // ReadJournal already filters by `since`; we further trim the upper
  // bound by hand because there's no `until` parameter.
  const all = readJournal({ since: dayStart });
  const dayEntries = all.filter((e) => new Date(e.ts) <= dayEnd);
  const ideas = listIdeas();
  const ideaBySlug = new Map(ideas.map((i) => [i.slug, i]));

  const totals = countByKind(dayEntries);
  const md = renderDigest(date, dayEntries, ideaBySlug, totals);

  let outFile: string | null = null;
  if (!args.dryRender) {
    const dir = args.outDir ?? RUNS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    outFile = path.join(dir, `digest-${date}.md`);
    atomicWriteFileSync(outFile, md);
  }

  if (out.mode === "pretty") {
    out.stdout(`Digest for ${date} → ${outFile ?? "(dry render)"}\n`);
    out.stdout(
      `  captured ${totals.captured} · brainstormed ${totals.brainstormed} · ` +
        `accepted ${totals.accepted} (auto ${totals.auto_flowed}) · ` +
        `rejected ${totals.rejected} · pr-open ${totals.pr_open} · merged ${totals.merged}\n`
    );
  }

  out.result({ date, outFile, totals, markdown: md });
}

// ── render ────────────────────────────────────────────────────────

interface DigestTotals {
  captured: number;
  brainstormed: number;
  accepted: number;
  rejected: number;
  auto_flowed: number;
  sharpened: number;
  pr_open: number;
  merged: number;
  shipped: number;
}

function countByKind(entries: JournalEntry[]): DigestTotals {
  const t: DigestTotals = {
    captured: 0,
    brainstormed: 0,
    accepted: 0,
    rejected: 0,
    auto_flowed: 0,
    sharpened: 0,
    pr_open: 0,
    merged: 0,
    shipped: 0,
  };
  for (const e of entries) {
    if (e.type === "idea.captured") t.captured += 1;
    else if (e.type === "idea.auto_flowed") t.auto_flowed += 1;
    else if (e.type === "idea.sharpened") t.sharpened += 1;
    else if (e.type === "idea.pr_merged") t.merged += 1;
    else if (e.type === "idea.status") {
      const to = e.data?.to;
      if (to === "brainstormed") t.brainstormed += 1;
      else if (to === "accepted") t.accepted += 1;
      else if (to === "rejected") t.rejected += 1;
      else if (to === "pr-open") t.pr_open += 1;
      else if (to === "merged") t.merged += 1;
      else if (to === "shipped") t.shipped += 1;
    }
  }
  return t;
}

function renderDigest(
  date: string,
  entries: JournalEntry[],
  ideaBySlug: Map<string, IdeaSummary>,
  totals: DigestTotals
): string {
  const sections: string[] = [
    `# Idea harness digest — ${date}`,
    "",
    `**Totals:** captured ${totals.captured} · brainstormed ${totals.brainstormed} · ` +
      `accepted ${totals.accepted} (auto-flowed ${totals.auto_flowed}) · ` +
      `rejected ${totals.rejected} · sharpened ${totals.sharpened} · ` +
      `pr-open ${totals.pr_open} · merged ${totals.merged} · shipped ${totals.shipped}`,
    "",
  ];

  const captured = entries.filter((e) => e.type === "idea.captured");
  if (captured.length) {
    sections.push("## Captured");
    sections.push("");
    for (const e of captured) {
      const idea = e.slug ? ideaBySlug.get(e.slug) : undefined;
      const title = idea?.title ?? (typeof e.data?.title === "string" ? e.data.title : e.slug ?? "—");
      sections.push(`- ${e.slug ?? "—"} — ${title}`);
    }
    sections.push("");
  }

  const decisions = entries.filter(
    (e) => e.type === "idea.status" &&
      ["accepted", "rejected", "pr-open", "merged", "shipped"].includes(String(e.data?.to))
  );
  if (decisions.length) {
    sections.push("## Decisions & milestones");
    sections.push("");
    for (const e of decisions) {
      const idea = e.slug ? ideaBySlug.get(e.slug) : undefined;
      sections.push(
        `- ${e.slug ?? "—"} ${e.data?.from ?? "?"} → **${e.data?.to ?? "?"}**` +
          (idea?.title ? `  · ${idea.title}` : "")
      );
    }
    sections.push("");
  }

  const auto = entries.filter((e) => e.type === "idea.auto_flowed");
  if (auto.length) {
    sections.push("## Auto-flowed (engine decisions)");
    sections.push("");
    for (const e of auto) {
      sections.push(
        `- ${e.slug ?? "—"} → **${e.data?.to ?? "?"}** ` +
          `(verdict: ${e.data?.verdict ?? "?"}, confidence: ${e.data?.confidence ?? "?"})`
      );
    }
    sections.push("");
  }

  const sharpened = entries.filter((e) => e.type === "idea.sharpened");
  if (sharpened.length) {
    sections.push("## Open questions raised");
    sections.push("");
    for (const e of sharpened) {
      sections.push(`- ${e.slug ?? "—"}: ${truncate(String(e.data?.question ?? ""), 120)}`);
    }
    sections.push("");
  }

  if (entries.length === 0) {
    sections.push("_No journal activity in this window._");
    sections.push("");
  }

  return sections.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
