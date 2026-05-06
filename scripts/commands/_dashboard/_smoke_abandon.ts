/**
 * scripts/commands/_dashboard/_smoke_abandon.ts
 *
 * `x` on a stalled flight row writes summary.json and the run drops
 * out of IN FLIGHT. Asserts:
 *
 *   1. Pressing `x` while cursor is on a stalled run calls
 *      onAbandonRun with the right runId.
 *   2. Pressing `x` while cursor is on a fresh (non-stalled) row
 *      does NOT call onAbandonRun (gated correctly).
 *   3. The verb-side abandonRunFromDashboard helper writes a
 *      summary.json with the right shape (status: complete,
 *      outcome: crashed, abandoned_from: dashboard).
 *   4. After abandon, scanActiveRuns no longer surfaces the run.
 *
 * Cleans up both run dirs on exit.
 */

import * as fs from "fs";
import * as path from "path";
import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  const ink = await import("ink");
  const dashboardMod = await import("./index");
  const dataMod = await import("./data");

  const ROOT = process.cwd();
  const RUNS_DIR = path.join(ROOT, "runs");
  const IDEAS_DIR = path.join(ROOT, "ideas");

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // Verb-side abandon helper (extracted from dashboard.ts so we can
  // test the file-write logic directly without spawning the verb).
  const abandonRun = (runId: string): { ok: boolean; message?: string } => {
    const dir = path.join(RUNS_DIR, runId);
    if (!fs.existsSync(dir)) return { ok: false, message: "run dir not found" };
    const summaryPath = path.join(dir, "summary.json");
    if (fs.existsSync(summaryPath)) return { ok: false, message: "already finalized" };
    let startedAt = new Date().toISOString();
    let slug: string | null = null;
    try {
      const started = JSON.parse(fs.readFileSync(path.join(dir, "started.json"), "utf8"));
      if (typeof started.startedAt === "string") startedAt = started.startedAt;
      if (typeof started.flags?.slug === "string") slug = started.flags.slug;
    } catch { /* ignore */ }
    const finishedAt = new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify({
      status: "complete", slug, intent: "abandoned", outcome: "crashed",
      run_id: runId, started_at: startedAt, finished_at: finishedAt,
      duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      abandoned_from: "dashboard",
    }, null, 2), "utf8");
    return { ok: true };
  };

  const ts = Date.now();
  const stalledId = `_smoke-abandon-stalled-${ts}`;
  const freshId = `_smoke-abandon-fresh-${ts}`;

  const writeRun = (id: string, eventTs: string) => {
    const dir = path.join(RUNS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "started.json"),
      JSON.stringify({ id, trigger: "smoke", startedAt: eventTs, flags: { slug: id } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      JSON.stringify({ schema: "harness/v1", verb: "build.start", ts: eventTs, type: "build.spawn", data: { slug: id } }) + "\n",
      "utf8"
    );
    return dir;
  };

  const stalledDir = writeRun(stalledId, new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const freshDir = writeRun(freshId, new Date().toISOString());

  const cleanup = () => {
    try { fs.rmSync(stalledDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(freshDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  // ── case 1: x on stalled row triggers abandon ─────────────────────
  process.stderr.write("--- case 1: x on stalled row ---\n");
  {
    const abandonCalls: string[] = [];
    const { stdout, stdin } = mkStreams();
    const snapshot = () => ({
      ideas: [], runs: dataMod.scanActiveRuns(RUNS_DIR), today: [],
    });

    // Stalled run sorts FIRST since its startedAt is older (10min ago).
    // Wait — newest first. Fresh has startedAt = now (newer). So fresh
    // is at index 0, stalled at index 1. Need to navigate down once.
    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(),
        refresh: snapshot,
        ideasDir: IDEAS_DIR,
        callbacks: {
          onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
          onCapture: () => null, onSpawnVerb: () => ({ detached: false }),
          onAbandonRun: (runId: string) => {
            abandonCalls.push(runId);
            return abandonRun(runId);
          },
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 300));
    // Move down to stalled (j = vim down)
    (stdin as unknown as Readable).push("j");
    await new Promise((r) => setTimeout(r, 200));
    // Press x
    (stdin as unknown as Readable).push("x");
    await new Promise((r) => setTimeout(r, 300));
    inst.unmount();

    check("onAbandonRun called once", abandonCalls.length === 1,
      `got ${abandonCalls.length} calls: ${abandonCalls.join(",")}`);
    check("onAbandonRun called with stalled runId",
      abandonCalls[0] === stalledId,
      `got ${abandonCalls[0]}`);

    const summaryPath = path.join(stalledDir, "summary.json");
    check("summary.json written", fs.existsSync(summaryPath));
    if (fs.existsSync(summaryPath)) {
      const sum = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      check("summary status is complete", sum.status === "complete");
      check("summary outcome is crashed", sum.outcome === "crashed");
      check("summary intent is abandoned", sum.intent === "abandoned");
      check("summary marked abandoned_from: dashboard",
        sum.abandoned_from === "dashboard");
    }

    // After abandon, scanActiveRuns no longer surfaces the stalled run.
    const stillActive = dataMod.scanActiveRuns(RUNS_DIR).find(
      (r) => r.runId === stalledId
    );
    check("abandoned run no longer in scanActiveRuns", !stillActive);
  }

  // ── case 2: x on fresh (non-stalled) row is gated ─────────────────
  process.stderr.write("--- case 2: x on fresh row is gated ---\n");
  {
    const abandonCalls: string[] = [];
    const { stdout, stdin } = mkStreams();
    const snapshot = () => ({
      ideas: [], runs: dataMod.scanActiveRuns(RUNS_DIR), today: [],
    });

    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(),
        refresh: snapshot,
        ideasDir: IDEAS_DIR,
        callbacks: {
          onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
          onCapture: () => null, onSpawnVerb: () => ({ detached: false }),
          onAbandonRun: (runId: string) => {
            abandonCalls.push(runId);
            return abandonRun(runId);
          },
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );

    // Cursor starts on index 0 = fresh run. Press x — should be gated.
    await new Promise((r) => setTimeout(r, 300));
    (stdin as unknown as Readable).push("x");
    await new Promise((r) => setTimeout(r, 200));
    inst.unmount();

    check("x on fresh row did NOT call onAbandonRun",
      abandonCalls.length === 0,
      `got ${abandonCalls.length} unexpected calls`);

    // Fresh run still has no summary.json
    const freshSummary = path.join(freshDir, "summary.json");
    check("fresh run has no summary.json", !fs.existsSync(freshSummary));
  }

  cleanup();
  process.exit(pass ? 0 : 1);
}

function mkStreams() {
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

  return { stdout, stdin };
}

main().catch((e) => {
  console.error("smoke-abandon FAIL:", e);
  process.exit(1);
});
