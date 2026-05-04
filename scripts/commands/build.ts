/**
 * scripts/commands/build.ts
 *
 * `harness build <slug>` — fresh build for an accepted idea (was: graduate)
 * `harness build resume <slug>` — recover an in-flight `building` idea
 * `harness build watch <slug>` — tail the live session log
 * `harness build status <slug>` — current state JSON
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb, IdeaSummarySchema } from "../lib/contracts";
import { startRun, finalizeRun } from "../lib/runs";
import { listIdeas, IdeaSummary } from "../lib/ideas";
import { resolveIdeaShortSlug } from "../lib/slug";
import { graduateOne, GraduateOutcome } from "../lib/graduator";

const RUNS_DIR = path.join(__dirname, "..", "..", "runs");

// ── shared ──────────────────────────────────────────────────────────

const BuildResultData = z.object({
  slug: z.string(),
  intent: z.enum(["build", "resume"]),
  outcome: z.enum(["passed", "failed", "dry", "crashed"]),
  pr_url: z.string().nullable(),
});

function findEligible(slug: string, statuses: ("accepted" | "building")[]): IdeaSummary | null {
  const pool: IdeaSummary[] = [];
  for (const s of statuses) pool.push(...listIdeas(s));
  return resolveIdeaShortSlug(slug, pool);
}

// ── build start ─────────────────────────────────────────────────────

export interface BuildStartArgs {
  slug: string;
  variant?: string;
  dry?: boolean;
}

registerVerb({
  verb: "build.start",
  description: "Spawn a fresh Claude Code build session for an accepted idea.",
  data: BuildResultData,
});

export async function runStart(args: BuildStartArgs, out: Output): Promise<void> {
  const idea = findEligible(args.slug, ["accepted", "building"]);
  if (!idea) {
    out.error("NOT_FOUND", `No accepted/building idea matches "${args.slug}".`, {
      hint: "Run `harness review in-flight` to see eligible slugs.",
    });
    return;
  }

  const runRec = startRun({ trigger: "build.start", flags: args });
  const outcome = await graduateOne(idea, runRec, {
    intent: "build",
    variant: args.variant,
    dry: args.dry,
  });
  finalizeRun(runRec, { status: "complete", slug: idea.slug, intent: "build", outcome });

  emitOutcome(out, idea.slug, "build", outcome);
}

// ── build resume ────────────────────────────────────────────────────

export interface BuildResumeArgs {
  slug?: string;
  variant?: string;
  dry?: boolean;
}

registerVerb({
  verb: "build.resume",
  description: "Land in-flight work on a `building` idea (commit/push/PR only).",
  data: BuildResultData,
});

export async function runResume(args: BuildResumeArgs, out: Output): Promise<void> {
  const building = [...listIdeas("building")].sort((a, b) =>
    (b.captured_at || "").localeCompare(a.captured_at || "")
  );

  let idea: IdeaSummary | null = null;
  if (args.slug) {
    idea = resolveIdeaShortSlug(args.slug, building);
  } else if (building.length === 1) {
    idea = building[0];
  } else if (building.length === 0) {
    out.result(
      { slug: "", intent: "resume" as const, outcome: "passed" as const, pr_url: null },
      "No `building` ideas to resume."
    );
    return;
  } else {
    out.error("AMBIGUOUS_SLUG", "Multiple building ideas — pass a slug.", {
      hint: building.map((i) => i.slug).join(", "),
    });
    return;
  }

  if (!idea) {
    out.error("NOT_FOUND", `No building idea matches "${args.slug}".`);
    return;
  }

  const runRec = startRun({ trigger: "build.resume", flags: args });
  const outcome = await graduateOne(idea, runRec, {
    intent: "resume",
    variant: args.variant,
    dry: args.dry,
  });
  finalizeRun(runRec, { status: "complete", slug: idea.slug, intent: "resume", outcome });

  emitOutcome(out, idea.slug, "resume", outcome);
}

// ── build status ────────────────────────────────────────────────────

export interface BuildStatusArgs {
  slug: string;
}

const BuildStatusData = z.object({
  idea: IdeaSummarySchema,
  latest_run_id: z.string().nullable(),
  latest_artifact: z.unknown().nullable(),
  log_path: z.string().nullable(),
});

registerVerb({
  verb: "build.status",
  description: "Read the most recent build state for an idea.",
  data: BuildStatusData,
});

export async function runStatus(args: BuildStatusArgs, out: Output): Promise<void> {
  const all = listIdeas();
  const idea = resolveIdeaShortSlug(args.slug, all);
  if (!idea) {
    out.error("NOT_FOUND", `No idea matches "${args.slug}".`);
    return;
  }

  const { runId, artifact, logPath } = findLatestBuildArtifact(idea.slug);
  if (out.mode === "pretty") {
    out.stdout(`${idea.slug}  [${idea.status}]\n`);
    if (idea.github_pr) out.stdout(`  PR: ${idea.github_pr}\n`);
    if (runId) out.stdout(`  latest run: ${runId}\n`);
    if (logPath) out.stdout(`  log: ${logPath}\n`);
  }

  out.result({
    idea,
    latest_run_id: runId,
    latest_artifact: artifact,
    log_path: logPath,
  });
}

// ── build watch ─────────────────────────────────────────────────────

export interface BuildWatchArgs {
  slug: string;
}

const BuildWatchData = z.object({
  slug: z.string(),
  log_path: z.string(),
  followed: z.boolean(),
});

registerVerb({
  verb: "build.watch",
  description: "Tail the live build log for an in-flight session.",
  data: BuildWatchData,
});

export async function runWatch(args: BuildWatchArgs, out: Output): Promise<void> {
  const all = listIdeas();
  const idea = resolveIdeaShortSlug(args.slug, all);
  if (!idea) {
    out.error("NOT_FOUND", `No idea matches "${args.slug}".`);
    return;
  }
  const { logPath } = findLatestBuildArtifact(idea.slug);
  if (!logPath || !fs.existsSync(logPath)) {
    out.error("NOT_FOUND", `No build log found for ${idea.slug}.`, {
      hint: "The build may not have started yet, or it ran in offline/dry mode.",
    });
    return;
  }

  if (out.mode === "pretty") {
    // Pretty mode: actively follow the file (`tail -f`-equivalent) until
    // the user interrupts. Agents should pass --json (which short-circuits
    // and just returns the path).
    await tailFile(logPath, (line) => out.stdout(line));
    out.result({ slug: idea.slug, log_path: logPath, followed: true });
    return;
  }

  out.result(
    { slug: idea.slug, log_path: logPath, followed: false },
    `Tail the log directly: \`tail -f ${logPath}\``
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function emitOutcome(
  out: Output,
  slug: string,
  intent: "build" | "resume",
  outcome: GraduateOutcome
): void {
  const after = listIdeas().find((i) => i.slug === slug);
  if (outcome === "passed") {
    out.result(
      { slug, intent, outcome, pr_url: after?.github_pr || null },
      after?.github_pr ? `PR opened: ${after.github_pr}` : undefined
    );
    return;
  }
  if (outcome === "dry") {
    out.result({ slug, intent, outcome, pr_url: null }, "Dry run — prompt prepared, nothing spawned.");
    return;
  }
  out.error(
    outcome === "crashed" ? "BUILD_CRASHED" : "BUILD_FAILED",
    `${intent} did not reach PR for ${slug}.`,
    { recoverable: true, hint: `Try: \`harness build resume ${slug}\`` }
  );
}

interface BuildArtifact {
  runId: string | null;
  artifact: unknown | null;
  logPath: string | null;
}

function findLatestBuildArtifact(slug: string): BuildArtifact {
  if (!fs.existsSync(RUNS_DIR)) return { runId: null, artifact: null, logPath: null };
  const runs = fs
    .readdirSync(RUNS_DIR)
    .filter((name) => fs.statSync(path.join(RUNS_DIR, name)).isDirectory())
    .sort()
    .reverse();
  for (const id of runs) {
    const dir = path.join(RUNS_DIR, id);
    const artPath = path.join(dir, `build-${slug}.json`);
    const logPath = path.join(dir, `build-${slug}.log`);
    if (fs.existsSync(artPath) || fs.existsSync(logPath)) {
      const artifact = fs.existsSync(artPath)
        ? safeParse(fs.readFileSync(artPath, "utf8"))
        : null;
      return {
        runId: id,
        artifact,
        logPath: fs.existsSync(logPath) ? logPath : null,
      };
    }
  }
  return { runId: null, artifact: null, logPath: null };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

async function tailFile(filepath: string, onLine: (chunk: string) => void): Promise<void> {
  // Simple polling tail. For phase-3 use it's fine — phase-4 introduces
  // real event streams via runs/<id>/events.ndjson.
  let position = 0;
  // First, dump existing contents so the user gets the full picture.
  const initial = fs.readFileSync(filepath, "utf8");
  onLine(initial);
  position = initial.length;

  return new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      resolve();
    };
    process.on("SIGINT", stop);

    const timer = setInterval(() => {
      try {
        const { size } = fs.statSync(filepath);
        if (size > position) {
          const fd = fs.openSync(filepath, "r");
          const buf = Buffer.alloc(size - position);
          fs.readSync(fd, buf, 0, size - position, position);
          fs.closeSync(fd);
          onLine(buf.toString("utf8"));
          position = size;
        } else if (size < position) {
          // file truncated/rotated
          position = 0;
        }
      } catch {
        // file disappeared — keep polling, it may come back
      }
    }, 500);
  });
}
