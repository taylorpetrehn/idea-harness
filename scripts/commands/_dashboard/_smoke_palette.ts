/**
 * scripts/commands/_dashboard/_smoke_palette.ts
 *
 * Verb palette smoke. Opens the `:` palette, navigates with arrows,
 * presses Enter, asserts:
 *
 *   1. Pressing `:` opens the palette (renders "run a verb" header).
 *   2. All four palette options render (brainstorm, ship, doctor, cleanup).
 *   3. Up/Down moves the selection cursor.
 *   4. Enter calls onSpawnVerb with the selected verb.
 *   5. Esc closes the palette without calling onSpawnVerb.
 *   6. The dashboard surfaces a confirmation message after spawn.
 */

import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  const ink = await import("ink");
  const dashboardMod = await import("./index");

  const cols = 100;

  function makeStreams() {
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

    return { stdout, stdin, frames };
  }

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // ── case 1: open palette + navigate + select ─────────────────────
  process.stderr.write("--- case 1: open + navigate + Enter ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
    const spawnCalls: string[] = [];

    const snapshot = () => ({ ideas: [], runs: [], today: [] });

    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(),
        refresh: snapshot,
        ideasDir: process.cwd(),
        callbacks: {
          onAccept: () => {},
          onReject: () => {},
          onNeedsMoreThought: () => {},
          onCapture: () => null,
          onSpawnVerb: (v: string) => { spawnCalls.push(v); return { detached: true }; },
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 200));

    // Open palette
    (stdin as unknown as Readable).push(":");
    await new Promise((r) => setTimeout(r, 150));

    const afterOpen = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    check("palette opens on `:`", /run a verb/.test(afterOpen));
    check("brainstorm option renders", /brainstorm/.test(afterOpen));
    check("ship option renders", /\bship\b/.test(afterOpen));
    check("doctor option renders", /doctor/.test(afterOpen));
    check("cleanup option renders", /cleanup/.test(afterOpen));

    // Down once → ship
    (stdin as unknown as Readable).push("[B"); // down arrow
    await new Promise((r) => setTimeout(r, 100));

    // Enter → spawns ship
    (stdin as unknown as Readable).push("\r");
    await new Promise((r) => setTimeout(r, 200));

    inst.unmount();

    check("Enter triggered onSpawnVerb", spawnCalls.length === 1, `got ${spawnCalls.length}`);
    check("selected verb was ship (after one Down)",
      spawnCalls[0] === "ship", `got ${spawnCalls[0]}`);

    const finalText = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    check("dashboard shows post-spawn confirmation",
      /spawned harness ship/.test(finalText));
  }

  // ── case 2: Esc cancels without spawning ─────────────────────────
  process.stderr.write("--- case 2: Esc cancels ---\n");
  {
    const { stdout, stdin } = makeStreams();
    const spawnCalls: string[] = [];

    const snapshot = () => ({ ideas: [], runs: [], today: [] });

    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(),
        refresh: snapshot,
        ideasDir: process.cwd(),
        callbacks: {
          onAccept: () => {},
          onReject: () => {},
          onNeedsMoreThought: () => {},
          onCapture: () => null,
          onSpawnVerb: (v: string) => { spawnCalls.push(v); return { detached: true }; },
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 200));
    (stdin as unknown as Readable).push(":");
    await new Promise((r) => setTimeout(r, 100));
    (stdin as unknown as Readable).push(""); // Esc
    await new Promise((r) => setTimeout(r, 100));
    inst.unmount();

    check("Esc did not call onSpawnVerb", spawnCalls.length === 0);
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-palette FAIL:", e);
  process.exit(1);
});
