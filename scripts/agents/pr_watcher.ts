/**
 * scripts/agents/pr_watcher.ts
 *
 * Phase 3 (PR follow-through). Drives an idea past `pr-open` toward
 * `merged` by polling the PR with `gh` and reacting:
 *
 *   - CI failed                  → status: ci-failed, then spawn
 *                                  Claude Code with the failing log
 *                                  and "fix this. test locally. push."
 *   - reviewer requested changes → status: review-changes-requested,
 *                                  then spawn Claude Code with the
 *                                  thread + diff and "address this."
 *   - CI green + approved        → `gh pr merge --merge`,
 *                                  status: merged.
 *   - CI pending                 → status: ci-running.
 *
 * One pass per call (`followOne`). The `harness follow` verb wraps it
 * for one-shot use; `harness watch-prs` wraps it in a loop.
 *
 * Test seam: the Claude spawn is injectable via the optional
 * `spawnClaude` opt, and the gh CLI surface lives behind
 * `lib/github.setGhRunner`. Together these let the smoke drive the
 * full state machine deterministically without touching the network
 * or shelling out.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { setStatus, IdeaSummary, findIdea } from "../lib/ideas";
import { appendJournal } from "../lib/journal";
import {
  fetchPRStatus,
  fetchReviewComments,
  fetchFailingRunLog,
  mergePR,
  PRStatus,
  ReviewComment,
} from "../lib/github";
import { log } from "../lib/log";

export type FollowOutcome =
  | "merged"
  | "ci-failed-spawned"
  | "review-spawned"
  | "ci-running"
  | "no-pr"
  | "noop";

export interface FollowResult {
  slug: string;
  outcome: FollowOutcome;
  prStatus: PRStatus | null;
  /** Tail of the action that was taken — failing log, comment thread,
   *  merge confirmation, etc. */
  detail?: string;
}

export interface FollowOptions {
  /** Override the Claude spawner. Production: not provided (uses
   *  real spawn). Smoke tests: stubbed to record calls and return
   *  a synthetic exit code. */
  spawnClaude?: (args: SpawnClaudeArgs) => Promise<SpawnClaudeResult>;
  /** Working directory for the spawn. Defaults to the idea's
   *  worktree if one exists, else process.cwd(). */
  cwd?: string;
}

