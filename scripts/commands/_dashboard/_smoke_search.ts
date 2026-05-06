/**
 * scripts/commands/_dashboard/_smoke_search.ts
 *
 * Verifies the `/` text-search workflow end-to-end:
 *
 *   1. Pressing `/` opens the search prompt.
 *   2. Typing live-narrows the prompt buffer (visible in the rendered
 *      frame).
 *   3. Pressing Enter applies the filter — only matching ideas remain
 *      in AWAITING YOU.
 *   4. The active filter is shown in the header chip (`/<query>`).
 *   5. Pressing `/` again resumes editing the existing filter.
 *   6. Empty input + Enter clears the filter, all ideas return.
 *
 * Skips the Esc-cancel path since synthetic stdin Esc bytes are
 * unreliable in the test harness — covered indirectly by the help
 * overlay smoke which uses the same key.escape branch.
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

  // Three brainstormed ideas with distinct titles. Search "bra" should
  // match only "Bravo" but not "Alpha" or "Charlie".
  const ideas = [
    mkIdea("alpha-x",   "Alpha probe",   1),
    mkIdea("bravo-x",   "Bravo probe",   2),
    mkIdea("charlie-x", "Charlie probe", 3),
  ];

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

  const snapshot = () => ({ ideas: ideas as any[], runs: [], today: [] });

  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: process.cwd(),
      callbacks: {
        onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
        onCapture: () => null, onSpawnVerb: () => ({ detached: false }),
      },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );

  await new Promise((r) => setTimeout(r, 300));

  const sliceText = (start: number) =>
    frames.slice(start).join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // Step 1: open search
  let mark = frames.length;
  (stdin as unknown as Readable).push("/");
  await new Promise((r) => setTimeout(r, 150));
  check("`/` opens the search prompt",
    /\/ /.test(sliceText(mark)) && /enter to apply/.test(sliceText(mark)));

  // Step 2: type "bra" — buffer should be visible in some frame
  mark = frames.length;
  for (const ch of "bra") {
    (stdin as unknown as Readable).push(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 200));
  const typingText = sliceText(mark);
  check("typed buffer visible (bra)",
    /\/ bra/.test(typingText) || /\/bra/.test(typingText),
    `slice tail: ${typingText.slice(-200).replace(/\n/g, "|")}`);

  // Step 3: Enter applies — only Bravo should remain
  mark = frames.length;
  (stdin as unknown as Readable).push("\r");
  await new Promise((r) => setTimeout(r, 1500));

  // Get the latest substantial frame to check the converged state
  const latest = (() => {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].length > 200) {
        return frames[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      }
    }
    return "";
  })();

  check("after Enter, Bravo is visible", /Bravo probe/.test(latest));
  check("after Enter, Alpha is filtered out", !/Alpha probe/.test(latest));
  check("after Enter, Charlie is filtered out", !/Charlie probe/.test(latest));
  check("header chip shows /bra", /\/bra/.test(latest));
  check("AWAITING YOU count is 1", /AWAITING YOU · 1/.test(latest));

  // Step 4: re-open search with `/` — buffer should be 'bra' again
  mark = frames.length;
  (stdin as unknown as Readable).push("/");
  await new Promise((r) => setTimeout(r, 200));
  const reopen = sliceText(mark);
  check("re-opening `/` shows existing filter as buffer",
    /\/ bra/.test(reopen) || /\/bra/.test(reopen));

  // Step 5: clear buffer with backspace ×3, then Enter clears filter
  for (let i = 0; i < 3; i++) {
    (stdin as unknown as Readable).push("\x7f"); // backspace (DEL)
    await new Promise((r) => setTimeout(r, 30));
  }
  mark = frames.length;
  (stdin as unknown as Readable).push("\r");
  await new Promise((r) => setTimeout(r, 1500));

  const cleared = (() => {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].length > 200) {
        return frames[i].replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      }
    }
    return "";
  })();
  check("after empty Enter, filter is cleared (Alpha back)",
    /Alpha probe/.test(cleared));
  check("after empty Enter, header chip /bra is gone",
    !/\/bra/.test(cleared));
  check("after empty Enter, AWAITING YOU count is back to 3",
    /AWAITING YOU · 3/.test(cleared));

  inst.unmount();
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
  console.error("smoke-search FAIL:", e);
  process.exit(1);
});
