/**
 * scripts/lib/github.ts
 *
 * Phase 3 (PR follow-through). Thin wrapper around the `gh` CLI so
 * the watcher / follow / watch-prs verbs talk to GitHub through one
 * pinch point — and so smokes can stub the whole surface via the
 * `setGhRunner` injection seam below.
 *
 * Design notes:
 *   - Every call shells out via `runner` (default: spawn `gh ...`).
 *     Tests inject a deterministic runner that returns canned JSON
 *     instead of touching the network.
 *   - Outputs are normalized to small TypeScript shapes — callers
 *     never see raw gh JSON.
 *   - Failure modes:
 *       * `gh` not installed → throws once with a clear message.
 *       * gh exits non-zero → returns null/empty rather than throw,
 *         on the theory that "we couldn't see the PR" is a transient
 *         signal the watcher should retry, not a fatal harness error.
 *       * Authentication issues surface as the gh CLI's stderr in the
 *         thrown error so the user sees the actual problem.
 */

import { spawn } from "child_process";

// ── Types exposed to callers ──────────────────────────────────────

export interface PRStatus {
  /** PR number (matches the URL `/pull/<n>`). */
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** Aggregated CI state: `success`, `failure`, `pending`, `none`. */
  checksConclusion: ChecksConclusion;
  /** True when at least one human reviewer approved. */
  approved: boolean;
  /** True when at least one reviewer requested changes. */
  changesRequested: boolean;
  /** Latest commit SHA (handy for posting status checks back). */
  headSha: string;
}

export type ChecksConclusion = "success" | "failure" | "pending" | "none";

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  /** ISO timestamp from the GitHub API. */
  createdAt: string;
  /** Code path the comment was anchored to, if any. */
  path?: string;
  /** Diff position / line, if any. */
  line?: number;
  /** True when this comment is resolved upstream. */
  resolved: boolean;
}

// ── runner injection (test seam) ──────────────────────────────────

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => Promise<GhResult>;

let runner: GhRunner = defaultRunner;

/** Replace the gh runner. Tests use this to stub network calls;
 *  production code should never touch it. Returns the previous
 *  runner so smokes can scope-restore. */
export function setGhRunner(next: GhRunner): GhRunner {
  const prev = runner;
  runner = next;
  return prev;
}

async function defaultRunner(args: string[]): Promise<GhResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => reject(err));
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr })
    );
  });
}

// ── public API ────────────────────────────────────────────────────

/**
 * Look up the current state of a PR identified by URL or `<number>`.
 * Returns null when the PR can't be found / gh fails — the watcher
 * treats null as "retry next tick" rather than a fatal error.
 */
export async function fetchPRStatus(prRef: string): Promise<PRStatus | null> {
  const args = [
    "pr", "view", prRef,
    "--json", "number,url,state,mergeable,headRefOid,statusCheckRollup,reviewDecision,reviews",
  ];
  const r = await runner(args);
  if (r.exitCode !== 0) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  return normalizePRStatus(raw);
}

/**
 * Pull the open review comments off a PR — i.e. the inline diff
 * comments + the conversation thread. The watcher feeds these into
 * Claude Code as the "address this comment" prompt body.
 */
export async function fetchReviewComments(prRef: string): Promise<ReviewComment[]> {
  const args = [
    "pr", "view", prRef,
    "--json", "comments,reviews",
  ];
  const r = await runner(args);
  if (r.exitCode !== 0) return [];
  let raw: { comments?: unknown[]; reviews?: unknown[] };
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const out: ReviewComment[] = [];
  for (const c of raw.comments ?? []) out.push(normalizeComment(c, false));
  for (const review of raw.reviews ?? []) {
    const r2 = review as Record<string, unknown>;
    if (typeof r2.body === "string" && r2.body.trim()) {
      out.push(normalizeComment({
        id: r2.id ?? `review-${out.length}`,
        author: (r2.author as Record<string, unknown> | undefined)?.login ?? "",
        body: r2.body,
        createdAt: r2.submittedAt ?? r2.createdAt ?? "",
        state: r2.state,
      }, false));
    }
  }
  return out;
}

