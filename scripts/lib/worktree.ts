/**
 * scripts/lib/worktree.ts
 *
 * Builds happen in a git worktree, not the user's primary checkout.
 *
 * Why: building inside the primary repo means every build session mutates
 * HEAD and the working tree of the directory the user has open in their
 * editor. Two real failure modes that drove this:
 *
 *   1. Concurrency. `npm run graduate -- --all` with two accepted ideas
 *      spawns two `claude` sessions in the same cwd; both run `git
 *      checkout -b …` and stomp HEAD.
 *   2. Working-tree leakage. Any in-progress edit the user had open
 *      could be picked up by `git add` and end up in the PR.
 *
 * Worktree layout: `<repo-parent>/<repo-basename>-worktrees/<branch-flat>`.
 * For LetsBarker that's e.g.
 *   ~/Projects/PrimaryBarker/LetsBarker-worktrees/idea-dm-cohorts-d2e3
 * Override the parent dir with IDEA_HARNESS_WORKTREE_DIR.
 *
 * Lifecycle:
 *   - prepare(repo, branch, base, intent): returns a worktree path ready
 *     to spawn Claude in. For "build" we create fresh from origin/<base>.
 *     For "resume" we reuse an existing worktree if present, else
 *     recreate it from the remote branch tip (the in-flight edits are
 *     gone in that case, but the PR-only recovery still works).
 *   - listIdeaWorktrees(repo): every worktree under our managed dir.
 *   - remove(repo, path): tears one down. Used by `npm run cleanup`.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "./log";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** True if the worktree directory already existed and we reused it. */
  reused: boolean;
}

export interface PrepareWorktreeArgs {
  repoPath: string;
  branch: string;
  baseBranch: string;
  intent: "build" | "resume";
}

export async function prepareWorktree(args: PrepareWorktreeArgs): Promise<WorktreeInfo> {
  const { repoPath, branch, baseBranch, intent } = args;
  // Normalize through realpath so subsequent comparisons against
  // `git worktree list --porcelain` match (on macOS /tmp → /private/tmp,
  // and any user-supplied path could be a symlink).
  const repoPathReal = realpathOrSelf(repoPath);
  const wtPath = worktreePathFor(repoPathReal, branch);
  const wtDir = path.dirname(wtPath);
  if (!fs.existsSync(wtDir)) fs.mkdirSync(wtDir, { recursive: true });

  // Ground truth from git, not the filesystem — a worktree dir can exist
  // without git knowing about it (manual `rm -rf` leaves it stale), and
  // git can know about a worktree whose dir was deleted.
  const tracked = await gitWorktreeRecordFor(repoPathReal, wtPath);

  if (intent === "resume") {
    if (tracked && fs.existsSync(wtPath)) {
      log.info(`worktree: reusing ${wtPath}`);
      return { path: wtPath, branch, reused: true };
    }
    // Resume but no existing worktree — create from the branch's current
    // ref. The in-flight edits are not recoverable in this path, but Claude
    // can still PR whatever already pushed (or refuse if there's nothing).
    log.warn(
      `worktree: no existing worktree for ${branch} — recreating. ` +
        `Any uncommitted edits from the prior session are not recoverable.`
    );
    await fetchRemote(repoPathReal, branch);
    await scrubTracking(repoPathReal, wtPath);
    await createWorktree({ repoPath: repoPathReal, wtPath, branch, baseBranch, fromExistingBranch: true });
    return { path: wtPath, branch, reused: false };
  }

  // intent === "build" — always start clean. Two stale-state cases:
  //   1. Worktree tracked + dir present (or absent): tear it down.
  //   2. Branch exists locally with no worktree: delete the branch so
  //      `worktree add -b <branch>` doesn't refuse.
  if (tracked) {
    log.warn(
      `worktree: existing worktree at ${wtPath} for fresh build — removing.` +
        ` (Use \`npm run resume\` to recover an in-flight build instead.)`
    );
  }
  await scrubTracking(repoPathReal, wtPath);
  await deleteLocalBranchIfExists(repoPathReal, branch);

  await fetchRemote(repoPathReal, baseBranch);
  await createWorktree({ repoPath: repoPathReal, wtPath, branch, baseBranch, fromExistingBranch: false });
  return { path: wtPath, branch, reused: false };
}

/**
 * List every worktree git knows about that lives under our managed dir
 * for `repoPath`. Used by cleanup to find shipped/orphaned worktrees.
 */
export async function listIdeaWorktrees(repoPath: string): Promise<Array<{ path: string; branch: string | null }>> {
  const repoPathReal = realpathOrSelf(repoPath);
  const managedRoot = realpathOrSelf(managedWorktreeRoot(repoPathReal));
  const records = await listAllWorktreeRecords(repoPathReal);
  return records
    .filter((r) => r.path.startsWith(managedRoot + path.sep))
    .map((r) => ({ path: r.path, branch: r.branch }));
}

export async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  const repoPathReal = realpathOrSelf(repoPath);
  await execFileAsync("git", ["-C", repoPathReal, "worktree", "remove", "--force", wtPath]).catch(
    async (err) => {
      // git refuses if the dir is missing; in that case prune handles it.
      log.debug(`worktree: remove failed (${(err as Error).message}), trying prune.`);
    }
  );
  if (fs.existsSync(wtPath)) await rmrf(wtPath);
  await execFileAsync("git", ["-C", repoPathReal, "worktree", "prune"]).catch(() => {});
}

