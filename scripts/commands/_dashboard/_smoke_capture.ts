/**
 * scripts/commands/_dashboard/_smoke_capture.ts
 *
 * Inline-capture smoke. Mounts the dashboard, presses `c`, types a title,
 * presses Enter, and asserts:
 *
 *   1. The capture prompt renders while typing (live buffer visible).
 *   2. After Enter, a new idea file lands on disk in ideas/.
 *   3. The created idea has the correct title and a captured-from-dashboard
 *      source marker.
 *   4. The dashboard's TODAY zone picks it up on next refresh.
 *
 * Cleans up the test idea on exit so re-running doesn't leave clutter.
 */

import * as fs from "fs";
import * as path from "path";
import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const { listIdeas, createRawIdea } = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const { readJournal } = req("../../lib/journal") as typeof import("../../lib/journal");

  const ink = await import("ink");
  const dashboardMod = await import("./index");
  const dataMod = await import("./data");

  const ROOT = path.join(process.cwd());
  const RUNS_DIR = path.join(ROOT, "runs");
  const IDEAS_DIR = path.join(ROOT, "ideas");

  const TEST_TITLE = "Smoke capture probe " + Date.now();
  const createdSlugs: string[] = [];

  const cleanup = () => {
    for (const slug of createdSlugs) {
      const p = path.join(IDEAS_DIR, `${slug}.md`);
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) { frames.push(chunk.toString()); cb(); },
  }) as unknown as NodeJS.WriteStream;
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: () => unknown }).setRawMode = () => stdin;
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  (stdin as unknown as { resume: () => void }).resume = () => {};
  (stdin as unknown as { pause: () => void }).pause = () => {};

  const snapshot = () => {
    const ideas = listIdeas();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const journal = readJournal({ since });
    return {
      ideas,
      runs: dataMod.scanActiveRuns(RUNS_DIR),
      today: dataMod.buildTodayFeed(ideas, journal, { limit: 30 }),
    };
  };

  let lastFrameAtCaptureStart = 0;

  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: IDEAS_DIR,
      callbacks: {
        onAccept: () => {},
        onReject: () => {},
        onNeedsMoreThought: () => {},
        onCapture: (text: string) => {
          const created = createRawIdea({ title: text, project: "letsbarker", source: "dashboard" });
          createdSlugs.push(created.slug);
          return { slug: created.slug, project: created.project };
        },
      },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  // Wait for first render
  await new Promise((r) => setTimeout(r, 200));
  lastFrameAtCaptureStart = frames.length;

  // Press 'c' to enter capture mode
  (stdin as unknown as Readable).push("c");
  await new Promise((r) => setTimeout(r, 150));

  // Type title char-by-char so the buffer renders live
  for (const ch of TEST_TITLE) {
    (stdin as unknown as Readable).push(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 200));

  // Snapshot the mid-capture frames before pressing Enter
  const midCaptureText = frames
    .slice(lastFrameAtCaptureStart)
    .join("\n")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // Press Enter
  (stdin as unknown as Readable).push("\r");
  await new Promise((r) => setTimeout(r, 1200)); // refresh tick fires at 1s

  inst.unmount();

  let pass = true;
  const check = (name: string, ok: boolean) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}\n`);
    if (!ok) pass = false;
  };

  // 1. Capture prompt was rendered
  check("capture prompt visible during typing",
    /capture ›/.test(midCaptureText));
  check("typed title appears in buffer",
    midCaptureText.includes(TEST_TITLE.slice(0, 30)));

  // 2. Idea file landed on disk
  check("exactly one new idea file created", createdSlugs.length === 1);
  const slug = createdSlugs[0];
  const filepath = path.join(IDEAS_DIR, `${slug}.md`);
  check("idea file exists on disk", fs.existsSync(filepath));

  // 3. Frontmatter looks right
  if (fs.existsSync(filepath)) {
    const content = fs.readFileSync(filepath, "utf8");
    check("idea title matches typed text", content.includes(TEST_TITLE));
    check("idea source is 'dashboard'", /^source: dashboard$/m.test(content));
    check("idea status is 'raw'", /^status: raw$/m.test(content));
  } else {
    check("idea title matches typed text", false);
    check("idea source is 'dashboard'", false);
    check("idea status is 'raw'", false);
  }

  // 4. After Enter, all-frames concatenated should contain a confirmation
  // message with the new slug.
  const finalText = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  check("dashboard surfaced confirmation after capture",
    finalText.includes(slug ?? "no-slug"));

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-capture FAIL:", e);
  process.exit(1);
});
