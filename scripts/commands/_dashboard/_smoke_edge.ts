/**
 * scripts/commands/_dashboard/_smoke_edge.ts
 *
 * Edge-case robustness pass. Renders the dashboard against three
 * abnormal states and asserts no crashes plus a sensible empty render:
 *
 *   1. Cold start — zero ideas, zero runs, empty journal. Header should
 *      say `0 in flight · 0 awaiting you · 0 today`. Each zone should
 *      surface its empty-state line. NEXT bar should print the
 *      "nothing waiting" hint, not throw.
 *   2. Brainstorm-less idea — an idea on disk with status=raw, no body.
 *      AwaitDetail should still render (problem/variants/risks all
 *      empty) without throwing or showing markdown garbage.
 *   3. Missing runs/ dir — scanActiveRuns must guard. Move runs/ aside
 *      briefly, mount the dashboard, restore it, verify it returns
 *      empty rather than crashing.
 *
 * Each subcase mounts a fresh dashboard, asserts a clean frame, unmounts.
 */

import * as fs from "fs";
import * as os from "os";
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

  // Helper: mount, capture, return frames + any thrown error.
  async function renderOnce(opts: {
    ideas?: any[];
    journal?: any[];
    runsDir?: string;
    ideasDir?: string;
    cols?: number;
  }): Promise<{ frames: string[]; threw: Error | null }> {
    const frames: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) { frames.push(chunk.toString()); cb(); },
    }) as unknown as NodeJS.WriteStream;
    (stdout as unknown as { columns: number }).columns = opts.cols ?? 100;
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
      ideas: opts.ideas ?? [],
      runs: dataMod.scanActiveRuns(opts.runsDir ?? RUNS_DIR),
      today: dataMod.buildTodayLifecycle(opts.ideas ?? [], opts.journal ?? [], { limit: 12 }),
    });

    let threw: Error | null = null;
    try {
      const inst = ink.render(
        React.createElement(dashboardMod.Dashboard, {
          initial: snapshot(),
          refresh: snapshot,
          ideasDir: opts.ideasDir ?? IDEAS_DIR,
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
      await new Promise((r) => setTimeout(r, 400));
      inst.unmount();
    } catch (e) {
      threw = e as Error;
    }
    return { frames, threw };
  }

  const text = (frames: string[]) =>
    frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

  // ── case 1: cold start ────────────────────────────────────────────
  process.stderr.write("--- case 1: cold start (0 ideas, 0 runs) ---\n");
  {
    const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), "harness-empty-runs-"));
    const tmpIdeas = fs.mkdtempSync(path.join(os.tmpdir(), "harness-empty-ideas-"));
    const { frames, threw } = await renderOnce({
      ideas: [],
      journal: [],
      runsDir: tmpRuns,
      ideasDir: tmpIdeas,
    });
    check("cold-start render did not throw", threw === null,
      threw ? threw.message : undefined);
    const t = text(frames);
    check("header reflects zero counts", /0 in flight · 0 awaiting you · 0 today/.test(t));
    check("NEXT shows empty hint", /nothing waiting/.test(t));
    check("IN FLIGHT empty state visible",
      /nothing running/.test(t));
    check("AWAITING YOU empty state visible",
      /inbox zero/.test(t));
    check("TODAY empty state visible",
      /quiet day/.test(t));
    fs.rmSync(tmpRuns, { recursive: true, force: true });
    fs.rmSync(tmpIdeas, { recursive: true, force: true });
  }

  // ── case 2: idea with no brainstorm body ──────────────────────────
  process.stderr.write("--- case 2: brainstorm-less idea ---\n");
  {
    const tmpIdeas = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bare-ideas-"));
    const slug = "bare-idea-" + Date.now();
    fs.writeFileSync(
      path.join(tmpIdeas, `${slug}.md`),
      `---
id: bare0001
title: "Bare idea probe"
status: brainstormed
project: letsbarker
captured_at: ${new Date().toISOString()}
brainstormed_at: ${new Date().toISOString()}
---

## Raw Idea

Bare idea probe

## Brainstorm

<!-- intentionally empty — no Verdict / Variants / Risks -->
`,
      "utf8"
    );
    const idea = {
      filename: `${slug}.md`,
      slug,
      id: "bare0001",
      title: "Bare idea probe",
      status: "brainstormed" as const,
      project: "letsbarker",
      captured_at: new Date().toISOString(),
      brainstormed_at: new Date().toISOString(),
      decided_at: "",
      github_issue: "",
      github_pr: "",
      loop_count: 0,
    };
    const { frames, threw } = await renderOnce({
      ideas: [idea],
      ideasDir: tmpIdeas,
    });
    check("brainstorm-less render did not throw", threw === null,
      threw ? threw.message : undefined);
    const t = text(frames);
    check("idea title appears", t.includes("Bare idea probe"));
    check("AWAITING YOU shows the idea", /AWAITING YOU.*1[\s\S]*Bare idea probe/i.test(t));
    check("no markdown emphasis leaks through", !/\*\*[^*]+\*\*/.test(t));
    fs.rmSync(tmpIdeas, { recursive: true, force: true });
  }

  // ── case 3: scanActiveRuns against missing runs/ dir ──────────────
  process.stderr.write("--- case 3: missing runs/ dir ---\n");
  {
    // Use a path that doesn't exist — never touch the real runs/ dir.
    const ghost = path.join(os.tmpdir(), "harness-ghost-runs-" + Date.now());
    let threw: Error | null = null;
    let result: ReturnType<typeof dataMod.scanActiveRuns> = [];
    try {
      result = dataMod.scanActiveRuns(ghost);
    } catch (e) {
      threw = e as Error;
    }
    check("scanActiveRuns guards missing dir", threw === null,
      threw ? threw.message : undefined);
    check("scanActiveRuns returns [] on missing dir", result.length === 0);

    // Full dashboard render with a missing runs path.
    const tmpIdeas = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bare-ideas-"));
    const { threw: renderThrew } = await renderOnce({
      ideas: [],
      journal: [],
      runsDir: ghost,
      ideasDir: tmpIdeas,
    });
    check("render against missing runs dir did not throw", renderThrew === null,
      renderThrew ? renderThrew.message : undefined);
    fs.rmSync(tmpIdeas, { recursive: true, force: true });
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-edge FAIL:", e);
  process.exit(1);
});
