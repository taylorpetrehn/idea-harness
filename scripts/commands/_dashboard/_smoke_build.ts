/**
 * scripts/commands/_dashboard/_smoke_build.ts
 *
 * Build-spawn handoff smoke. Mirrors the exact subprocess the dashboard
 * verb's runBuildWithWatch spawns: `tsx bin/harness.ts --ndjson build
 * start <slug>` against an accepted idea, with IDEA_HARNESS_BUILDER=
 * offline so the builder produces a fake PR URL instead of invoking
 * Claude Code. Asserts:
 *
 *   1. The child process exits cleanly.
 *   2. A new run dir is created under runs/.
 *   3. While the child is still running (before summary.json lands),
 *      scanActiveRuns surfaces the run — proves the dashboard would
 *      see an in-flight build during the live tail.
 *   4. events.ndjson lands and contains the canonical build.requested,
 *      build.started, build.pr_open, build.done events.
 *   5. summary.json is finalized with status: complete.
 *   6. NDJSON envelope flows through child stdout.
 *
 * Cleans up the test idea + run dir + temp projects.yml on exit.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

async function main() {
  const { createRequire } = await import("module");
  const req = createRequire(import.meta.url);
  const { createRawIdea, setStatus } = req("../../lib/ideas") as typeof import("../../lib/ideas");
  const dataMod = await import("./data");

  const ROOT = process.cwd();
  const RUNS_DIR = path.join(ROOT, "runs");
  const IDEAS_DIR = path.join(ROOT, "ideas");
  const HARNESS_BIN = path.join(ROOT, "bin", "harness.ts");
  const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");

  // Temp projects.yml with one project the offline builder can resolve.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-build-smoke-"));
  const projectsYml = path.join(tmpDir, "projects.yml");
  fs.writeFileSync(
    projectsYml,
    [
      "projects:",
      "  letsbarker:",
      "    github_repo: example/letsbarker",
      "    local_path: " + tmpDir,
      "    base_branch: main",
      "    keywords:",
      "      - dashboard-build-smoke",
      "routing_rules:",
      "  default: letsbarker",
    ].join("\n"),
    "utf8"
  );

  // Test idea — created accepted so build.start picks it up immediately.
  const created = createRawIdea({
    title: "dashboard build smoke probe " + Date.now(),
    project: "letsbarker",
    source: "smoke",
  });
  setStatus(created.slug, "accepted", "Test smoke");
  const ideaPath = path.join(IDEAS_DIR, created.filename);

  const runsBefore = new Set(safeReaddir(RUNS_DIR));

  const cleanup = () => {
    try { fs.unlinkSync(ideaPath); } catch { /* ignore */ }
    // Sweep any new run dirs created during this smoke.
    for (const id of safeReaddir(RUNS_DIR)) {
      if (runsBefore.has(id)) continue;
      try { fs.rmSync(path.join(RUNS_DIR, id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on("uncaughtException", (e) => { cleanup(); throw e; });
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  // Spawn — same shape the verb uses.
  const child = spawn(
    TSX_BIN,
    [HARNESS_BIN, "--ndjson", "build", "start", created.slug],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        IDEA_HARNESS_BUILDER: "offline",
        IDEA_HARNESS_REMINDERS: "dry",
        IDEA_HARNESS_PROJECTS_YML: projectsYml,
      },
    }
  );

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (c: Buffer) => { stdoutBuf += c.toString("utf8"); });
  child.stderr?.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });

  // Poll for the new run dir and inspect mid-flight. We need to catch the
  // narrow window between startRun (creates events.ndjson) and finalizeRun
  // (writes summary.json) — offline mode can complete in <5ms on a hot
  // disk cache, so use setImmediate spin instead of setInterval which has
  // a ~1ms floor in node and can miss the window entirely.
  let midFlightRun: ReturnType<typeof dataMod.scanActiveRuns>[number] | undefined;
  let polling = true;
  const spin = () => {
    if (!polling) return;
    const active = dataMod.scanActiveRuns(RUNS_DIR);
    const fresh = active.find((r) => !runsBefore.has(r.runId));
    if (fresh && !midFlightRun) midFlightRun = fresh;
    setImmediate(spin);
  };
  spin();

  const childExit: Promise<{ code: number | null }> = new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code }));
  });
  const exitInfo = await childExit;
  polling = false;

  // Locate the new run dir.
  const newRunIds = safeReaddir(RUNS_DIR).filter((id) => !runsBefore.has(id));
  const runId = newRunIds[0];
  const runDir = runId ? path.join(RUNS_DIR, runId) : null;

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  check("child exited cleanly (code 0)", exitInfo.code === 0,
    `code=${exitInfo.code}, stderr_tail=${stderrBuf.split("\n").slice(-3).join(" | ")}`);
  check("a new run dir was created", !!runDir);
  check("scanActiveRuns saw the run mid-flight", !!midFlightRun,
    midFlightRun ? `runId=${midFlightRun.runId}` : "never observed");

  if (runDir) {
    const eventsPath = path.join(runDir, "events.ndjson");
    const summaryPath = path.join(runDir, "summary.json");
    check("events.ndjson exists", fs.existsSync(eventsPath));
    check("summary.json exists (run finalized)", fs.existsSync(summaryPath));

    if (fs.existsSync(eventsPath)) {
      const lines = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
      const types = new Set<string>();
      for (const line of lines) {
        try { types.add(JSON.parse(line).type); } catch { /* skip */ }
      }
      const expected = ["build.requested", "build.started", "build.pr_open", "build.done"];
      for (const t of expected) {
        check(`events.ndjson contains ${t}`, types.has(t));
      }
    }

    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      check("summary.json status is 'complete'", summary.status === "complete");
      check("summary.json outcome is 'passed'", summary.outcome === "passed");
      check("summary.json slug matches", summary.slug === created.slug);
    }
  }

  // The verb expects to read the NDJSON envelope off child stdout.
  check("child stdout produced NDJSON envelope",
    /"schema":"harness\/v1"/.test(stdoutBuf) && /"verb":"build\.start"/.test(stdoutBuf));

  cleanup();
  process.exit(pass ? 0 : 1);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => {
      try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error("smoke-build FAIL:", e);
  process.exit(1);
});
