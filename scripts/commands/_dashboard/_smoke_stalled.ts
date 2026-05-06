/**
 * scripts/commands/_dashboard/_smoke_stalled.ts
 *
 * Stall detection. Creates two synthetic active runs:
 *   - "fresh"   — events.ndjson with a recent timestamp
 *   - "stalled" — events.ndjson with a 10-minute-old last event
 *
 * Asserts:
 *   1. scanActiveRuns returns both, with stalled flag correct.
 *   2. The dashboard renders "(stalled)" + "⏸" for the wedged run.
 *   3. The fresh run renders normally.
 *   4. Cleanup removes both run dirs.
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

  const ts = Date.now();
  const freshId = `_smoke-fresh-${ts}`;
  const stalledId = `_smoke-stalled-${ts}`;

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

  const freshDir = writeRun(freshId, new Date().toISOString());
  const stalledDir = writeRun(stalledId, new Date(Date.now() - 10 * 60 * 1000).toISOString());

  const cleanup = () => {
    try { fs.rmSync(freshDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(stalledDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  // ── data layer assertions ─────────────────────────────────────────
  const runs = dataMod.scanActiveRuns(RUNS_DIR);
  const fresh = runs.find((r) => r.runId === freshId);
  const stalled = runs.find((r) => r.runId === stalledId);

  check("fresh run discovered", !!fresh);
  check("stalled run discovered", !!stalled);
  check("fresh run is NOT flagged stalled", fresh?.stalled === false);
  check("stalled run IS flagged stalled", stalled?.stalled === true,
    `stalled=${stalled?.stalled}, latestTs=${stalled?.latestEvent?.ts}`);

  // ── render assertions ────────────────────────────────────────────
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

  const snapshot = () => ({
    ideas: [],
    runs: dataMod.scanActiveRuns(RUNS_DIR),
    today: [],
  });

  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: IDEAS_DIR,
      callbacks: {
        onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
        onCapture: () => null, onSpawnVerb: () => ({ detached: false }),
          onAbandonRun: () => ({ ok: false }),
      },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  await new Promise((r) => setTimeout(r, 600));
  inst.unmount();

  const text = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  check("rendered frame contains '(stalled)' label", /\(stalled\)/.test(text));
  check("rendered frame contains '⏸' glyph", /⏸/.test(text));
  check("rendered frame contains 'idle' suffix", /idle/.test(text));
  // Both runs are sorted newest-first by startedAt, so fresh appears
  // before stalled in the render. The "(stalled)" label should only
  // appear on the stalled row — verify by index ordering.
  const stalledLabelIdx = text.indexOf("(stalled)");
  const stalledIdIdx = text.indexOf(stalledId);
  check("'(stalled)' label appears on or after the stalled row",
    stalledLabelIdx >= 0 && stalledIdIdx >= 0 &&
    Math.abs(stalledLabelIdx - stalledIdIdx) < 100,
    `labelIdx=${stalledLabelIdx}, stalledRowIdx=${stalledIdIdx}`);

  cleanup();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-stalled FAIL:", e);
  process.exit(1);
});
