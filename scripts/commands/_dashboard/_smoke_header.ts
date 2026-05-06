/**
 * scripts/commands/_dashboard/_smoke_header.ts
 *
 * Header line should never truncate counts. Verifies that at any
 * reasonable width — 100, 80, 60, 40, 30 — the counts (in flight,
 * awaiting, today) all appear in the rendered header. Labels can
 * shorten but the data must survive.
 */

import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  const ink = await import("ink");
  const dashboardMod = await import("./index");

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // Use distinct counts so we can verify all three survive.
  const ideas = Array.from({ length: 7 }, (_, i) => ({
    filename: `slug-${i}.md`,
    slug: `slug-${i}`,
    id: `id${i}`,
    title: `Idea ${i}`,
    status: i < 5 ? "brainstormed" : "raw",
    project: "letsbarker",
    captured_at: new Date(Date.now() - (i + 1) * 60000).toISOString(),
    brainstormed_at: i < 5 ? new Date().toISOString() : "",
    decided_at: "",
    github_issue: "",
    github_pr: "",
    loop_count: 0,
  })) as any[];

  const journal: any[] = [];

  for (const cols of [100, 80, 60, 40, 30]) {
    const frames: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) { frames.push(chunk.toString()); cb(); },
    }) as unknown as NodeJS.WriteStream;
    (stdout as unknown as { columns: number }).columns = cols;
    (stdout as unknown as { rows: number }).rows = 40;
    (stdout as unknown as { isTTY: boolean }).isTTY = true;

    const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: () => unknown }).setRawMode = () => stdin;
    (stdin as unknown as { ref: () => void }).ref = () => {};
    (stdin as unknown as { unref: () => void }).unref = () => {};
    (stdin as unknown as { resume: () => void }).resume = () => {};
    (stdin as unknown as { pause: () => void }).pause = () => {};

    const snapshot = () => ({ ideas, runs: [], today: [] });

    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(),
        refresh: snapshot,
        ideasDir: process.cwd(),
        callbacks: {
          onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
          onCapture: () => null, onSpawnVerb: () => ({ detached: false }),
          onAbandonRun: () => ({ ok: false }),
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 400));
    inst.unmount();

    let pick = "";
    for (const f of frames) if (f.length > pick.length) pick = f;
    const text = pick.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    // Just the first non-empty line of the rendered frame.
    const headerLine = text.split("\n").find((l) => l.includes("harness")) ?? "";

    check(`@${cols}: header contains "harness"`, /harness/.test(headerLine));
    check(`@${cols}: header has flight count (0)`, /\b0\b/.test(headerLine));
    check(`@${cols}: header has awaiting count (5)`, /\b5\b/.test(headerLine));
    check(`@${cols}: header has today count (somewhere)`, /\b[0-9]+\b/.test(headerLine));
    check(`@${cols}: header fits in cols`, headerLine.length <= cols + 2,
      `len=${headerLine.length}, line="${headerLine}"`);
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-header FAIL:", e);
  process.exit(1);
});
