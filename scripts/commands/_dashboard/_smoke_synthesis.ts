/**
 * scripts/commands/_dashboard/_smoke_synthesis.ts
 *
 * Phase 4 (cross-idea synthesis) regression. Pure function over an
 * in-memory corpus — no fs reads.
 */

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const synth = req("../../lib/synthesis") as typeof import("../../lib/synthesis");

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // Build a corpus directly via the opt-in `corpus` override so we
  // don't need to write idea files to disk.
  const corpus = [
    { slug: "alpha", title: "Auto-flow accepted ideas straight to building", body: "skip the human gate when the brainstormer is confident enough." },
    { slug: "beta", title: "Daily digest of what the harness did today", body: "summary of captures decisions and shipped PRs." },
    { slug: "gamma", title: "Build a new fence around the dog area", body: "physical project unrelated to software." },
  ];

  // ── case 1: near-duplicate (>70%) ─────────────────────────────────
  {
    const hits = synth.findSimilar(
      "Auto-flow accepted ideas straight to building",
      "skip the human gate when the brainstormer is confident enough.",
      [],
      { corpus, threshold: 0.7 }
    );
    check("near-duplicate produces at least one hit", hits.length >= 1, JSON.stringify(hits));
    check("top hit matches alpha", hits[0]?.slug === "alpha", hits[0]?.slug);
    check("top hit similarity above threshold",
      (hits[0]?.similarity ?? 0) >= 0.7, String(hits[0]?.similarity));
  }

  // ── case 2: distinct idea (<70%) ──────────────────────────────────
  {
    const hits = synth.findSimilar(
      "PR follow-through automation",
      "watch CI, address review comments, merge when green.",
      [],
      { corpus, threshold: 0.7 }
    );
    check("distinct idea produces no hits at 0.7", hits.length === 0,
      JSON.stringify(hits));
  }

  // ── case 3: excludeSlug skips self ────────────────────────────────
  {
    const hits = synth.findSimilar(
      "Auto-flow accepted ideas straight to building",
      "skip the human gate when the brainstormer is confident enough.",
      [],
      { corpus, threshold: 0.5 },
      "alpha"
    );
    check("excludeSlug filters out the self entry",
      hits.every((h) => h.slug !== "alpha"));
  }

  // ── case 4: env-driven threshold override ─────────────────────────
  {
    const prior = process.env.IDEA_HARNESS_SYNTHESIS_THRESHOLD;
    process.env.IDEA_HARNESS_SYNTHESIS_THRESHOLD = "0.05";
    const hits = synth.findSimilar(
      "Build a fence",
      "around the dog area",
      [],
      { corpus }
    );
    process.env.IDEA_HARNESS_SYNTHESIS_THRESHOLD = prior ?? "";
    check("env threshold lets weak match in",
      hits.some((h) => h.slug === "gamma"),
      JSON.stringify(hits));
  }

  // ── case 5: empty target → no hits ───────────────────────────────
  {
    const hits = synth.findSimilar("", "", [], { corpus });
    check("empty target returns []", hits.length === 0);
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-synthesis FAIL:", e);
  process.exit(1);
});
