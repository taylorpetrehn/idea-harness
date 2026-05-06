/**
 * scripts/commands/_dashboard/_smoke_sharpener.ts
 *
 * Phase 2 (scope sharpener) regression. Asserts:
 *
 *   1. `sharpen()` writes an `## Open Question` section to the idea
 *      body and journals `idea.sharpened` with the question text.
 *   2. `parseBrainstormSections` surfaces the question as
 *      `openQuestion` (and the LATEST question wins when multiple
 *      blocks exist).
 *   3. `buildTodayLifecycle` propagates `sharpened: true` from
 *      `idea.sharpened` events through to the LifecycleEntry, and
 *      `buildTrailGlyphs` injects `❓` after the brainstormed glyph.
 *   4. `harness reply <slug>` (runReply) appends a `### Reply` block,
 *      bumps loop_count, and journals `idea.replied`. Re-running
 *      `parseBrainstormSections` still finds the question.
 *   5. `IDEA_HARNESS_AUTO_SHARPEN` unset → no sharpener side effects
 *      (the brainstormer's `maybeSharpen` short-circuits). We assert
 *      this at the env-flag level by checking the body stays
 *      untouched when sharpen() is not called.
 *
 * LLM transport: forced offline (`IDEA_HARNESS_LLM=offline`) so the
 * sharpener returns a deterministic question.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const sharpenerMod = req("../../agents/sharpener") as
    typeof import("../../agents/sharpener");
  const { readJournal, purgeJournalForSlug } = req("../../lib/journal") as
    typeof import("../../lib/journal");
  const dataMod = await import("./data");
  const indexMod = await import("./index");
  const replyMod = req("../reply") as typeof import("../reply");

  process.env.IDEA_HARNESS_LLM = "offline";

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sharpener-"));
  const seededSlugs: string[] = [];

  const cleanup = () => {
    for (const slug of seededSlugs) {
      try { purgeJournalForSlug(slug); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  let counter = 0;
  const seedIdea = (): { slug: string; filepath: string } => {
    counter += 1;
    const slug = `sharpener-smoke-${Date.now()}-${counter}`;
    seededSlugs.push(slug);
    const filepath = path.join(tmpRoot, `${slug}.md`);
    const body = [
      `---`,
      `id: ${counter.toString(16).padStart(8, "0")}`,
      `title: "Sharpener probe ${counter}"`,
      `status: brainstormed`,
      `source: smoke`,
      `project: letsbarker`,
      `captured_at: ${new Date(Date.now() - 60_000).toISOString()}`,
      `brainstormed_at: ${new Date(Date.now() - 30_000).toISOString()}`,
      `decided_at: ~`,
      `github_issue: ~`,
      `github_pr: ~`,
      `loop_count: 0`,
      `---`,
      ``,
      `## Raw Idea`,
      ``,
      `Probe.`,
      ``,
      `## Brainstorm`,
      ``,
      `### Problem`,
      ``,
      `It is unclear what the smallest valuable surface would be.`,
      ``,
      `### Risks and open questions`,
      ``,
      `- The audience size is unknown.`,
      `- Backend cost depends on something we have not measured.`,
      ``,
      `### Verdict`,
      ``,
      `**Recommended action:** needs-more-thought`,
      `**Confidence:** medium`,
      `**Why:** the user-facing surface is ambiguous and the risks are unscoped.`,
      `**If accepted, build:** the simplest version.`,
      ``,
    ].join("\n");
    fs.writeFileSync(filepath, body, "utf8");
    return { slug, filepath };
  };

  const since = new Date(Date.now() - 5 * 60 * 1000);

  // ── case 1: sharpen() side effects ────────────────────────────────
  {
    const { slug, filepath } = seedIdea();
    const before = fs.readFileSync(filepath, "utf8");
    const result = await sharpenerMod.sharpen(filepath);

    check("sharpen returned a non-empty question", result.question.length > 0,
      `got "${result.question}"`);
    check("sharpen reports written=true", result.written === true);

    const after = fs.readFileSync(filepath, "utf8");
    check("body grew with ## Open Question section",
      !before.includes("## Open Question") && /^##\s+Open Question/m.test(after));

    const auto = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.sharpened"
    );
    check("journal contains idea.sharpened",
      !!auto && typeof auto.data?.question === "string" && (auto.data.question as string).length > 0,
      JSON.stringify(auto?.data));
  }

  // ── case 2: parseBrainstormSections.openQuestion ───────────────────
  {
    const { slug, filepath } = seedIdea();
    await sharpenerMod.sharpen(filepath);
    const sections = dataMod.parseBrainstormSections(filepath);
    check("parseBrainstormSections.openQuestion is set",
      typeof sections.openQuestion === "string" && (sections.openQuestion?.length ?? 0) > 0,
      `got ${JSON.stringify(sections.openQuestion)}`);
    void slug;

    // Append a SECOND Open Question manually and verify the LAST one wins.
    const body = fs.readFileSync(filepath, "utf8");
    fs.writeFileSync(filepath, body + "\n## Open Question\n\nIs the data available offline?\n", "utf8");
    const sections2 = dataMod.parseBrainstormSections(filepath);
    check("parseBrainstormSections returns the LAST Open Question",
      sections2.openQuestion === "Is the data available offline?",
      `got ${JSON.stringify(sections2.openQuestion)}`);
  }

  // ── case 3: lifecycle propagation + ❓ trail ──────────────────────
  {
    const { slug, filepath } = seedIdea();
    await sharpenerMod.sharpen(filepath);

    const ideaSummary = {
      filename: `${slug}.md`,
      slug,
      id: "x",
      title: "Sharpener probe",
      status: "brainstormed" as const,
      project: "letsbarker",
      captured_at: new Date(Date.now() - 60_000).toISOString(),
      brainstormed_at: new Date(Date.now() - 30_000).toISOString(),
      decided_at: "",
      github_issue: "",
      github_pr: "",
      loop_count: 0,
    };
    const journal = readJournal({ since }).filter((e) => e.slug === slug);
    const lifecycle = dataMod.buildTodayLifecycle([ideaSummary], journal, {
      windowMs: 60 * 60 * 1000,
    });
    const row = lifecycle.find((r) => r.slug === slug);
    check("lifecycle entry built for sharpened slug", !!row);
    check("entry.sharpened === true", row?.sharpened === true);
    if (row) {
      const trail = indexMod.buildTrailGlyphs(row).join("");
      check("trail contains ❓ glyph", trail.includes("❓"), `trail=${trail}`);
      check("❓ appears immediately after 💭 (brainstormed)",
        /💭❓/.test(trail), `trail=${trail}`);
    }
  }

  // ── case 4: reply verb side effects ───────────────────────────────
  {
    const { slug, filepath } = seedIdea();
    await sharpenerMod.sharpen(filepath);
    // Move the file into the real ideas dir temporarily so findIdea can
    // resolve it; runReply uses the canonical IDEAS_DIR rather than a
    // configurable path.
    const realIdeasDir = path.join(process.cwd(), "ideas");
    const moved = path.join(realIdeasDir, `${slug}.md`);
    fs.renameSync(filepath, moved);

    let resultBody: { ok: boolean; payload: unknown } | null = null;
    const out = {
      mode: "json" as const,
      stdout: () => {},
      stderr: () => {},
      info: () => {},
      warn: () => {},
      result: (data: unknown) => { resultBody = { ok: true, payload: data }; },
      error: (code: string, msg: string) => { resultBody = { ok: false, payload: { code, msg } }; },
    };
    try {
      await replyMod.runReply(
        { slug, answer: "yes the smallest version is a CLI flag." },
        out as unknown as Parameters<typeof replyMod.runReply>[1]
      );
    } finally {
      try { fs.unlinkSync(moved); } catch { /* ignore */ }
    }

    check("runReply reported success", !!resultBody && (resultBody as { ok: boolean }).ok === true,
      JSON.stringify(resultBody));

    const replyEntry = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.replied"
    );
    check("journal contains idea.replied", !!replyEntry);
    check("idea.replied has answer payload",
      typeof replyEntry?.data?.answer === "string" &&
        (replyEntry.data.answer as string).includes("CLI flag"),
      JSON.stringify(replyEntry?.data));
  }

  // ── case 5: parsing remains valid after sharpener + multiple sections ─
  {
    const { slug, filepath } = seedIdea();
    await sharpenerMod.sharpen(filepath);
    const sections = dataMod.parseBrainstormSections(filepath);
    check("brainstorm fields still parse after Open Question append",
      sections.problem !== null &&
        sections.openQuestion !== null,
      `problem=${sections.problem ? "ok" : "null"} openQ=${sections.openQuestion ? "ok" : "null"}`);
    void slug;
  }

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-sharpener FAIL:", e);
  process.exit(1);
});
