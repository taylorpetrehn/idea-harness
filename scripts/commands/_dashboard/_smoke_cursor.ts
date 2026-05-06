/**
 * scripts/commands/_dashboard/_smoke_cursor.ts
 *
 * Cursor stickiness across mutations. Sets up two awaiting ideas,
 * navigates the cursor onto the second one, simulates accepting the
 * FIRST one (mutates the dataset out from under the cursor), and
 * asserts the cursor stays on the same logical idea — not on whatever
 * happens to be at the prior numeric index.
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

  // Three awaiting ideas: alpha, bravo, charlie. We'll cursor onto
  // `bravo`, then accept `alpha` (which removes it from awaiting), and
  // verify the cursor stays on bravo.
  const baseIdeas = [
    mkIdea("alpha",   "Alpha probe",   "brainstormed", 1),
    mkIdea("bravo",   "Bravo probe",   "brainstormed", 2),
    mkIdea("charlie", "Charlie probe", "brainstormed", 3),
  ];
  let ideas: any[] = [...baseIdeas];

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

  const snapshot = () => ({ ideas, runs: [], today: [] });

  const acceptCalls: string[] = [];
  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: process.cwd(),
      callbacks: {
        onAccept: (slug: string) => {
          acceptCalls.push(slug);
          ideas = ideas.map((i) => i.slug === slug ? { ...i, status: "accepted" } : i);
        },
        onReject: () => {},
        onNeedsMoreThought: () => {},
        onCapture: () => null,
        onSpawnVerb: () => ({ detached: false }),
          onAbandonRun: () => ({ ok: false }),
      },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  // Wait for first paint
  await new Promise((r) => setTimeout(r, 300));

  // Move cursor down once → now on bravo (alpha is at index 0, bravo at 1).
  // Use `j` (vim-style down) which Ink parses as a plain character key —
  // avoids the escape-sequence ambiguity of \x1b[B over a synthetic stdin.
  (stdin as unknown as Readable).push("j");
  await new Promise((r) => setTimeout(r, 200));

  let mark = frames.length;
  const sliceText = (start: number) =>
    frames.slice(start).join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Latest converged frame. Ink overwrites the screen each tick; once
  // the dashboard settles, the most recent substantial frame is what
  // the user actually sees on the terminal. Picking the LAST frame
  // larger than a threshold filters out single-byte cursor moves.
  const latestText = (start: number) => {
    const sl = frames.slice(start);
    for (let i = sl.length - 1; i >= 0; i--) {
      if (sl[i].length > 200) return sl[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    }
    return sliceText(start);
  };

  // Initial cursor position check.
  const beforeMutate = sliceText(0);
  check("cursor moved onto bravo (▸ before Bravo)",
    /▸ ▲ Bravo probe/.test(beforeMutate));

  // Out-of-band mutation: a sibling process / timer flips alpha to
  // accepted. Items reshuffle. Cursor must still follow bravo by
  // logical id, not by the prior numeric index (which would now
  // point at charlie since alpha was removed).
  mark = frames.length;
  ideas = ideas.map((i) => i.slug === "alpha" ? { ...i, status: "accepted" } : i);
  await new Promise((r) => setTimeout(r, 1500));

  const afterMutate = latestText(mark);
  // Carve just the AWAITING YOU block out of the rendered frame; alpha
  // legitimately reappears in NEXT bar after being accepted, so a
  // whole-frame regex would false-fail there.
  const awaitBlock = (text: string) => {
    const start = text.indexOf("AWAITING YOU");
    if (start < 0) return "";
    const rest = text.slice(start);
    const end = rest.indexOf("TODAY");
    return end < 0 ? rest : rest.slice(0, end);
  };
  check("after alpha removed, cursor still on bravo",
    /▸ ▲ Bravo probe/.test(afterMutate));
  check("alpha no longer in AWAITING YOU section",
    !/Alpha probe/.test(awaitBlock(afterMutate)));
  check("charlie still visible",
    /Charlie probe/.test(afterMutate));

  // Press `a` to accept bravo (the currently selected idea). Cursor
  // should slide to charlie since bravo's gone.
  mark = frames.length;
  (stdin as unknown as Readable).push("a");
  await new Promise((r) => setTimeout(r, 1500));

  check("`a` triggered accept callback for bravo",
    acceptCalls.includes("bravo"));

  const afterAccept = latestText(mark);
  check("after accepting bravo, cursor slid to charlie",
    /▸ ▲ Charlie probe/.test(afterAccept));
  check("bravo no longer in AWAITING YOU section",
    !/Bravo probe/.test(awaitBlock(afterAccept)));

  inst.unmount();
  process.exit(pass ? 0 : 1);
}

function mkIdea(slug: string, title: string, status: string, n: number) {
  // Older capture_at on later items so newest-first sort puts alpha first.
  const ts = new Date(Date.now() - n * 60 * 1000).toISOString();
  return {
    filename: `${slug}.md`,
    slug,
    id: slug + "0",
    title,
    status,
    project: "letsbarker",
    captured_at: ts,
    brainstormed_at: ts,
    decided_at: "",
    github_issue: "",
    github_pr: "",
    loop_count: 0,
    recommended_action: "needs-more-thought" as const,
    confidence: "medium" as const,
  };
}

function pickLargest(frames: string[]): string {
  let pick = "";
  for (const f of frames) if (f.length > pick.length) pick = f;
  return pick.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

main().catch((e) => {
  console.error("smoke-cursor FAIL:", e);
  process.exit(1);
});
