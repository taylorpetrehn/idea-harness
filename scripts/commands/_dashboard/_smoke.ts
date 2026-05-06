/**
 * scripts/commands/_dashboard/_smoke.ts
 *
 * Render-one-frame smoke test against current ideas/ + runs/. Mounts the
 * Dashboard with a captured stdout, lets it tick once, prints the last
 * frame stripped of ANSI, and exits. Use:
 *
 *   tsx scripts/commands/_dashboard/_smoke.ts
 *
 * The dashboard verb is TTY-only, so this is the easiest way to inspect
 * layout against real data without starting an interactive session.
 */

import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  // tsx loads this file as ESM; lib/* are CJS. Use createRequire so we
  // can reach them with named accessors regardless. Inside the verb (CJS)
  // top-level imports work fine — this gymnastics is only for the smoke.
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const { listIdeas } = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const { readJournal } = req("../../lib/journal") as typeof import("../../lib/journal");

  const ink = await import("ink");
  const dashboardMod = await import("./index");
  const dataMod = await import("./data");

  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) { frames.push(chunk.toString()); cb(); },
  }) as unknown as NodeJS.WriteStream;
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 40;

  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: () => unknown }).setRawMode = () => stdin;
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  (stdin as unknown as { resume: () => void }).resume = () => {};
  (stdin as unknown as { pause: () => void }).pause = () => {};

  const path = await import("path");
  const ROOT = path.join(process.cwd());
  const RUNS_DIR = path.join(ROOT, "runs");
  const IDEAS_DIR = path.join(ROOT, "ideas");

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

  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: IDEAS_DIR,
      callbacks: {
        onAccept: () => {},
        onReject: () => {},
        onNeedsMoreThought: () => {},
      },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  setTimeout(() => {
    inst.unmount();
    process.stderr.write(`smoke: ${frames.length} frames captured\n`);
    // Pick the largest frame — Ink emits clear sequences and partials too.
    let pick = "";
    for (const f of frames) if (f.length > pick.length) pick = f;
    if (!pick) {
      process.stderr.write("smoke: NO FRAMES — Ink did not render\n");
      process.exit(2);
    }
    const clean = pick.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    process.stdout.write(clean + "\n");
    process.exit(0);
  }, 800);
}

main().catch((e) => {
  console.error("smoke FAIL:", e);
  process.exit(1);
});