export interface SpawnClaudeArgs {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface SpawnClaudeResult {
  exitCode: number;
  stdout: string;
}

const FOLLOW_FOLLOWUP_STATES: ReadonlySet<string> = new Set([
  "pr-open",
  "ci-running",
  "ci-failed",
  "review-changes-requested",
]);

/** True for ideas the watcher should follow. Anything outside this
 *  set (`raw`, `accepted`, `merged`, etc.) is skipped. */
export function shouldFollow(idea: IdeaSummary): boolean {
  return FOLLOW_FOLLOWUP_STATES.has(idea.status);
}

/**
 * Run one follow pass against an idea. Idempotent — calling it
 * twice in a row is fine; it just polls again and may take the
 * same action.
 */
export async function followOne(
  slug: string,
  opts: FollowOptions = {}
): Promise<FollowResult> {
  const idea = findIdea(slug);
  if (!idea) throw new Error(`pr_watcher: idea not found: ${slug}`);
  const prRef = idea.github_pr;
  if (!prRef) {
    return { slug, outcome: "no-pr", prStatus: null, detail: "no github_pr on idea" };
  }

  const status = await fetchPRStatus(prRef);
  if (!status) {
    return { slug, outcome: "noop", prStatus: null, detail: "gh returned no PR" };
  }

  // ── 1. Already merged upstream ───────────────────────────────────
  if (status.state === "MERGED") {
    if (idea.status !== "merged") {
      setStatus(slug, "merged");
      appendJournal({ type: "idea.pr_merged", slug, data: { url: status.url } });
    }
    return { slug, outcome: "merged", prStatus: status, detail: status.url };
  }

  // ── 2. Reviewer requested changes ────────────────────────────────
  if (status.changesRequested) {
    if (idea.status !== "review-changes-requested") {
      setStatus(slug, "review-changes-requested");
    }
    const comments = await fetchReviewComments(prRef);
    const detail = renderComments(comments);
    const spawnRes = await invokeClaude(idea, opts, {
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userPrompt:
        `The PR at ${status.url} has reviewer-requested changes. Address them.\n\n` +
        `## Comments\n\n${detail || "(no inline comments — see PR conversation)"}\n\n` +
        `When you've addressed everything, push the fix.`,
    });
    appendJournal({
      type: "idea.review_addressed",
      slug,
      data: { count: comments.length, exitCode: spawnRes.exitCode },
    });
    return { slug, outcome: "review-spawned", prStatus: status, detail };
  }

  // ── 3. CI failure ────────────────────────────────────────────────
  if (status.checksConclusion === "failure") {
    if (idea.status !== "ci-failed") {
      setStatus(slug, "ci-failed");
    }
    const failingLog = (await fetchFailingRunLog(prRef)) ?? "(no log available)";
    const spawnRes = await invokeClaude(idea, opts, {
      systemPrompt: CI_SYSTEM_PROMPT,
      userPrompt:
        `The CI for PR ${status.url} is failing. Fix it. Test locally. Push.\n\n` +
        `## Failing log (tail)\n\n\`\`\`\n${failingLog}\n\`\`\``,
    });
    appendJournal({
      type: "idea.ci_addressed",
      slug,
      data: { exitCode: spawnRes.exitCode },
    });
    return { slug, outcome: "ci-failed-spawned", prStatus: status, detail: failingLog };
  }

  // ── 4. CI green + approved → merge ───────────────────────────────
  if (
    status.checksConclusion === "success" &&
    status.approved &&
    status.mergeable !== "CONFLICTING"
  ) {
    const merged = await mergePR(prRef);
    if (merged) {
      setStatus(slug, "merged");
      appendJournal({ type: "idea.pr_merged", slug, data: { url: status.url } });
      return { slug, outcome: "merged", prStatus: status, detail: status.url };
    }
    return { slug, outcome: "noop", prStatus: status, detail: "gh pr merge failed" };
  }

  // ── 5. CI pending — record running, no action ────────────────────
  if (status.checksConclusion === "pending" && idea.status !== "ci-running") {
    setStatus(slug, "ci-running");
  }
  return { slug, outcome: "ci-running", prStatus: status };
}

// ── helpers ───────────────────────────────────────────────────────

const CLAUDE_BIN = process.env.IDEA_HARNESS_CLAUDE_BIN || "claude";

const REVIEW_SYSTEM_PROMPT =
  "You are addressing reviewer feedback on an open PR. Read the comments, " +
  "make the requested changes, run tests locally, then `git commit` and " +
  "`git push` to the same branch. Do not merge. Do not force-push.";

const CI_SYSTEM_PROMPT =
  "You are fixing a failing CI run on an open PR. Read the failing log, " +
  "fix the underlying issue (don't disable the test), run tests locally, " +
  "then `git commit` and `git push` to the same branch. Do not merge.";

async function invokeClaude(
  idea: IdeaSummary,
  opts: FollowOptions,
  prompts: { systemPrompt: string; userPrompt: string }
): Promise<SpawnClaudeResult> {
  const cwd = opts.cwd ?? resolveWorktree(idea) ?? process.cwd();
  const args: SpawnClaudeArgs = { cwd, ...prompts };
  if (opts.spawnClaude) return opts.spawnClaude(args);
  return defaultClaudeSpawn(args);
}

function resolveWorktree(idea: IdeaSummary): string | null {
  // Mirrors the builder's worktree convention. Falls back to null if
  // the directory is gone (e.g., user already cleaned up).
  const parent = process.env.IDEA_HARNESS_WORKTREE_DIR;
  if (!parent) return null;
  const dir = path.join(parent, idea.slug);
  return fs.existsSync(dir) ? dir : null;
}

async function defaultClaudeSpawn(args: SpawnClaudeArgs): Promise<SpawnClaudeResult> {
  return await new Promise((resolve, reject) => {
    const cliArgs = [
      "--print",
      "--system-prompt",
      args.systemPrompt,
      "--permission-mode",
      "bypassPermissions",
    ];
    const child = spawn(CLAUDE_BIN, cliArgs, {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => process.stderr.write(c));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
    child.stdin.write(args.userPrompt);
    child.stdin.end();
  });
}

function renderComments(comments: ReviewComment[]): string {
  if (comments.length === 0) return "";
  return comments
    .map((c) => {
      const loc = c.path ? `\n  (${c.path}${c.line ? `:${c.line}` : ""})` : "";
      return `### @${c.author}${loc}\n${c.body}`;
    })
    .join("\n\n");
}

void log; // keep import
