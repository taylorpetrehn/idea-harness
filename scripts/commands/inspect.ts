/**
 * scripts/commands/inspect.ts
 *
 * `harness inspect` — show recent runs, idea counts, rolling metrics,
 * loop counters, and configured projects. Read-only.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { listIdeas } from "../lib/ideas";
import { readMetrics } from "../lib/metrics";
import { getLoopState } from "../lib/loops";
import { loadProjects } from "../lib/projects";

const RUNS_DIR = path.join(__dirname, "..", "..", "runs");

export interface InspectArgs {
  runs?: number;
  metric?: string;
}

const InspectData = z.object({
  runs: z.array(
    z.object({
      run_id: z.string(),
      summary: z.unknown().nullable(),
      plan: z.unknown().nullable(),
    })
  ),
  metrics: z.object({
    counters: z.record(z.number()),
  }),
  ideas: z.object({
    total: z.number(),
    by_status: z.record(z.number()),
  }),
  loops: z.record(z.number()),
  projects: z.array(
    z.object({
      key: z.string(),
      github_repo: z.string(),
      keywords: z.number(),
    })
  ),
});

registerVerb({
  verb: "inspect",
  description: "Show recent runs, idea counts, metrics, and project routing.",
  data: InspectData,
});

function listRunDirs(): string[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((name) => {
      const full = path.join(RUNS_DIR, name);
      return fs.statSync(full).isDirectory();
    })
    .sort()
    .reverse();
}

function readJsonIfExists(filepath: string): unknown {
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return null;
  }
}

function collectRuns(n: number) {
  return listRunDirs()
    .slice(0, n)
    .map((id) => ({
      run_id: id,
      summary: readJsonIfExists(path.join(RUNS_DIR, id, "summary.json")),
      plan: readJsonIfExists(path.join(RUNS_DIR, id, "plan.json")),
    }));
}

export async function run(args: InspectArgs, out: Output): Promise<void> {
  const runs = collectRuns(args.runs ?? 5);
  const metricsRaw = readMetrics();
  const counters = args.metric
    ? Object.fromEntries(
        Object.entries(metricsRaw.counters).filter(([k]) => k.includes(args.metric!))
      )
    : metricsRaw.counters;
  const all = listIdeas();
  const byStatus: Record<string, number> = {};
  for (const i of all) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  const loops = getLoopState();
  const projects = loadProjects().map((p) => ({
    key: p.key,
    github_repo: p.github_repo,
    keywords: p.keywords.length,
  }));

  if (out.mode === "pretty") {
    if (runs.length === 0) {
      out.stdout("No runs yet. Run `harness brainstorm` to start.\n");
    } else {
      for (const r of runs) {
        out.stdout(`Run ${r.run_id}\n`);
        const s = r.summary as any;
        if (s) {
          out.stdout(`  status: ${s.status}\n`);
          if (typeof s.harvested === "number") {
            out.stdout(`  harvested: ${s.harvested}\n`);
            out.stdout(`  brainstormed: ${s.brainstormed ?? 0}\n`);
            out.stdout(`  escalated: ${s.escalated ?? 0}\n`);
            out.stdout(`  skipped: ${s.skipped ?? 0}\n`);
          }
          if (typeof s.duration_ms === "number") {
            out.stdout(`  duration: ${(s.duration_ms / 1000).toFixed(1)}s\n`);
          }
        } else {
          out.stdout(`  (no summary — run did not complete)\n`);
        }
        out.stdout("\n");
      }
    }

    out.stdout(`Ideas: ${all.length}\n`);
    for (const [status, count] of Object.entries(byStatus)) {
      out.stdout(`  ${status}: ${count}\n`);
    }
    out.stdout("\n");

    if (Object.keys(counters).length) {
      out.stdout("Rolling metrics:\n");
      for (const [k, v] of Object.entries(counters).sort()) {
        out.stdout(`  ${k}: ${v}\n`);
      }
      out.stdout("\n");
    }

    if (Object.keys(loops).length) {
      out.stdout("Loop counters:\n");
      for (const [slug, count] of Object.entries(loops)) {
        const tag = count >= 3 ? "  ⚠ surfaced for decision" : "";
        out.stdout(`  ${slug}: ${count}${tag}\n`);
      }
      out.stdout("\n");
    }

    if (projects.length) {
      out.stdout(`Project routing (${projects.length}):\n`);
      for (const p of projects) {
        out.stdout(`  ${p.key} → ${p.github_repo} (${p.keywords} keywords)\n`);
      }
    }
  }

  out.result({
    runs,
    metrics: { counters },
    ideas: { total: all.length, by_status: byStatus },
    loops,
    projects,
  });
}
