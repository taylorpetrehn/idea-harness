/**
 * scripts/lib/runs.ts
 *
 * Run lifecycle: create a run, write artifacts to it, finalize it.
 * Every harness run produces a runs/<timestamp>/ directory containing
 * everything needed to reproduce or audit what happened.
 */

import * as fs from "fs";
import * as path from "path";

const RUNS_DIR = path.join(__dirname, "..", "..", "runs");

export interface Run {
  id: string;            // ISO timestamp with colons replaced
  trigger: string;       // "manual" | "event" | "conversational"
  startedAt: string;
  dir: string;
}

export function startRun(opts: { trigger: string; flags?: object }): Run {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, "-");
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const run: Run = { id, trigger: opts.trigger, startedAt, dir };

  writeRunArtifact(run, "started.json", { ...run, flags: opts.flags ?? {} });
  return run;
}

export function writeRunArtifact(run: Run, name: string, data: any): void {
  const filepath = path.join(run.dir, name);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
}

export function finalizeRun(
  run: Run,
  summary: { status: string; [key: string]: any }
): void {
  const finishedAt = new Date().toISOString();
  const finalSummary = {
    ...summary,
    run_id: run.id,
    started_at: run.startedAt,
    finished_at: finishedAt,
    duration_ms: new Date(finishedAt).getTime() - new Date(run.startedAt).getTime(),
  };
  writeRunArtifact(run, "summary.json", finalSummary);

  // Update the latest pointer
  const latestPath = path.join(RUNS_DIR, "latest.json");
  fs.writeFileSync(latestPath, JSON.stringify(finalSummary, null, 2), "utf8");
}
