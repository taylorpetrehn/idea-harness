/**
 * scripts/commands/cleanup.ts
 *
 * `harness cleanup` — remove worktrees the harness no longer needs.
 *
 * Default: dry-run. Pass --apply to actually remove. Targets shipped
 * ideas; --include-rejected adds rejected ideas; --orphans adds
 * worktrees git tracks that no idea references.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { listIdeas, IdeaSummary } from "../lib/ideas";
import { loadProjects, ProjectConfig } from "../lib/projects";
import { listIdeaWorktrees, removeWorktree } from "../lib/worktree";

export interface CleanupArgs {
  apply?: boolean;
  includeRejected?: boolean;
  orphans?: boolean;
}

const CleanupData = z.object({
  applied: z.boolean(),
  total_eligible: z.number(),
  total_removed: z.number(),
  per_project: z.array(
    z.object({
      project: z.string(),
      removals: z.array(
        z.object({
          path: z.string(),
          branch: z.string().nullable(),
          reason: z.string(),
          removed: z.boolean(),
          error: z.string().optional(),
        })
      ),
    })
  ),
});

registerVerb({
  verb: "cleanup",
  description: "Remove worktrees for shipped (and optionally rejected/orphan) ideas.",
  data: CleanupData,
});

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function computeBranchName(idea: IdeaSummary): string {
  const stem = idea.slug.replace(/-[a-f0-9]{4}$/, "").slice(0, 40).replace(/-+$/, "");
  const id4 = idea.id.slice(0, 4) || "0000";
  return `idea/${stem}-${id4}`;
}

interface PlannedRemoval {
  path: string;
  branch: string | null;
  reason: string;
}

async function planFor(
  project: ProjectConfig,
  args: CleanupArgs,
  ideas: IdeaSummary[],
  out: Output
): Promise<PlannedRemoval[]> {
  const repoPath = expandHome(project.local_path);
  if (!fs.existsSync(repoPath)) {
    out.warn(`Skipping ${project.key}: ${repoPath} does not exist.`);
    return [];
  }
  const worktrees = await listIdeaWorktrees(repoPath);
  const ideaByBranch = new Map<string, IdeaSummary>();
  for (const i of ideas) ideaByBranch.set(computeBranchName(i), i);

  const removals: PlannedRemoval[] = [];
  for (const wt of worktrees) {
    const idea = wt.branch ? ideaByBranch.get(wt.branch) : undefined;
    if (!idea) {
      if (args.orphans) {
        removals.push({ path: wt.path, branch: wt.branch, reason: "orphan" });
      }
      continue;
    }
    if (idea.status === "shipped") {
      removals.push({ path: wt.path, branch: wt.branch, reason: "shipped" });
    } else if (idea.status === "rejected" && args.includeRejected) {
      removals.push({ path: wt.path, branch: wt.branch, reason: "rejected" });
    }
  }
  return removals;
}

export async function run(args: CleanupArgs, out: Output): Promise<void> {
  const projects = loadProjects();
  const ideas = listIdeas();
  const apply = !!args.apply;

  type ProjectResult = z.infer<typeof CleanupData>["per_project"][number];
  let totalEligible = 0;
  let totalRemoved = 0;
  const perProject: ProjectResult[] = [];

  for (const project of projects) {
    const removals = await planFor(project, args, ideas, out);
    if (removals.length === 0) continue;

    const projectResult: ProjectResult = {
      project: project.key,
      removals: [],
    };

    if (out.mode === "pretty") {
      out.stdout(`\n${project.key} (${project.local_path}):\n`);
    }

    for (const r of removals) {
      totalEligible++;
      let removed = false;
      let error: string | undefined;

      if (out.mode === "pretty") {
        out.stdout(
          `  ${apply ? "REMOVING" : "would remove"}: ${r.path}  [${r.branch ?? "(detached)"}, ${r.reason}]\n`
        );
      }

      if (apply) {
        try {
          await removeWorktree(expandHome(project.local_path), r.path);
          removed = true;
          totalRemoved++;
        } catch (err) {
          error = (err as Error).message;
          out.warn(`Failed to remove ${r.path}: ${error}`);
        }
      }

      projectResult.removals.push({ ...r, removed, error });
    }

    perProject.push(projectResult);
  }

  if (out.mode === "pretty") {
    if (totalEligible === 0) {
      out.stdout("\nNothing to clean up.\n");
    } else if (!apply) {
      out.stdout(`\n${totalEligible} worktree(s) eligible. Re-run with --apply to remove.\n`);
    } else {
      out.stdout(`\n✓ Removed ${totalRemoved} of ${totalEligible} worktree(s).\n`);
    }
  }

  out.result(
    {
      applied: apply,
      total_eligible: totalEligible,
      total_removed: totalRemoved,
      per_project: perProject,
    },
    !apply && totalEligible > 0 ? "Re-run with --apply to remove." : undefined
  );
}