/**
 * Tail the latest run logs for the failing CI check on a PR. Returns
 * null when no failing run exists. The watcher passes this body
 * verbatim into the "fix this" Claude Code spawn so the model sees
 * the actual failure.
 */
export async function fetchFailingRunLog(prRef: string, maxBytes = 8000): Promise<string | null> {
  const checks = await runner([
    "pr", "checks", prRef, "--json", "name,state,link,workflow",
  ]);
  if (checks.exitCode !== 0) return null;
  let arr: Array<Record<string, unknown>>;
  try { arr = JSON.parse(checks.stdout); } catch { return null; }
  const failing = arr.find((c) => c.state === "FAILURE" || c.state === "TIMED_OUT");
  if (!failing) return null;
  const link = typeof failing.link === "string" ? failing.link : "";
  const runId = link.match(/\/runs\/(\d+)/)?.[1];
  if (!runId) return null;
  const log = await runner(["run", "view", runId, "--log-failed"]);
  if (log.exitCode !== 0) return null;
  return truncateUtf8(log.stdout, maxBytes);
}

/**
 * Merge the PR via `gh pr merge --merge`. Returns true on success.
 * Caller is responsible for checking the PR is actually green +
 * approved before invoking — this function does not double-check.
 */
export async function mergePR(prRef: string): Promise<boolean> {
  const r = await runner(["pr", "merge", prRef, "--merge"]);
  return r.exitCode === 0;
}

// ── helpers ───────────────────────────────────────────────────────

function normalizePRStatus(raw: Record<string, unknown>): PRStatus {
  const number = Number(raw.number ?? 0);
  const url = typeof raw.url === "string" ? raw.url : "";
  const state = (typeof raw.state === "string" ? raw.state : "OPEN").toUpperCase() as PRStatus["state"];
  const mergeable = (typeof raw.mergeable === "string" ? raw.mergeable : "UNKNOWN").toUpperCase() as PRStatus["mergeable"];
  const headSha = typeof raw.headRefOid === "string" ? raw.headRefOid : "";

  const rollup = (raw.statusCheckRollup as Array<Record<string, unknown>> | undefined) ?? [];
  let checksConclusion: ChecksConclusion = "none";
  if (rollup.length > 0) {
    const states = rollup.map((s) => String(s.conclusion ?? s.state ?? "").toUpperCase());
    if (states.some((s) => s === "FAILURE" || s === "TIMED_OUT" || s === "CANCELLED")) {
      checksConclusion = "failure";
    } else if (states.every((s) => s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED")) {
      checksConclusion = "success";
    } else {
      checksConclusion = "pending";
    }
  }

  const reviewDecision = String(raw.reviewDecision ?? "").toUpperCase();
  const reviews = (raw.reviews as Array<Record<string, unknown>> | undefined) ?? [];
  const approved =
    reviewDecision === "APPROVED" ||
    reviews.some((r) => String(r.state ?? "").toUpperCase() === "APPROVED");
  const changesRequested =
    reviewDecision === "CHANGES_REQUESTED" ||
    reviews.some((r) => String(r.state ?? "").toUpperCase() === "CHANGES_REQUESTED");

  return {
    number,
    url,
    state,
    mergeable,
    checksConclusion,
    approved,
    changesRequested,
    headSha,
  };
}

function normalizeComment(raw: unknown, _legacy: boolean): ReviewComment {
  const r = raw as Record<string, unknown>;
  const author = r.author as Record<string, unknown> | string | undefined;
  return {
    id: String(r.id ?? ""),
    author: typeof author === "string" ? author : (author?.login as string | undefined) ?? "",
    body: typeof r.body === "string" ? r.body : "",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    path: typeof r.path === "string" ? r.path : undefined,
    line: typeof r.line === "number" ? r.line : undefined,
    resolved: r.resolved === true,
  };
}

function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Tail bias: failures tend to be at the END of the log, so keep
  // the last `maxBytes` bytes rather than the first.
  const buf = Buffer.from(s, "utf8");
  const slice = buf.slice(buf.length - maxBytes);
  return "…[truncated]…\n" + slice.toString("utf8");
}
