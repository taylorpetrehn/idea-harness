/**
 * scripts/commands/_dashboard/_smoke_live.ts
 *
 * Live-tail smoke: spin up a synthetic run dir with a streaming
 * events.ndjson, mount the dashboard against it, append events on a
 * timer, capture frames at intervals, and assert the IN FLIGHT zone
 * picks up new lines without remount.
 *
 *   tsx scripts/commands/_dashboard/_smoke_live.ts
 *
 * Cleans up the temp run dir on exit so re-running this doesn't leave
 * orphan ghosts in runs/.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const { listIdeas } = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const { readJournal } = req("../../lib/journal") as typeof import("../../lib/journal");

  const ink = await import("ink");
  const dashboardMod = await import("./index");
  const dataMod = await import("./data");

  const ROOT = path.join(process.cwd());
  const RUNS_DIR = path.join(ROOT, "runs");
  const IDEAS_DIR = path.join(ROOT, "ideas");

  // Synthetic run.
  const runId = "_smoke-" + Date.now();
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "started.json"),
    JSON.stringify({
      id: runId,
      trigger: "smoke",
      startedAt: new Date().toISOString(),
      flags: { slug: "synthetic-smoke" },
    }),
    "utf8"
  );
  const eventsPath = path.join(runDir, "events.ndjson");
  fs.writeFileSync(eventsPath, "", "utf8");

  let stop = false;
  const cleanup = () => {
    stop = true;
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const seq = [
    { type: "build.spawn", data: { slug: "synthetic-smoke", cmd: "claude code --resume" } },
    { type: "build.stdout", data: { slug: "synthetic-smoke", chunk: "reading project context…" } },
    { type: "build.stdout", data: { slug: "synthetic-smoke", chunk: "drafting plan from brainstorm.md" } },
    { type: "build.stdout", data: { slug: "synthetic-smoke", chunk: "12 passed, 0 failed" } },
    { type: "build.pr_url", data: { slug: "synthetic-smoke", url: "https://example.com/pr/42" } },
    { type: "build.exit",   data: { slug: "synthetic-smoke", exit_code: 0, pr_url: "https://example.com/pr/42" } },
  ];

  const append = (i: number) => {
    if (stop) return;
    const evt = {
      schema: "harness/v1",
      verb: "build.start",
      ts: new Date().toISOString(),
      ...seq[i],
    };
    fs.appendFileSync(eventsPath, JSON.stringify(evt) + "\n", "utf8");
  };

  // Render harness
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      frames.push(chunk.toString());
      cb();
    },
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

  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: IDEAS_DIR,
      callbacks: { onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {} },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  // Timeline: append a new line every 600ms, capture a frame after each.
  const checkpoints: { afterAppendIdx: number; pickedFrame: string }[] = [];
  for (let i = 0; i < seq.length; i++) {
    append(i);
    await new Promise((r) => setTimeout(r, 600));
    // Frame snapshot
    let pick = "";
    for (const f of frames) if (f.length > pick.length) pick = f;
    checkpoints.push({ afterAppendIdx: i, pickedFrame: pick });
  }
  // One final tick so the live state catches up
  await new Promise((r) => setTimeout(r, 600));

  inst.unmount();

  // Assertions — search the union of all frames captured during the run.
  // Ink emits dozens of partial writes per second; the property we want is
  // "did the live tail ever surface the streamed events," not "is one
  // particular frame the latest."
  const allText = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  process.stderr.write(`smoke-live: ${frames.length} frames captured across ${seq.length} appends\n`);

  let pass = true;
  const check = (name: string, ok: boolean) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}\n`);
    if (!ok) pass = false;
  };

  check("synthetic-smoke run visible in IN FLIGHT",
    /IN FLIGHT[\s\S]*synthetic-smoke/i.test(allText));
  check("streamed event types rendered (stdout)",
    /build\.stdout/.test(allText));
  check("final event reached the screen (build.exit or pr_url)",
    /build\.(exit|pr_url)/.test(allText));
  check("build verb label visible",
    /build · synthetic-smoke/.test(allText));
  check("event count increased past 1",
    /[2-9] ev/.test(allText));

  if (process.argv.includes("--print")) {
    // Print the largest frame (best representation of a settled view).
    let pick = "";
    for (const f of frames) if (f.length > pick.length) pick = f;
    process.stdout.write(pick.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") + "\n");
  }

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-live FAIL:", e);
  process.exit(1);
});
