/**
 * scripts/commands/dashboard.ts
 *
 * `harness` (no args) entrypoint. Renders the mission-control dashboard
 * over the existing JSON contract — listIdeas() to populate the screen,
 * a multi-stream tail of runs/<id>/events.ndjson for IN FLIGHT, and the
 * journal for TODAY.
 *
 * The verb is a small state machine: render the dashboard, await a user
 * action, dispatch it (build / watch / open), then re-render on return.
 * Quit ends the loop.
 *
 * Pretty/TTY only. In --json or --ndjson modes this is a no-op with a
 * pointer to the underlying verbs.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

import {
  IdeaSummary,
  createRawIdea,
  listIdeas,
  setStatus,
} from "../lib/ideas";
import { readJournal } from "../lib/journal";
import { resolveProject } from "../lib/projects";
import { Output } from "../lib/output";
import { z } from "zod";
import { registerVerb } from "../lib/contracts";

const ROOT = path.join(__dirname, "..", "..");
const RUNS_DIR = path.join(ROOT, "runs");
const HARNESS_BIN = path.join(ROOT, "bin", "harness.ts");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");

export interface DashboardArgs {
  /** Optional initial filter — currently unused; reserved for `harness --filter accepted`. */
  initialTab?: string;
}

const DashboardData = z.object({
  action: z.enum(["build", "watch", "open", "quit"]),
  slug: z.string().nullable(),
});

registerVerb({
  verb: "dashboard",
  description: "Interactive ideas dashboard (TTY only).",
  data: DashboardData,
});

export async function run(_args: DashboardArgs, out: Output): Promise<void> {
  if (out.mode !== "pretty" || !process.stdout.isTTY) {
    out.error("BAD_INPUT", "The dashboard requires an interactive terminal.", {
      hint: "Use `harness ideas list` from agents/scripts; the dashboard is humans-only.",
    });
    return;
  }

  const dashboardMod = await import("./_dashboard");
  const dataMod = await import("./_dashboard/data");
  const { renderDashboard } = dashboardMod;
  const { scanActiveRuns, buildTodayFeed } = dataMod;
  const { renderWatchTui } = await import("./_watch_tui");

  const ideasDir = path.join(ROOT, "ideas");

  const snapshot = () => {
    const ideas = listIdeas();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const journal = readJournal({ since });
    return {
      ideas,
      runs: scanActiveRuns(RUNS_DIR),
      today: buildTodayFeed(ideas, journal, { limit: 30 }),
    };
  };

  let lastAction: { kind: string; slug: string | null } = { kind: "quit", slug: null };

  while (true) {
    const { action } = await renderDashboard({
      initial: snapshot(),
      refresh: snapshot,
      ideasDir,
      callbacks: {
        onAccept: (slug) => setStatus(slug, "accepted", "Accepted from dashboard."),
        onReject: (slug) => setStatus(slug, "rejected", "Rejected from dashboard."),
        onNeedsMoreThought: (slug) =>
          setStatus(slug, "needs-more-thought", "Flagged needs-more-thought from dashboard."),
        onCapture: (text) => {
          const project = resolveProject(text, "") ?? "letsbarker";
          const created = createRawIdea({ title: text, project, source: "dashboard" });
          return { slug: created.slug, project: created.project };
        },
      },
    });

    if (action.kind === "quit") {
      lastAction = { kind: "quit", slug: null };
      break;
    }

    if (action.kind === "open") {
      const ideaFile = path.join(ROOT, "ideas", action.idea.filename);
      out.stdout(ideaFile + "\n");
      lastAction = { kind: "open", slug: action.idea.slug };
      break;
    }

    if (action.kind === "watch") {
      // Tail the existing run's events file in the watch TUI fullscreen.
      const ideaForWatch = action.idea ?? synthesizeIdea(action.run.slug ?? action.run.runId);
      await renderWatchTui({
        idea: ideaForWatch,
        eventsPath: action.run.eventsPath,
        exitOnTerminal: false,
      });
      // Loop back into the dashboard.
      continue;
    }

    if (action.kind === "build") {
      await runBuildWithWatch(action.idea, out);
      // After a build returns, refresh and show the dashboard again.
      continue;
    }
  }

  out.result(lastAction, lastAction.kind === "quit" ? "bye" : undefined);
}

async function runBuildWithWatch(idea: IdeaSummary, out: Output): Promise<void> {
  const runsBefore = new Set(safeReaddir(RUNS_DIR));

  const child = spawn(
    TSX_BIN,
    [HARNESS_BIN, "--ndjson", "build", "start", idea.slug],
    {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
      detached: false,
    }
  );

  let childStderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr += chunk.toString("utf8");
  });

  const childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> =
    new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

  const eventsPath = await waitForNewEventsFile(runsBefore, childExit, 15000);
  if (!eventsPath) {
    const exitInfo = await childExit;
    out.warn(
      `Build child for "${idea.slug}" never produced an events stream. ` +
        `exit_code=${exitInfo.code} stderr_tail=${childStderr.split("\n").slice(-5).join(" | ")}`
    );
    return;
  }

  const { renderWatchTui } = await import("./_watch_tui");
  await renderWatchTui({ idea, eventsPath, exitOnTerminal: true });

  // Watch TUI exited; wait briefly for the child to finish its envelope flush.
  await childExit;
}

function synthesizeIdea(slug: string): IdeaSummary {
  // Used when we're watching an active run that has no idea file (e.g. a
  // brainstorm orchestrator run). The watch TUI only reads a few fields.
  return {
    filename: `${slug}.md`,
    slug,
    id: slug,
    title: slug,
    status: "building",
    project: "—",
    captured_at: "",
    brainstormed_at: "",
    decided_at: "",
    github_issue: "",
    github_pr: "",
    loop_count: 0,
  };
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

async function waitForNewEventsFile(
  runsBefore: Set<string>,
  childExit: Promise<{ code: number | null }>,
  timeoutMs: number
): Promise<string | null> {
  const start = Date.now();
  let exited = false;
  childExit.then(() => { exited = true; });

  while (Date.now() - start < timeoutMs) {
    const now = safeReaddir(RUNS_DIR);
    for (const id of now) {
      if (runsBefore.has(id)) continue;
      const eventsPath = path.join(RUNS_DIR, id, "events.ndjson");
      if (fs.existsSync(eventsPath)) return eventsPath;
    }
    if (exited) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}
