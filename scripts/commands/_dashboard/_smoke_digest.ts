/**
 * scripts/commands/_dashboard/_smoke_digest.ts
 *
 * Phase 4 (digest verb) regression. Asserts the rendered markdown
 * structure and the totals counter, against a synthetic journal
 * + idea fixture written to a temp dir.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Writable } from "stream";

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const digestMod = req("../digest") as typeof import("../digest");
  const { Output } = req("../../lib/output") as typeof import("../../lib/output");
  const ideasMod = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const journalMod = req("../../lib/journal") as typeof import("../../lib/journal");

  const realIdeasDir = path.join(process.cwd(), "ideas");
  const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), "harness-digest-"));
  const seededSlugs: string[] = [];

  const cleanup = () => {
    for (const slug of seededSlugs) {
      try { fs.unlinkSync(path.join(realIdeasDir, `${slug}.md`)); } catch { /* ignore */ }
      try { journalMod.purgeJournalForSlug(slug); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpRuns, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // Seed two ideas with backdated journal events on a known UTC day.
  // Use a date well before any plausible real journal entries so the
  // pre-existing harness journal can't pollute our totals.
  const date = "2099-01-01";
  const dayMid = new Date(`${date}T12:00:00.000Z`);
  let counter = 0;
  const seedIdea = (status: string): { slug: string; filepath: string } => {
    counter += 1;
    const slug = `digest-smoke-${Date.now()}-${counter}`;
    seededSlugs.push(slug);
    const filepath = path.join(realIdeasDir, `${slug}.md`);
    fs.writeFileSync(filepath,
      [
        "---",
        `id: ${counter.toString(16).padStart(8, "0")}`,
        `title: "Digest probe ${counter}"`,
        `status: ${status}`,
        "source: smoke",
        "project: letsbarker",
        `captured_at: ${dayMid.toISOString()}`,
        "brainstormed_at: ~",
        "decided_at: ~",
        "github_issue: ~",
        "github_pr: ~",
        "loop_count: 0",
        "---",
        "",
        "## Raw Idea",
        "",
        "Probe.",
        "",
      ].join("\n"),
      "utf8");
    return { slug, filepath };
  };

  const a = seedIdea("accepted");
  const b = seedIdea("rejected");

  // Manually append synthetic journal entries dated mid-day.
  journalMod.purgeJournalForSlug(a.slug);
  journalMod.purgeJournalForSlug(b.slug);
  // Use appendJournal so entries are real ndjson, but they'll get a
  // current-time ts. We can't easily backdate via appendJournal,
  // so we backdate by writing directly to the journal file.
  const journalPath = path.join(process.cwd(), "runs", "journal.ndjson");
  const stamp = (offsetMin: number) =>
    new Date(dayMid.getTime() + offsetMin * 60_000).toISOString();
  const lines = [
    JSON.stringify({ ts: stamp(0), type: "idea.captured", slug: a.slug, data: { title: "Probe A" } }),
    JSON.stringify({ ts: stamp(5), type: "idea.status", slug: a.slug, data: { from: "raw", to: "brainstormed" } }),
    JSON.stringify({ ts: stamp(6), type: "idea.auto_flowed", slug: a.slug, data: { from: "brainstormed", to: "accepted", verdict: "accept", confidence: "high" } }),
    JSON.stringify({ ts: stamp(7), type: "idea.status", slug: a.slug, data: { from: "brainstormed", to: "accepted" } }),
    JSON.stringify({ ts: stamp(15), type: "idea.captured", slug: b.slug, data: { title: "Probe B" } }),
    JSON.stringify({ ts: stamp(20), type: "idea.status", slug: b.slug, data: { from: "raw", to: "brainstormed" } }),
    JSON.stringify({ ts: stamp(25), type: "idea.sharpened", slug: b.slug, data: { question: "What is the smallest scope?" } }),
    JSON.stringify({ ts: stamp(30), type: "idea.status", slug: b.slug, data: { from: "brainstormed", to: "rejected" } }),
  ];
  fs.appendFileSync(journalPath, lines.join("\n") + "\n", "utf8");

  // Run digest.
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const out = new Output({
    mode: "json",
    verb: "digest",
    stdout: (s: string) => stdoutChunks.push(s),
    stderr: (s: string) => stderrChunks.push(s),
    color: false,
  });
  await digestMod.runDigest({ date, outDir: tmpRuns }, out);

  // Parse the envelope from stdout.
  const envelope = JSON.parse(stdoutChunks.join("")) as {
    ok: boolean;
    data: {
      date: string;
      outFile: string;
      totals: Record<string, number>;
      markdown: string;
    };
  };
  check("digest envelope ok", envelope.ok === true);
  check("digest date echoes", envelope.data.date === date);

  const t = envelope.data.totals;
  check("totals.captured === 2", t.captured === 2, `got ${t.captured}`);
  check("totals.brainstormed === 2", t.brainstormed === 2, `got ${t.brainstormed}`);
  check("totals.accepted === 1", t.accepted === 1, `got ${t.accepted}`);
  check("totals.rejected === 1", t.rejected === 1, `got ${t.rejected}`);
  check("totals.auto_flowed === 1", t.auto_flowed === 1, `got ${t.auto_flowed}`);
  check("totals.sharpened === 1", t.sharpened === 1, `got ${t.sharpened}`);

  const md = envelope.data.markdown;
  check("digest markdown has top heading", md.startsWith(`# Idea harness digest — ${date}`));
  check("markdown mentions auto-flow section", md.includes("## Auto-flowed"));
  check("markdown mentions open-questions section", md.includes("## Open questions raised"));
  check("markdown mentions captured section", md.includes("## Captured"));
  check("digest file written", fs.existsSync(envelope.data.outFile));
  if (fs.existsSync(envelope.data.outFile)) {
    const onDisk = fs.readFileSync(envelope.data.outFile, "utf8");
    check("on-disk matches envelope markdown", onDisk === md);
  }

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-digest FAIL:", e);
  process.exit(1);
});

void Writable;
