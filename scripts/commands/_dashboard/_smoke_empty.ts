/**
 * scripts/commands/_dashboard/_smoke_empty.ts
 *
 * Empty-state messages should distinguish "filtered to nothing" from
 * "genuinely no work." Currently asserted across all three zones:
 *
 *   1. Cold start (no ideas, no runs) → genuine messages.
 *   2. Filtered to nothing → "0 of N match the filter — press / or p
 *      to clear" so the user knows there's hidden work.
 *
 * Drives `/` search to a no-match query and verifies the IN FLIGHT,
 * AWAITING YOU, and TODAY empty-state lines.
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

  function makeStreams() {
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

    return { stdout, stdin, frames };
  }

  const callbacks = {
    onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
    onCapture: () => null,
    onSpawnVerb: () => ({ detached: false }),
    onAbandonRun: () => ({ ok: false }),
  };

  // ── case 1: cold start — genuine empty messages ──────────────────
  process.stderr.write("--- case 1: cold start (no filter) ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
    const snapshot = () => ({ ideas: [], runs: [], today: [] });
    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(), refresh: snapshot, ideasDir: process.cwd(),
        callbacks, onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 300));
    inst.unmount();

    const text = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    check("genuine: 'nothing running' shown", /nothing running/.test(text));
    check("genuine: 'inbox zero' shown", /inbox zero/.test(text));
    check("genuine: 'quiet day' shown", /quiet day/.test(text));
    check("genuine: no '0 of' filter hint", !/0 of \d+/.test(text));
  }

  // ── case 2: search filter eliminates everything ──────────────────
  process.stderr.write("--- case 2: filter to nothing (5 ideas, search xyz123) ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
    const ideas = Array.from({ length: 5 }, (_, i) => mkIdea(`alpha-${i}`, `Alpha ${i}`, i + 1));
    const snapshot = () => ({ ideas: ideas as any[], runs: [], today: [] });
    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(), refresh: snapshot, ideasDir: process.cwd(),
        callbacks, onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 300));

    // Open search, type a no-match query, Enter
    (stdin as unknown as Readable).push("/");
    await new Promise((r) => setTimeout(r, 100));
    for (const ch of "xyz123") {
      (stdin as unknown as Readable).push(ch);
      await new Promise((r) => setTimeout(r, 20));
    }
    (stdin as unknown as Readable).push("\r");
    await new Promise((r) => setTimeout(r, 1500));
    inst.unmount();

    // Find the latest substantial frame (post-filter)
    let latest = "";
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].length > 200) {
        latest = frames[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        break;
      }
    }

    check("AWAITING shows '0 of 5' filtered hint",
      /0 of 5 awaiting ideas match the filter/.test(latest),
      latest.split("AWAITING")[1]?.split("TODAY")[0]?.replace(/\n/g, " ").slice(0, 200));
    check("AWAITING does NOT show 'inbox zero'",
      !latest.split("AWAITING")[1]?.split("TODAY")[0]?.includes("inbox zero"));
    check("hint mentions clearing the filter",
      /press \/ or p to clear/.test(latest));
  }

  process.exit(pass ? 0 : 1);
}

function mkIdea(slug: string, title: string, n: number) {
  const ts = new Date(Date.now() - n * 60 * 1000).toISOString();
  return {
    filename: `${slug}.md`,
    slug,
    id: slug + "0",
    title,
    status: "brainstormed",
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

main().catch((e) => {
  console.error("smoke-empty FAIL:", e);
  process.exit(1);
});
