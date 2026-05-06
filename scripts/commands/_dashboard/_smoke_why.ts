/**
 * scripts/commands/_dashboard/_smoke_why.ts
 *
 * The brainstorm verdict block has a `**Why:**` line — the
 * one-sentence rationale a reviewer needs to gauge confidence at a
 * glance. AwaitDetail must render it. Asserts:
 *
 *   1. parseBrainstormSections extracts the Why text verbatim.
 *   2. Markdown emphasis inside Why is stripped.
 *   3. Missing Why returns null without throwing.
 *   4. The dashboard render shows the why line in AwaitDetail
 *      between problem and variants.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Writable, Readable } from "stream";
import * as React from "react";

async function main() {
  const dataMod = await import("./data");
  const ink = await import("ink");
  const dashboardMod = await import("./index");

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // ── case 1: Why parsed from canonical brainstorm body ─────────────
  const tmpIdeas = fs.mkdtempSync(path.join(os.tmpdir(), "harness-why-"));
  const slug = "why-probe";
  const filename = `${slug}.md`;
  const ideaBody = `---
id: why0001
title: "Why probe"
status: brainstormed
project: letsbarker
captured_at: ${new Date().toISOString()}
brainstormed_at: ${new Date().toISOString()}
---

## Brainstorm

### Problem
A specific problem statement.

### Variants
1. **Variant A** — short body
2. **Variant B** — short body

### Risks and open questions
- A risk

### Verdict
**Recommended action:** accept
**Confidence:** high
**Why:** This is the **load-bearing** rationale that needs to land in the
dashboard so a reviewer can gauge confidence in 5 seconds.
**If accepted, build:** Variant A
`;
  const filepath = path.join(tmpIdeas, filename);
  fs.writeFileSync(filepath, ideaBody, "utf8");

  const sections = dataMod.parseBrainstormSections(filepath);
  check("Why parsed", typeof sections.why === "string");
  check("Why is non-empty", !!sections.why && sections.why.length > 20);
  check("Why has expected substring",
    !!sections.why && sections.why.includes("rationale that needs to land"));
  check("markdown emphasis stripped from Why",
    !!sections.why && !/\*\*[^*]+\*\*/.test(sections.why),
    sections.why ?? "(null)");

  // ── case 2: Missing Why returns null cleanly ─────────────────────
  const slugBare = "no-why";
  const bareBody = `---
id: bare0001
title: "Bare"
status: brainstormed
project: letsbarker
captured_at: ${new Date().toISOString()}
brainstormed_at: ${new Date().toISOString()}
---

## Brainstorm

### Problem
P

### Variants
1. **A** — body
`;
  const barePath = path.join(tmpIdeas, `${slugBare}.md`);
  fs.writeFileSync(barePath, bareBody, "utf8");
  const bareSections = dataMod.parseBrainstormSections(barePath);
  check("missing Why returns null", bareSections.why === null);

  // ── case 3: Render shows the why line ─────────────────────────────
  const idea = {
    filename,
    slug,
    id: "why0001",
    title: "Why probe",
    status: "brainstormed" as const,
    project: "letsbarker",
    captured_at: new Date().toISOString(),
    brainstormed_at: new Date().toISOString(),
    decided_at: "",
    github_issue: "",
    github_pr: "",
    loop_count: 0,
    recommended_action: "accept" as const,
    confidence: "high" as const,
  };

  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) { frames.push(chunk.toString()); cb(); },
  }) as unknown as NodeJS.WriteStream;
  (stdout as unknown as { columns: number }).columns = 110;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: () => unknown }).setRawMode = () => stdin;
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  (stdin as unknown as { resume: () => void }).resume = () => {};
  (stdin as unknown as { pause: () => void }).pause = () => {};

  const snapshot = () => ({ ideas: [idea], runs: [], today: [] });
  const inst = ink.render(
    React.createElement(dashboardMod.Dashboard, {
      initial: snapshot(),
      refresh: snapshot,
      ideasDir: tmpIdeas,
      callbacks: {
        onAccept: () => {}, onReject: () => {}, onNeedsMoreThought: () => {},
        onCapture: () => null, onSpawnVerb: () => ({ detached: false }),
      },
      onAction: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );
  await new Promise((r) => setTimeout(r, 500));
  inst.unmount();

  const text = frames.join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  check("rendered frame contains 'why' label", /\bwhy\b/.test(text));
  check("rendered frame contains rationale text",
    /rationale that needs to land/.test(text));
  // Order: why should appear after problem and before variants in the
  // rendered detail block.
  const idxProblem  = text.indexOf("problem");
  const idxWhy      = text.indexOf("why");
  const idxVariants = text.indexOf("variants");
  check("order: problem → why → variants",
    idxProblem >= 0 && idxWhy > idxProblem && idxVariants > idxWhy,
    `problem=${idxProblem} why=${idxWhy} variants=${idxVariants}`);

  fs.rmSync(tmpIdeas, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-why FAIL:", e);
  process.exit(1);
});
