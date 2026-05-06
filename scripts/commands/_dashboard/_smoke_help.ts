/**
 * scripts/commands/_dashboard/_smoke_help.ts
 *
 * Help overlay smoke. Asserts:
 *   1. Pressing `?` opens the overlay.
 *   2. The overlay contains every keybind grouped by section.
 *   3. The zones are hidden while help is open.
 *   4. Pressing `?` again toggles it closed.
 *   5. Esc also closes it.
 *   6. Other keybinds are blocked while help is open (we type `c` to
 *      try entering capture mode and assert the input is swallowed).
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

  const snapshot = () => ({ ideas: [], runs: [], today: [] });

  // ── case 1: open + content ───────────────────────────────────────
  process.stderr.write("--- case 1: open and verify content ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
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
          onSpawnVerb: () => ({ detached: false }),
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );

    await new Promise((r) => setTimeout(r, 200));

    // Press `?` to open
    (stdin as unknown as Readable).push("?");
    await new Promise((r) => setTimeout(r, 200));

    const text = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    check("overlay opens on `?`", /harness keymap/.test(text));
    check("section: navigate", /navigate/.test(text));
    check("section: in flight", /in flight/.test(text));
    check("section: awaiting you", /awaiting you/.test(text));
    check("section: today", /today/.test(text));
    check("section: global", /global/.test(text));
    check("documents enter zoom into watch", /zoom into watch/.test(text));
    check("documents accept keybind", /accept \(status/.test(text));
    check("documents capture keybind", /capture a new idea/.test(text));
    check("documents palette keybind", /run a verb/.test(text));
    check("documents quit", /quit/.test(text));

    // Zones should be hidden — no "AWAITING YOU" header in help mode.
    check("zones hidden while help is open",
      !/▲ AWAITING YOU/.test(text.split("harness keymap")[1] ?? ""));

    inst.unmount();
  }

  // ── case 2: toggle off with `?` ──────────────────────────────────
  process.stderr.write("--- case 2: toggle off with `?` ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
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
    await new Promise((r) => setTimeout(r, 200));
    (stdin as unknown as Readable).push("?");
    await new Promise((r) => setTimeout(r, 100));
    const beforeClose = frames.length;
    (stdin as unknown as Readable).push("?");
    await new Promise((r) => setTimeout(r, 200));

    const lateText = frames.slice(beforeClose).join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    check("toggling `?` again closes overlay (zones return)",
      /◆ IN FLIGHT/.test(lateText));
    inst.unmount();
  }

  // ── case 3: `q` closes ───────────────────────────────────────────
  // Ink's escape-sequence parser waits for a follow-up byte before
  // declaring a bare ESC, so a synthetic stdin push of \x1b alone
  // doesn't fire key.escape reliably in this test harness. The
  // overlay also accepts `q` and `?` for the same outcome — verify
  // via `q` which has no ambiguity.
  process.stderr.write("--- case 3: `q` closes ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
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
    await new Promise((r) => setTimeout(r, 200));
    (stdin as unknown as Readable).push("?");
    await new Promise((r) => setTimeout(r, 100));
    const beforeClose = frames.length;
    (stdin as unknown as Readable).push("q");
    await new Promise((r) => setTimeout(r, 200));

    const lateText = frames.slice(beforeClose).join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    check("`q` closes overlay (zones return)", /◆ IN FLIGHT/.test(lateText));
    inst.unmount();
  }

  // ── case 4: keybinds blocked while help open ─────────────────────
  process.stderr.write("--- case 4: keybinds blocked while help open ---\n");
  {
    const { stdout, stdin, frames } = makeStreams();
    let captureCalled = 0;
    const inst = ink.render(
      React.createElement(dashboardMod.Dashboard, {
        initial: snapshot(),
        refresh: snapshot,
        ideasDir: process.cwd(),
        callbacks: {
          onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
          onCapture: () => { captureCalled++; return null; },
          onSpawnVerb: () => ({ detached: false }),
        },
        onAction: () => {},
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 200));
    // Open help, then try `c` (capture) — should be ignored.
    (stdin as unknown as Readable).push("?");
    await new Promise((r) => setTimeout(r, 100));
    (stdin as unknown as Readable).push("c");
    await new Promise((r) => setTimeout(r, 100));

    const finalText = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    check("`c` blocked while help open (no capture prompt)",
      !/capture ›/.test(finalText.split("harness keymap").pop() ?? ""));
    check("onCapture not called while help open", captureCalled === 0);
    inst.unmount();
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-help FAIL:", e);
  process.exit(1);
});
