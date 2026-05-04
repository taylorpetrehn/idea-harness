#!/usr/bin/env ts-node
/**
 * scripts/cleanup.ts
 *
 * Remove git worktrees that the harness no longer needs.
 *
 * Default: target the worktrees for ideas whose status is `shipped` (PR
 * merged) — there's nothing to recover. Pass `--include-rejected` to also
 * remove worktrees for `rejected` ideas.
 *
 * Usage:
 *   npm run cleanup                  # dry-run by default — prints what would be removed
 *   npm run cleanup -- --apply       # actually remove
 *   npm run cleanup -- --apply --include-rejected
 *   npm run cleanup -- --orphans     # also remove worktrees git tracks but no idea references
 *
 * Why opt-in apply? Because the worktree may contain unstaged edits the
 * user wanted (e.g. spent extra time refining a PR after merge). Print
 * first, remove on confirmation.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listIdeas, IdeaSummary } from "./lib/ideas";
import { loadProjects, ProjectConfig } from "./lib/projects";
import { listIdeaWorktrees, removeWorktree } from "./lib/worktree";
import { log } from "./lib/log";

interface Flags {
  apply: boolean;
  includeRejected: boolean;
  orphans: boolean;
}

function parseFlags(argv: string[]): Flags {
  return {
    apply: argv.includes("--apply"),
    includeRejected: argv.includes("--include-rejected"),
    orphans: argv.includes("--orphans"),
  };
}

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

interface Plan {
  project: ProjectConfig;
  removals: Array<{ path: string; branch: string | null; reason: string }>;
}

async function planFor(project: ProjectConfig, flags: Flags, ideas: IdeaSummary[]): Promise<Plan> {
  const repoPath = expandHome(project.local_path);
  if (!fs.existsSync(repoPath)) {
    log.warn(`Skipping ${project.key}: ${repoPath} does not exist.`);
    return { project, removals: [] };
  }
  const worktrees = await listIdeaWorktrees(repoPath);

  // Map worktree branch → idea (if any) for status lookup.
  const ideaByBranch = new Map<string, IdeaSummary>();
  for (const i of ideas) ideaByBranch.set(computeBranchName(i), i);

  const removals: Plan["removals"] = [];
  for (const wt of worktrees) {
    const idea = wt.branch ? ideaByBranch.get(wt.branch) : undefined;
    if (!idea) {
      if (flags.orphans) {
        removals.push({ path: wt.path, branch: wt.branch, reason: "orphan (no matching idea)" });
      }
      continue;
    }
    if (idea.status === "shipped") {
      removals.push({ path: wt.path, branch: wt.branch, reason: "shipped" });
    } else if (idea.status === "rejected" && flags.includeRejected) {
      removals.push({ path: wt.path, branch: wt.branch, reason: "rejected" });
    }
  }
  return { project, removals };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projects = loadProjects();
  const ideas = listIdeas();

  let total = 0;
  for (const project of projects) {
    const plan = await planFor(project, flags, ideas);
    if (plan.removals.length === 0) continue;

    console.log(`\n${project.key} (${project.local_path}):`);
    for (const r of plan.removals) {
      console.log(`  ${flags.apply ? "REMOVING" : "would remove"}: ${r.path}  [${r.branch ?? "(detached)"}, ${r.reason}]`);
      if (flags.apply) {
        try {
          await removeWorktree(expandHome(project.local_path), r.path);
        } catch (err) {
          log.error(`  Failed to remove ${r.path}: ${(err as Error).message}`);
          continue;
        }
      }
      total++;
    }
  }

  if (total === 0) {
    console.log("\nNothing to clean up.");
    return;
  }
  if (!flags.apply) {
    console.log(`\n${total} worktree(s) eligible. Re-run with --apply to remove.`);
  } else {
    console.log(`\n✓ Removed ${total} worktree(s).`);
  }
}

main().catch((err) => {
  log.error("Cleanup failed:", err);
  process.exit(1);
});
