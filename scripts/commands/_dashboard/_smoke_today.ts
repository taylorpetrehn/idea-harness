/**
 * scripts/commands/_dashboard/_smoke_today.ts
 *
 * Asserts buildTodayLifecycle's properties:
 *   1. one row per slug (collapses N events for the same slug)
 *   2. trail glyphs in chronological order
 *   3. latestKind = the most recent kind
 *   4. prUrl extracted when an idea reaches pr-open
 *   5. sort order = newest activity first
 */

async function main() {
  const dataMod = await import("./data");

  // Use offsets from "now" so the buildTodayFeed window includes them.
  const now = Date.now();
  const min = 60 * 1000;
  const t0 = new Date(now - 30 * min).toISOString();
  const t1 = new Date(now - 25 * min).toISOString();
  const t2 = new Date(now - 20 * min).toISOString();
  const t3 = new Date(now - 15 * min).toISOString();
  const t4 = new Date(now - 10 * min).toISOString();
  const t5 = new Date(now - 35 * min).toISOString();

  const ideas = [
    {
      filename: "alpha.md",
      slug: "alpha",
      id: "a",
      title: "Alpha idea",
      status: "pr-open" as const,
      project: "letsbarker",
      captured_at: t0,
      brainstormed_at: t1,
      decided_at: t2,
      github_issue: "",
      github_pr: "https://github.com/example/repo/pull/42",
      loop_count: 0,
    },
    {
      filename: "beta.md",
      slug: "beta",
      id: "b",
      title: "Beta idea",
      status: "brainstormed" as const,
      project: "letsbarker",
      captured_at: t5,
      brainstormed_at: t5,
      decided_at: "",
      github_issue: "",
      github_pr: "",
      loop_count: 0,
    },
  ];

  const journal = [
    { ts: t1, type: "idea.status", slug: "alpha", data: { from: "raw", to: "brainstormed" } },
    { ts: t2, type: "idea.status", slug: "alpha", data: { from: "brainstormed", to: "accepted" } },
    { ts: t3, type: "idea.status", slug: "alpha", data: { from: "accepted", to: "building" } },
    { ts: t4, type: "idea.status", slug: "alpha", data: { from: "building", to: "pr-open" } },
    { ts: t4, type: "idea.frontmatter", slug: "alpha", data: { key: "github_pr", value: "https://github.com/example/repo/pull/42" } },
    { ts: t5, type: "idea.status", slug: "beta",  data: { from: "raw", to: "brainstormed" } },
  ];

  // Use a window wide enough to include t5 (07:55Z, ~2.5 hours older than t4).
  const lifecycle = dataMod.buildTodayLifecycle(ideas, journal, { windowMs: 4 * 60 * 60 * 1000 });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  check("two rows total (one per slug)", lifecycle.length === 2,
    `got ${lifecycle.length}`);

  // Sort: alpha had latest activity at t4, beta at t5 (older). Alpha first.
  check("rows sorted newest-first by latest activity",
    lifecycle[0]?.slug === "alpha" && lifecycle[1]?.slug === "beta");

  const alpha = lifecycle.find((r) => r.slug === "alpha");
  const beta = lifecycle.find((r) => r.slug === "beta");

  if (alpha) {
    // Alpha trail = captured, brainstormed, accepted, build-start, pr-open
    check("alpha trail length is 5", alpha.trail.length === 5,
      `got ${alpha.trail.length}: ${alpha.trail.join(",")}`);
    check("alpha trail chronological",
      alpha.trail[0] === "captured" &&
      alpha.trail[1] === "brainstormed" &&
      alpha.trail[2] === "accepted" &&
      alpha.trail[3] === "build-start" &&
      alpha.trail[4] === "pr-open",
      alpha.trail.join(","));
    check("alpha latestKind === 'pr-open'", alpha.latestKind === "pr-open",
      `got ${alpha.latestKind}`);
    check("alpha latestTs === t4", alpha.latestTs === t4);
    check("alpha earliestTs === t0", alpha.earliestTs === t0);
    check("alpha prUrl extracted",
      alpha.prUrl === "https://github.com/example/repo/pull/42",
      alpha.prUrl);
    check("alpha title preserved", alpha.title === "Alpha idea");
  } else {
    check("alpha row present", false);
  }

  if (beta) {
    check("beta trail length is 2", beta.trail.length === 2);
    check("beta trail = captured, brainstormed",
      beta.trail[0] === "captured" && beta.trail[1] === "brainstormed");
    check("beta has no prUrl", beta.prUrl === undefined);
  } else {
    check("beta row present", false);
  }

  // ── orphan filter ────────────────────────────────────────────────
  // Inject a journal entry for a slug with NO matching idea (i.e. the
  // idea file was deleted but the journal entry persists). By default
  // it should not appear in the lifecycle output.
  const orphanJournal = [
    ...journal,
    { ts: t4, type: "idea.status", slug: "ghost-of-deleted-idea",
      data: { from: "raw", to: "brainstormed" } },
  ];
  const filtered = dataMod.buildTodayLifecycle(ideas, orphanJournal,
    { windowMs: 4 * 60 * 60 * 1000 });
  check("orphan slug filtered out by default",
    !filtered.some((e) => e.slug === "ghost-of-deleted-idea"));

  const withOrphans = dataMod.buildTodayLifecycle(ideas, orphanJournal,
    { windowMs: 4 * 60 * 60 * 1000, includeOrphans: true });
  check("orphan slug shown with includeOrphans: true",
    withOrphans.some((e) => e.slug === "ghost-of-deleted-idea"));

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-today FAIL:", e);
  process.exit(1);
});
