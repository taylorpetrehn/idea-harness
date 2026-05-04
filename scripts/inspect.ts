#!/usr/bin/env ts-node
/**
 * scripts/inspect.ts
 *
 * Show the latest run's outcome and rolling metrics. Read-only — never
 * mutates state. Used by Taylor (and Claude during conversational review)
 * to answer "what did the last harness run actually do?".
 *
 * Usage:
 *   npm run inspect              # latest run summary + rolling metrics
 *   npm run inspect -- --json    # JSON output for piping
 *   npm run inspect -- --runs=5  # show last N runs
 */

import * as fs from "fs";
import * as path from "path";
import { listIdeas } from "./lib/ideas";
import { readMetrics } from "./lib/metrics";
import { getLoopState } from "./lib/loops";
import { loadProjects } from "./lib/projects";

const RUNS_DIR = path.join(__dirname, "..", "runs");

interface Flags {
  json: boolean;
  runs: number;
}

function parseFlags(argv: string[]): Flags {
  const json = argv.includes("--json");
  const runsArg = argv.find((a) => a.startsWith("--runs="));
  const runs = runsArg ? parseInt(runsArg.split("=")[1], 10) || 1 : 1;
  return { json, runs };
}

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

function readJsonIfExists(filepath: string): any | null {
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return null;
  }
}

interface RunSnapshot {
  run_id: string;
  summary: any | null;
  plan: any | null;
}

function collectRuns(n: number): RunSnapshot[] {
  return listRunDirs()
    .slice(0, n)
    .map((id) => ({
      run_id: id,
      summary: readJsonIfExists(path.join(RUNS_DIR, id, "summary.json")),
      plan: readJsonIfExists(path.join(RUNS_DIR, id, "plan.json")),
    }));
}

function ideaCounts() {
  const all = listIdeas();
  const byStatus: Record<string, number> = {};
  for (const i of all) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  }
  return { total: all.length, byStatus };
}

function emitJson(): void {
  const flags = parseFlags(process.argv.slice(2));
  const data = {
    runs: collectRuns(flags.runs),
    metrics: readMetrics(),
    ideas: ideaCounts(),
    loops: getLoopState(),
  };
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function emitHuman(): void {
  const flags = parseFlags(process.argv.slice(2));
  const runs = collectRuns(flags.runs);
  const metrics = readMetrics();
  const ideas = ideaCounts();
  const loops = getLoopState();

  if (runs.length === 0) {
    console.log("No runs yet. Run `npm run garden` to start.");
  } else {
    for (const r of runs) {
      console.log(`Run ${r.run_id}`);
      if (r.summary) {
        console.log(`  status: ${r.summary.status}`);
        if (typeof r.summary.harvested === "number") {
          console.log(`  harvested: ${r.summary.harvested}`);
          console.log(`  brainstormed: ${r.summary.brainstormed ?? 0}`);
          console.log(`  escalated: ${r.summary.escalated ?? 0}`);
          console.log(`  skipped: ${r.summary.skipped ?? 0}`);
        }
        if (r.summary.duration_ms !== undefined) {
          console.log(`  duration: ${(r.summary.duration_ms / 1000).toFixed(1)}s`);
        }
      } else if (r.plan) {
        console.log(`  (no summary — run did not complete)`);
        console.log(`  planned harvest: ${r.plan.harvest?.length ?? 0}`);
        console.log(`  planned brainstorm: ${r.plan.brainstorm?.length ?? 0}`);
      } else {
        console.log("  (no plan or summary written)");
      }
      console.log();
    }
  }

  console.log(`Ideas: ${ideas.total}`);
  for (const [status, count] of Object.entries(ideas.byStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log();

  const counterEntries = Object.entries(metrics.counters);
  if (counterEntries.length) {
    console.log("Rolling metrics:");
    for (const [k, v] of counterEntries.sort()) {
      console.log(`  ${k}: ${v}`);
    }
    console.log();
  }

  const loopSlugs = Object.entries(loops);
  if (loopSlugs.length) {
    console.log("Loop counters:");
    for (const [slug, count] of loopSlugs) {
      const tag = count >= 3 ? " ⚠ surfaced for decision" : "";
      console.log(`  ${slug}: ${count}${tag}`);
    }
    console.log();
  }

  const projects = loadProjects();
  if (projects.length) {
    console.log(`Project routing (${projects.length} configured):`);
    for (const p of projects) {
      console.log(`  ${p.key} → ${p.github_repo} (${p.keywords.length} keywords)`);
    }
  }
}

const flags = parseFlags(process.argv.slice(2));
if (flags.json) emitJson();
else emitHuman();
