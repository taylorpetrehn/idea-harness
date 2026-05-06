/**
 * scripts/commands/_dashboard/_smoke_autoflow.ts
 *
 * Phase 1 (Auto-flow) regression. Asserts that:
 *
 *   1. `accept` + `high` verdict + `IDEA_HARNESS_AUTO_FLOW=true` →
 *      idea status flips to `accepted`, journal records both
 *      `idea.status` and `idea.auto_flowed`, and the dashboard
 *      lifecycle entry carries `autoFlowed: true` with `⚡` in the
 *      rendered trail glyphs.
 *   2. `reject` + `high` → status flips to `rejected`.
 *   3. `accept` + `medium` → stays `brainstormed`.
 *   4. `needs-more-thought` + `high` → stays `brainstormed`.
 *   5. Flag unset / "false" → no auto-flow regardless of verdict.
 *
 * Pure file-and-journal level test — does not boot the brainstormer
 * (no LLM call) or the dashboard React tree. We seed a minimal idea
 * file in a temp dir and call the exported `maybeAutoFlow` helper
 * directly.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface CheckCtx { pass: boolean; }

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const { maybeAutoFlow } = req("../../agents/brainstormer") as
    typeof import("../../agents/brainstormer");
  const { setStatusInFile } = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const { readJournal, purgeJournalForSlug } = req("../../lib/journal") as
    typeof import("../../lib/journal");
  const dataMod = await import("./data");
  const indexMod = await import("./index");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-autoflow-"));
  const seededSlugs: string[] = [];

  const cleanup = () => {
    for (const slug of seededSlugs) {
      try { purgeJournalForSlug(slug); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const ctx: CheckCtx = { pass: true };
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) ctx.pass = false;
  };

  // ── helpers ────────────────────────────────────────────────────────

  const verdictBody = (action: string, confidence: string) =>
    `### Verdict\n\n` +
    `**Recommended action:** ${action}\n` +
    `**Confidence:** ${confidence}\n` +
    `**Why:** synthetic test fixture — verdict drives the auto-flow gate.\n` +
    `**If accepted, build:** the simplest version.\n`;

  let counter = 0;
  const seedIdea = (action: string, confidence: string): { slug: string; filepath: string; body: string } => {
    counter += 1;
    const slug = `autoflow-smoke-${Date.now()}-${counter}`;
    seededSlugs.push(slug);
    const filepath = path.join(tmpRoot, `${slug}.md`);
    const body = verdictBody(action, confidence);
    const content =
      `---\n` +
      `id: ${counter.toString(16).padStart(8, "0")}\n` +
      `title: "Auto-flow probe ${counter}"\n` +
      `status: raw\n` +
      `source: smoke\n` +
      `project: letsbarker\n` +
      `captured_at: ${new Date().toISOString()}\n` +
      `brainstormed_at: ~\n` +
      `decided_at: ~\n` +
      `github_issue: ~\n` +
      `github_pr: ~\n` +
      `loop_count: 0\n` +
      `---\n\n` +
      `## Raw Idea\n\nProbe.\n\n## Brainstorm\n\n${body}\n`;
    fs.writeFileSync(filepath, content, "utf8");
    setStatusInFile(filepath, "brainstormed");
    return { slug, filepath, body };
  };

  const readStatus = (filepath: string): string => {
    const content = fs.readFileSync(filepath, "utf8");
    return content.match(/^status:\s*(.+)$/m)?.[1].trim() ?? "";
  };

  const since = new Date(Date.now() - 60 * 1000);

  // ── case 1: accept + high → accepted ───────────────────────────────
  {
    const prior = process.env.IDEA_HARNESS_AUTO_FLOW;
    process.env.IDEA_HARNESS_AUTO_FLOW = "true";
    const { slug, filepath, body } = seedIdea("accept", "high");
    maybeAutoFlow(filepath, body);
    process.env.IDEA_HARNESS_AUTO_FLOW = prior ?? "";

    check("accept+high → status:accepted", readStatus(filepath) === "accepted",
      `got ${readStatus(filepath)}`);

    const entries = readJournal({ since }).filter((e) => e.slug === slug);
    const autoEntry = entries.find((e) => e.type === "idea.auto_flowed");
    check("journal contains idea.auto_flowed for accept",
      !!autoEntry,
      `got types: ${entries.map((e) => e.type).join(", ")}`);
    check("idea.auto_flowed payload has from/to/verdict/confidence",
      !!autoEntry &&
      autoEntry.data?.from === "brainstormed" &&
      autoEntry.data?.to === "accepted" &&
      autoEntry.data?.verdict === "accept" &&
      autoEntry.data?.confidence === "high",
      JSON.stringify(autoEntry?.data));

    const note = fs.readFileSync(filepath, "utf8");
    check("auto-flow note appended to body",
      /Auto-flowed by brainstorm \(verdict: accept, confidence: high\)/.test(note));

    // Dashboard side: lifecycle entry should carry autoFlowed=true and the
    // rendered trail should contain ⚡ before ✓.
    const ideaSummary = {
      filename: `${slug}.md`,
      slug,
      id: "x",
      title: `Auto-flow probe`,
      status: "accepted" as const,
      project: "letsbarker",
      captured_at: new Date(Date.now() - 5_000).toISOString(),
      brainstormed_at: new Date(Date.now() - 4_000).toISOString(),
      decided_at: new Date(Date.now() - 3_000).toISOString(),
      github_issue: "",
      github_pr: "",
      loop_count: 0,
    };
    const lifecycle = dataMod.buildTodayLifecycle([ideaSummary], entries, {
      windowMs: 60 * 60 * 1000,
    });
    const row = lifecycle.find((r) => r.slug === slug);
    check("lifecycle entry built for accepted slug", !!row);
    check("lifecycle entry carries autoFlowed=true", row?.autoFlowed === true);
    if (row) {
      const trail = indexMod.buildTrailGlyphs(row).join("");
      check("trail contains ⚡ glyph", trail.includes("⚡"), `trail=${trail}`);
      check("⚡ appears immediately before ✓ (accepted)",
        /⚡✓/.test(trail), `trail=${trail}`);
    }
  }

  // ── case 2: reject + high → rejected ───────────────────────────────
  {
    const prior = process.env.IDEA_HARNESS_AUTO_FLOW;
    process.env.IDEA_HARNESS_AUTO_FLOW = "true";
    const { slug, filepath, body } = seedIdea("reject", "high");
    maybeAutoFlow(filepath, body);
    process.env.IDEA_HARNESS_AUTO_FLOW = prior ?? "";

    check("reject+high → status:rejected", readStatus(filepath) === "rejected",
      `got ${readStatus(filepath)}`);
    const auto = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.auto_flowed"
    );
    check("reject+high journal has idea.auto_flowed", !!auto);
    check("reject+high journal payload to=rejected",
      auto?.data?.to === "rejected", JSON.stringify(auto?.data));
  }

  // ── case 3: accept + medium → stays brainstormed ───────────────────
  {
    const prior = process.env.IDEA_HARNESS_AUTO_FLOW;
    process.env.IDEA_HARNESS_AUTO_FLOW = "true";
    const { slug, filepath, body } = seedIdea("accept", "medium");
    maybeAutoFlow(filepath, body);
    process.env.IDEA_HARNESS_AUTO_FLOW = prior ?? "";

    check("accept+medium stays brainstormed", readStatus(filepath) === "brainstormed",
      `got ${readStatus(filepath)}`);
    const auto = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.auto_flowed"
    );
    check("accept+medium → no idea.auto_flowed event", !auto);
  }

  // ── case 4: needs-more-thought + high → stays brainstormed ─────────
  {
    const prior = process.env.IDEA_HARNESS_AUTO_FLOW;
    process.env.IDEA_HARNESS_AUTO_FLOW = "true";
    const { slug, filepath, body } = seedIdea("needs-more-thought", "high");
    maybeAutoFlow(filepath, body);
    process.env.IDEA_HARNESS_AUTO_FLOW = prior ?? "";

    check("needs-more-thought+high stays brainstormed",
      readStatus(filepath) === "brainstormed", `got ${readStatus(filepath)}`);
    const auto = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.auto_flowed"
    );
    check("needs-more-thought+high → no idea.auto_flowed event", !auto);
  }

  // ── case 5: flag unset → no auto-flow regardless ──────────────────
  {
    const prior = process.env.IDEA_HARNESS_AUTO_FLOW;
    delete process.env.IDEA_HARNESS_AUTO_FLOW;
    const { slug, filepath, body } = seedIdea("accept", "high");
    maybeAutoFlow(filepath, body);
    process.env.IDEA_HARNESS_AUTO_FLOW = prior ?? "";

    check("flag unset + accept+high → stays brainstormed",
      readStatus(filepath) === "brainstormed", `got ${readStatus(filepath)}`);
    const auto = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.auto_flowed"
    );
    check("flag unset → no idea.auto_flowed event", !auto);
  }

  // ── case 5b: flag explicitly "false" → no auto-flow ───────────────
  {
    const prior = process.env.IDEA_HARNESS_AUTO_FLOW;
    process.env.IDEA_HARNESS_AUTO_FLOW = "false";
    const { slug, filepath, body } = seedIdea("accept", "high");
    maybeAutoFlow(filepath, body);
    process.env.IDEA_HARNESS_AUTO_FLOW = prior ?? "";

    check("flag=false + accept+high → stays brainstormed",
      readStatus(filepath) === "brainstormed", `got ${readStatus(filepath)}`);
    const auto = readJournal({ since }).find(
      (e) => e.slug === slug && e.type === "idea.auto_flowed"
    );
    check("flag=false → no idea.auto_flowed event", !auto);
  }

  cleanup();
  process.exit(ctx.pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-autoflow FAIL:", e);
  process.exit(1);
});