// ── Internal ───────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

/**
 * Resolve symlinks so our string-equality comparisons against
 * `git worktree list --porcelain` line up. macOS resolves /tmp →
 * /private/tmp, so a wtPath we computed at /tmp/... won't match git's
 * reported /private/tmp/... otherwise.
 *
 * Falls back to the input if the path doesn't exist yet — we still want
 * a stable canonical form before the dir is created.
 */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Path doesn't exist — best-effort: realpath the longest existing
    // prefix and rejoin the rest, so /tmp/<not-yet-created> still
    // canonicalizes to /private/tmp/<not-yet-created>.
    let prefix = p;
    const tail: string[] = [];
    while (prefix && prefix !== path.dirname(prefix)) {
      try {
        const real = fs.realpathSync(prefix);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch {
        tail.push(path.basename(prefix));
        prefix = path.dirname(prefix);
      }
    }
    return p;
  }
}

function managedWorktreeRoot(repoPath: string): string {
  const override = process.env.IDEA_HARNESS_WORKTREE_DIR;
  if (override) return path.join(expandHome(override), path.basename(repoPath));
  return path.join(path.dirname(repoPath), `${path.basename(repoPath)}-worktrees`);
}

function worktreePathFor(repoPath: string, branch: string): string {
  // Branch names contain "/" (e.g. idea/foo-1234) which is fine for git but
  // creates a subdir we'd then have to manage. Flatten with "-" so each
  // worktree is one level deep — predictable to find, easy to clean.
  const flat = branch.replace(/\//g, "-");
  return path.join(managedWorktreeRoot(repoPath), flat);
}

async function fetchRemote(repoPath: string, ref: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repoPath, "fetch", "origin", ref], {
      timeout: 60_000,
    });
  } catch (err) {
    // Don't hard-fail if the remote is offline — let git's local copy of
    // origin/<ref> be the base. Surface the warning.
    log.warn(`worktree: \`git fetch origin ${ref}\` failed: ${(err as Error).message}`);
  }
}

async function createWorktree(args: {
  repoPath: string;
  wtPath: string;
  branch: string;
  baseBranch: string;
  fromExistingBranch: boolean;
}): Promise<void> {
  const { repoPath, wtPath, branch, baseBranch, fromExistingBranch } = args;
  const cmd = fromExistingBranch
    ? ["-C", repoPath, "worktree", "add", wtPath, branch]
    : ["-C", repoPath, "worktree", "add", "-b", branch, wtPath, `origin/${baseBranch}`];
  log.info(`worktree: \`git ${cmd.join(" ")}\``);
  await execFileAsync("git", cmd, { timeout: 60_000 });
}

interface WorktreeRecord {
  path: string;
  branch: string | null;
}

async function listAllWorktreeRecords(repoPath: string): Promise<WorktreeRecord[]> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    timeout: 10_000,
  });
  return parseWorktreePorcelain(stdout);
}

async function gitWorktreeRecordFor(repoPath: string, wtPath: string): Promise<WorktreeRecord | null> {
  const records = await listAllWorktreeRecords(repoPath);
  return records.find((r) => r.path === wtPath) ?? null;
}

function parseWorktreePorcelain(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: Partial<WorktreeRecord> | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      if (current?.path) records.push({ path: current.path, branch: current.branch ?? null });
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
    } else if (current && line.startsWith("branch ")) {
      // Format: "branch refs/heads/<name>"
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
    } else if (current && line === "detached") {
      current.branch = null;
    }
  }
  if (current?.path) records.push({ path: current.path, branch: current.branch ?? null });
  return records;
}

/**
 * Tear down whatever git knows about a worktree at this path AND the dir
 * itself. Idempotent — safe to call when nothing exists. Always finishes
 * with `git worktree prune` so subsequent `worktree add` calls don't trip
 * over orphan tracking records.
 */
async function scrubTracking(repoPath: string, wtPath: string): Promise<void> {
  // `git worktree remove --force` only works if the dir exists; if it
  // doesn't, prune is the right tool. Run both to cover every state.
  await execFileAsync("git", ["-C", repoPath, "worktree", "remove", "--force", wtPath]).catch(
    () => {}
  );
  await execFileAsync("git", ["-C", repoPath, "worktree", "prune"]).catch(() => {});
  if (fs.existsSync(wtPath)) await rmrf(wtPath);
}

async function deleteLocalBranchIfExists(repoPath: string, branch: string): Promise<void> {
  // For a fresh build we want a clean branch off origin/<base>. If a prior
  // failed build left a local branch behind (with or without commits), git
  // refuses `worktree add -b <branch>` with "branch already exists". Delete
  // it; if it had work that wasn't pushed, the user already lost it the
  // moment the prior session crashed without pushing.
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoPath, "branch", "--list", branch],
    { timeout: 10_000 }
  ).catch(() => ({ stdout: "" }));
  if (!stdout.trim()) return;
  log.warn(`worktree: deleting stale local branch ${branch} so the fresh build can branch off origin/<base>.`);
  await execFileAsync("git", ["-C", repoPath, "branch", "-D", branch]).catch((err) => {
    log.warn(`worktree: \`git branch -D ${branch}\` failed: ${(err as Error).message}`);
  });
}

async function rmrf(target: string): Promise<void> {
  await fs.promises.rm(target, { recursive: true, force: true });
}
