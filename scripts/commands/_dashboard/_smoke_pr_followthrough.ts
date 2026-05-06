/**
 * scripts/commands/_dashboard/_smoke_pr_followthrough.ts
 *
 * Phase 3 (PR follow-through) regression. Drives `followOne` through
 * the full state machine by stubbing the `gh` CLI surface via
 * `setGhRunner` and the Claude spawn via the `spawnClaude` opt.
 *
 * Cycle exercised:
 *   1. CI pending      → status: ci-running, no spawn
 *   2. CI failed       → status: ci-failed, claude spawned with log
 *   3. CI green +
 *      approved        → status: merged, gh pr merge invoked
 *
 * Plus:
 *   - reviewer requested changes → status: review-changes-requested,
 *     claude spawned with comment thread
 *   - PR already merged upstream → status: merged (idempotent)
 *
 * Pure file + journal level — no real gh, no real claude, no
 * network. The real `gh pr merge` call is observed via the runner
 * stub recording its arguments.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);

  const githubMod = req("../../lib/github") as typeof import("../../lib/github");
  const watcherMod = req("../../agents/pr_watcher") as
    typeof import("../../agents/pr_watcher");
  const ideasMod = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const { readJournal, purgeJournalForSlug } = req("../../lib/journal") as
    typeof import("../../lib/journal");
  const dataMod = await import("./data");
  const indexMod = await import("./index");

  const realIdeasDir = path.join(process.cwd(), "ideas");
  const seededSlugs: string[] = [];

  const cleanup = () => {
    for (const slug of seededSlugs) {
      try { fs.unlinkSync(path.join(realIdeasDir, `${slug}.md`)); } catch { /* ignore */ }
      try { purgeJournalForSlug(slug); } catch { /* ignore */ }
    }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  let counter = 0;
  const seedIdea = (status: string): { slug: string; filepath: string; prUrl: string } => {
    counter += 1;
    const slug = `prfollow-smoke-${Date.now()}-${counter}`;
    seededSlugs.push(slug);
    const prUrl = `https://github.com/example/repo/pull/${1000 + counter}`;
    const filepath = path.join(realIdeasDir, `${slug}.md`);
    const body = [
      `---`,
      `id: ${counter.toString(16).padStart(8, "0")}`,
      `title: "PR-follow probe ${counter}"`,
      `status: ${status}`,
      `source: smoke`,
      `project: letsbarker`,
      `captured_at: ${new Date(Date.now() - 120_000).toISOString()}`,
      `brainstormed_at: ${new Date(Date.now() - 90_000).toISOString()}`,
      `decided_at: ${new Date(Date.now() - 60_000).toISOString()}`,
      `github_issue: ~`,
      `github_pr: ${prUrl}`,
      `loop_count: 0`,
      `---`,
      ``,
      `## Raw Idea`,
      ``,
      `Probe.`,
      ``,
    ].join("\n");
    fs.writeFileSync(filepath, body, "utf8");
    return { slug, filepath, prUrl };
  };

  // ── stub gh runner: dispatched on the first arg pair ─────────────
  type StubResponse = { exitCode: number; stdout: string; stderr?: string };
  const ghCalls: string[][] = [];
  let prJson: Record<string, unknown> = {};
  let checksJson: unknown[] = [];
  let logResp: StubResponse = { exitCode: 0, stdout: "" };
  let mergeResp: StubResponse = { exitCode: 0, stdout: "" };

  githubMod.setGhRunner(async (args) => {
    ghCalls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      // The wrapper requests two different JSON shapes via --json arg.
      const jsonArg = args[args.indexOf("--json") + 1] ?? "";
      if (jsonArg.includes("comments")) {
        const out = JSON.stringify({
          comments: prJson.comments ?? [],
          reviews: prJson.reviews ?? [],
        });
        return { exitCode: 0, stdout: out, stderr: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify(prJson), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "checks") {
      return { exitCode: 0, stdout: JSON.stringify(checksJson), stderr: "" };
    }
    if (args[0] === "run" && args[1] === "view") {
      return { ...logResp, stderr: logResp.stderr ?? "" };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return { ...mergeResp, stderr: mergeResp.stderr ?? "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unhandled" };
  });

  // claude spawn stub: records calls, returns success
  const spawnCalls: { systemPrompt: string; userPrompt: string }[] = [];
  const spawnClaude = async (a: { systemPrompt: string; userPrompt: string }) => {
    spawnCalls.push({ systemPrompt: a.systemPrompt, userPrompt: a.userPrompt });
    return { exitCode: 0, stdout: "ok" };
  };

  // ── case 1: CI pending → ci-running ─────────────────────────────
  {
    const { slug } = seedIdea("pr-open");
    prJson = {
      number: 1001,
      url: "https://github.com/example/repo/pull/1001",
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "abc",
      reviewDecision: "REVIEW_REQUIRED",
      reviews: [],
      statusCheckRollup: [{ conclusion: "PENDING" }],
    };
    const r = await watcherMod.followOne(slug, { spawnClaude });
    check("ci-pending → outcome ci-running", r.outcome === "ci-running", r.outcome);
    const idea = ideasMod.findIdea(slug);
    check("ci-pending → status flipped to ci-running",
      idea?.status === "ci-running", idea?.status);
    check("ci-pending → no claude spawn", spawnCalls.length === 0);
  }

  // ── case 2: CI failed → spawn with log ──────────────────────────
  {
    const { slug } = seedIdea("ci-running");
    prJson = {
      number: 1002,
      url: "https://github.com/example/repo/pull/1002",
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "def",
      reviewDecision: "REVIEW_REQUIRED",
      reviews: [],
      statusCheckRollup: [{ conclusion: "FAILURE" }],
    };
    checksJson = [
      { name: "test", state: "FAILURE", link: "https://github.com/example/repo/actions/runs/9991", workflow: "ci" },
    ];
    logResp = { exitCode: 0, stdout: "stub failing log: AssertionError" };
    const beforeSpawn = spawnCalls.length;
    const r = await watcherMod.followOne(slug, { spawnClaude });
    check("ci-failed → outcome ci-failed-spawned",
      r.outcome === "ci-failed-spawned", r.outcome);
    const idea = ideasMod.findIdea(slug);
    check("ci-failed → status flipped to ci-failed",
      idea?.status === "ci-failed", idea?.status);
    check("ci-failed → claude spawned exactly once", spawnCalls.length === beforeSpawn + 1);
    const last = spawnCalls[spawnCalls.length - 1];
    check("ci-failed → spawn user prompt contains failing log",
      last.userPrompt.includes("AssertionError"), last.userPrompt.slice(0, 60));
  }

  // ── case 3: CI green + approved → merge ─────────────────────────
  {
    const { slug } = seedIdea("ci-running");
    prJson = {
      number: 1003,
      url: "https://github.com/example/repo/pull/1003",
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "ghi",
      reviewDecision: "APPROVED",
      reviews: [{ state: "APPROVED" }],
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    };
    mergeResp = { exitCode: 0, stdout: "merged" };
    const beforeMerges = ghCalls.filter((a) => a[0] === "pr" && a[1] === "merge").length;
    const r = await watcherMod.followOne(slug, { spawnClaude });
    check("green+approved → outcome merged", r.outcome === "merged", r.outcome);
    const idea = ideasMod.findIdea(slug);
    check("green+approved → status flipped to merged",
      idea?.status === "merged", idea?.status);
    const afterMerges = ghCalls.filter((a) => a[0] === "pr" && a[1] === "merge").length;
    check("green+approved → gh pr merge invoked",
      afterMerges === beforeMerges + 1,
      `before=${beforeMerges} after=${afterMerges}`);
  }

  // ── case 4: review-changes-requested → spawn with comments ─────
  {
    const { slug } = seedIdea("pr-open");
    prJson = {
      number: 1004,
      url: "https://github.com/example/repo/pull/1004",
      state: "OPEN",
      mergeable: "MERGEABLE",
      headRefOid: "jkl",
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{ state: "CHANGES_REQUESTED", body: "needs more tests" }],
      comments: [{
        id: "c1",
        author: { login: "reviewer1" },
        body: "this off-by-one looks wrong",
        createdAt: new Date().toISOString(),
        path: "src/foo.ts",
        line: 42,
      }],
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    };
    const beforeSpawn = spawnCalls.length;
    const r = await watcherMod.followOne(slug, { spawnClaude });
    check("changes-requested → outcome review-spawned",
      r.outcome === "review-spawned", r.outcome);
    const idea = ideasMod.findIdea(slug);
    check("changes-requested → status flipped",
      idea?.status === "review-changes-requested", idea?.status);
    check("changes-requested → claude spawned",
      spawnCalls.length === beforeSpawn + 1);
    const last = spawnCalls[spawnCalls.length - 1];
    check("review spawn includes comment body",
      last.userPrompt.includes("off-by-one"),
      last.userPrompt.slice(0, 80));
  }

  // ── case 5: PR already merged upstream → idempotent merged ──────
  {
    const { slug } = seedIdea("pr-open");
    prJson = {
      number: 1005,
      url: "https://github.com/example/repo/pull/1005",
      state: "MERGED",
      mergeable: "UNKNOWN",
      headRefOid: "mno",
      reviewDecision: "APPROVED",
      reviews: [{ state: "APPROVED" }],
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    };
    const r = await watcherMod.followOne(slug, { spawnClaude });
    check("upstream merged → outcome merged", r.outcome === "merged", r.outcome);
    const idea = ideasMod.findIdea(slug);
    check("upstream merged → status flipped to merged",
      idea?.status === "merged", idea?.status);

    // Lifecycle entry should now have merged in the trail with ✅
    const since = new Date(Date.now() - 5 * 60_000);
    const journal = readJournal({ since }).filter((e) => e.slug === slug);
    if (idea) {
      const lifecycle = dataMod.buildTodayLifecycle([idea], journal, {
        windowMs: 60 * 60 * 1000,
      });
      const row = lifecycle.find((r) => r.slug === slug);
      check("lifecycle entry built post-merge", !!row);
      if (row) {
        const trail = indexMod.buildTrailGlyphs(row).join("");
        check("trail contains ✅ glyph",
          trail.includes("✅"), `trail=${trail}`);
      }
    } else {
      check("lifecycle entry built post-merge", false);
    }
  }

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-pr-followthrough FAIL:", e);
  process.exit(1);
});
