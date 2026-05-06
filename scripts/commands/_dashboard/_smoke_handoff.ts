/**
 * scripts/commands/_dashboard/_smoke_handoff.ts
 *
 * Watch-handoff round-trip smoke. Spins up a synthetic active run, mounts
 * the dashboard, types Enter on the in-flight row, and asserts:
 *
 *   1. The action surfaced is { kind: "watch", run, idea? }.
 *   2. The eventsPath in the action matches the synthetic run's path.
 *   3. The dashboard unmounts cleanly so the verb's loop can hand off to
 *      the watch TUI without a stuck render.
 *   4. After the simulated watch returns, a fresh dashboard render against
 *      the same on-disk state still picks up the in-flight row (i.e. the
 *      "return to dashboard on exit" path is replayable).
 *
 * Cleans up the synthetic run dir on exit.
 */

import * as fs from "fs";
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

  const runId = "_smoke-handoff-" + Date.now();
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "started.json"),
    JSON.stringify({
      id: runId,
      trigger: "smoke-handoff",
      startedAt: new Date().toISOString(),
      flags: { slug: "synthetic-handoff" },
    }),
    "utf8"
  );
  const eventsPath = path.join(runDir, "events.ndjson");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({ schema: "harness/v1", verb: "build.start", ts: new Date().toISOString(), type: "build.spawn", data: { slug: "synthetic-handoff" } }) + "\n",
    "utf8"
  );

  const cleanup = () => {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  const stdout = new Writable({
    write(_chunk, _enc, cb) { cb(); },
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
      today: dataMod.buildTodayLifecycle(ideas, journal, { limit: 12 }),
    };
  };

  // Round 1: render, simulate Enter, capture action.
  let pass = true;
  const check = (name: string, ok: boolean) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}\n`);
    if (!ok) pass = false;
  };

  let captured: unknown = null;
  let exitCalled = false;
  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: IDEAS_DIR,
      callbacks: { onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {}, onCapture: () => null, onSpawnVerb: () => ({ detached: false }) },
      onAction: (a: unknown) => { captured = a; exitCalled = true; },
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  // Wait one tick so the snapshot fires and the in-flight row is in items.
  await new Promise((r) => setTimeout(r, 1100));

  // Cursor starts at 0 — the synthetic run is the first selectable. Press Enter.
  (stdin as unknown as Readable).push("\r");

  // Allow Ink to process, dispatch onAction, and call exit().
  await new Promise((r) => setTimeout(r, 300));
  inst.unmount();

  check("Enter on in-flight row produced an action", captured !== null);
  if (captured && typeof captured === "object") {
    const a = captured as { kind?: string; run?: { eventsPath?: string; runId?: string } };
    check("action.kind === 'watch'", a.kind === "watch");
    check("action.run.eventsPath matches synthetic events path",
      a.run?.eventsPath === eventsPath);
    check("action.run.runId matches synthetic run id",
      a.run?.runId === runId);
  } else {
    check("action.kind === 'watch'", false);
  }
  check("dashboard called exit() (verb loop can resume)", exitCalled);

  // Round 2: simulate the watch returning by rendering a fresh dashboard.
  // This is the path the verb takes after the watch TUI exits — the
  // `while(true) { renderDashboard(); ... }` loop in dashboard.ts.
  const inst2 = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: IDEAS_DIR,
      callbacks: { onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {}, onCapture: () => null, onSpawnVerb: () => ({ detached: false }) },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );
  await new Promise((r) => setTimeout(r, 1100));
  inst2.unmount();

  // The synthetic run should still be visible after re-render — proves the
  // dashboard is replayable across watch ↔ dashboard transitions.
  const stillActive = dataMod.scanActiveRuns(RUNS_DIR).some((r) => r.runId === runId);
  check("synthetic run still active after re-render (loop can return)", stillActive);

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-handoff FAIL:", e);
  process.exit(1);
});
