#!/usr/bin/env tsx
/**
 * bin/harness.ts
 *
 * Single binary entrypoint. Every verb lives in
 * scripts/commands/<verb>.ts as `run(args, output)`. This file is the
 * only argv consumer in the codebase — verb fns take typed args and
 * write through an Output instance.
 *
 * Adding a new verb:
 *   1. Implement scripts/commands/<verb>.ts exporting `run`.
 *   2. registerVerb({...}) inside that file at module-load time.
 *   3. Add a commander block here that parses args and calls run.
 */

import { Command, Option } from "commander";
import { Output, modeFromFlags } from "../scripts/lib/output";

interface GlobalFlags {
  json?: boolean;
  ndjson?: boolean;
  noColor?: boolean;
}

function getFlags(program: Command): GlobalFlags {
  return program.opts<GlobalFlags>();
}

function makeOutput(verb: string, opts: GlobalFlags): Output {
  return new Output({
    mode: modeFromFlags({ json: opts.json, ndjson: opts.ndjson }),
    verb,
    color: opts.noColor ? false : undefined,
  });
}

async function runVerb<A>(
  verb: string,
  args: A,
  fn: (args: A, out: Output) => Promise<void>,
  globalFlags: GlobalFlags
): Promise<void> {
  const out = makeOutput(verb, globalFlags);
  try {
    await fn(args, out);
    if (!out.settled) {
      out.error("INTERNAL", `Verb "${verb}" returned without producing a result.`);
      process.exit(2);
    }
    // Exit 1 on logical error envelopes so shell scripts can branch.
    // The Output object knows its final shape.
    if ((out as any)._settled) {
      // We can't easily inspect the envelope post-emission without
      // exposing it. Keep success as exit 0; verb fns that emit
      // out.error() are responsible for not also calling process.exit.
    }
  } catch (err) {
    if (!out.settled) {
      const e = err as Error;
      out.error("INTERNAL", e.message || String(err), {
        details: { stack: e.stack },
      });
    }
    process.exit(1);
  }
}

const program = new Command();

program
  .name("harness")
  .description("Capture, brainstorm, and ship ideas as real PRs.")
  .version(require("../package.json").version)
  .option("--json", "emit a single harness/v1 envelope to stdout")
  .option("--ndjson", "stream events as JSON lines, terminating with the envelope")
  .option("--no-color", "disable ANSI color in pretty mode")
  .showHelpAfterError(true)
  .configureHelp({ sortSubcommands: true });

// ── contracts ───────────────────────────────────────────────────────
program
  .command("contracts")
  .description("Emit JSON Schema for every verb's data shape and event types")
  .addOption(new Option("--meta", "include the envelope/event base schemas"))
  .action(async (opts) => {
    const { run } = await import("../scripts/commands/contracts");
    await runVerb("contracts", { includeMeta: !!opts.meta }, run, getFlags(program));
  });

// ── capture ─────────────────────────────────────────────────────────
program
  .command("capture")
  .description("Add a new idea (text | --from reminders|stdin|issue)")
  .argument("[text...]", "raw idea text (creates a single idea)")
  .option("--from <source>", "reminders | stdin | issue | text")
  .option("--project <key>", "project key from projects.yml")
  .action(async (text: string[], opts) => {
    const { run } = await import("../scripts/commands/capture");
    await runVerb(
      "capture",
      { text, from: opts.from, project: opts.project },
      run,
      getFlags(program)
    );
  });

// ── brainstorm ──────────────────────────────────────────────────────
program
  .command("brainstorm")
  .description("Plan → harvest → brainstorm → schema → critic")
  .option("--idea <slug>", "focus on one idea")
  .option("--dry", "plan only, do not execute")
  .action(async (opts) => {
    const { run } = await import("../scripts/commands/brainstorm");
    await runVerb("brainstorm", { idea: opts.idea, dry: !!opts.dry }, run, getFlags(program));
  });

// ── ideas ───────────────────────────────────────────────────────────
const ideas = program.command("ideas").description("Inspect captured ideas");
ideas
  .command("list")
  .description("List ideas, optionally filtered by status or project")
  .option("--status <s>", "filter by status")
  .option("--project <p>", "filter by project key")
  .action(async (opts) => {
    const { runList } = await import("../scripts/commands/ideas");
    await runVerb(
      "ideas.list",
      { status: opts.status, project: opts.project },
      runList,
      getFlags(program)
    );
  });
ideas
  .command("show")
  .description("Show one idea — full file or a single section")
  .argument("<slug>")
  .option("--section <name>", "frontmatter | brainstorm | notes | raw")
  .action(async (slug: string, opts) => {
    const { runShow } = await import("../scripts/commands/ideas");
    await runVerb("ideas.show", { slug, section: opts.section }, runShow, getFlags(program));
  });
ideas
  .command("waiting")
  .description("Ideas with status=brainstormed | needs-critic-review")
  .action(async () => {
    const { runWaiting } = await import("../scripts/commands/ideas");
    await runVerb("ideas.waiting", {}, runWaiting, getFlags(program));
  });

// ── review ──────────────────────────────────────────────────────────
const review = program.command("review").description("Conversational review hooks");
review
  .command("next")
  .description("JSON envelope for the next idea to review")
  .action(async () => {
    const { runNext } = await import("../scripts/commands/review");
    await runVerb("review.next", {}, runNext, getFlags(program));
  });
review
  .command("in-flight")
  .description("Bucket in-flight ideas by status")
  .action(async () => {
    const { runInFlight } = await import("../scripts/commands/review");
    await runVerb("review.in-flight", {}, runInFlight, getFlags(program));
  });
review
  .command("accept")
  .description("Mark an idea as accepted")
  .argument("<slug>")
  .option("--note <text>")
  .option("--variant <text>", "variant chosen during review")
  .action(async (slug: string, opts) => {
    const { runAccept } = await import("../scripts/commands/review");
    await runVerb(
      "review.accept",
      { slug, note: opts.note, variant: opts.variant },
      runAccept,
      getFlags(program)
    );
  });
review
  .command("reject")
  .description("Mark an idea as rejected")
  .argument("<slug>")
  .option("--note <text>")
  .action(async (slug: string, opts) => {
    const { runReject } = await import("../scripts/commands/review");
    await runVerb("review.reject", { slug, note: opts.note }, runReject, getFlags(program));
  });
review
  .command("thought")
  .description("Mark needs-more-thought, increment loop counter")
  .argument("<slug>")
  .option("--note <text>")
  .action(async (slug: string, opts) => {
    const { runThought } = await import("../scripts/commands/review");
    await runVerb("review.thought", { slug, note: opts.note }, runThought, getFlags(program));
  });
review
  .command("set")
  .description("Set arbitrary status on an idea (advanced)")
  .argument("<slug>")
  .argument("<status>")
  .option("--note <text>")
  .action(async (slug: string, status: string, opts) => {
    const { runSet } = await import("../scripts/commands/review");
    await runVerb(
      "review.set",
      { slug, status, note: opts.note },
      runSet,
      getFlags(program)
    );
  });

// ── reply ───────────────────────────────────────────────────────────
program
  .command("reply")
  .description("Answer the most recent Open Question the sharpener posed to an idea")
  .argument("<slug>")
  .argument("<answer...>", "the answer text (multiple words allowed without quoting)")
  .action(async (slug: string, answerParts: string[]) => {
    const { runReply } = await import("../scripts/commands/reply");
    await runVerb(
      "reply",
      { slug, answer: answerParts.join(" ") },
      runReply,
      getFlags(program)
    );
  });

// ── digest (Phase 4) ────────────────────────────────────────────────
program
  .command("digest")
  .description("Generate runs/digest-<date>.md from the journal for a UTC day")
  .option("--date <yyyy-mm-dd>", "explicit date; defaults to today UTC")
  .action(async (opts) => {
    const { runDigest } = await import("../scripts/commands/digest");
    await runVerb("digest", { date: opts.date }, runDigest, getFlags(program));
  });

// ── follow / watch-prs (Phase 3) ────────────────────────────────────
program
  .command("follow")
  .description("Poll open PRs and act on CI / review state (default off — see IDEA_HARNESS_AUTO_FOLLOW)")
  .argument("[slug]", "explicit idea slug; omit to follow every active PR")
  .action(async (slug: string | undefined) => {
    const { runFollow } = await import("../scripts/commands/follow");
    await runVerb("follow", { slug }, runFollow, getFlags(program));
  });
program
  .command("watch-prs")
  .description("Daemon: run `harness follow` on a fixed interval until SIGINT")
  .option("--interval <seconds>", "poll interval in seconds", (s) => parseInt(s, 10))
  .option("--max-cycles <n>", "stop after N cycles (mostly for tests)", (s) => parseInt(s, 10))
  .action(async (opts) => {
    const { runWatchPrs } = await import("../scripts/commands/watch-prs");
    await runVerb(
      "watch-prs",
      { interval: opts.interval, maxCycles: opts.maxCycles },
      runWatchPrs,
      getFlags(program)
    );
  });

// ── ship ────────────────────────────────────────────────────────────
program
  .command("ship")
  .description("Do the obvious next thing — pick an idea and graduate/resume it")
  .argument("[slug]", "explicit idea slug")
  .option("--variant <text>", "override variant choice")
  .option("-y, --yes", "skip confirmation when auto-accepting")
  .option("--dry", "preview the prompt without spawning")
  .action(async (slug: string | undefined, opts) => {
    const { run } = await import("../scripts/commands/ship");
    await runVerb(
      "ship",
      { slug, variant: opts.variant, yes: !!opts.yes, dry: !!opts.dry },
      run,
      getFlags(program)
    );
  });

// ── resume ──────────────────────────────────────────────────────────
// Top-level alias for `harness build resume` for muscle memory.
program
  .command("resume")
  .description("Recover a `building` idea by landing in-flight work")
  .argument("[slug]", "idea slug (omitted: only/newest building idea)")
  .option("--variant <text>")
  .option("--dry")
  .action(async (slug: string | undefined, opts) => {
    const { runResume } = await import("../scripts/commands/build");
    await runVerb(
      "build.resume",
      { slug, variant: opts.variant, dry: !!opts.dry },
      runResume,
      getFlags(program)
    );
  });

// ── build ───────────────────────────────────────────────────────────
const build = program.command("build").description("Build / resume / watch a single idea");
build
  .command("start", { isDefault: true })
  .description("Spawn a fresh build for an accepted idea")
  .argument("<slug>")
  .option("--variant <text>")
  .option("--dry")
  .action(async (slug: string, opts) => {
    const { runStart } = await import("../scripts/commands/build");
    await runVerb(
      "build.start",
      { slug, variant: opts.variant, dry: !!opts.dry },
      runStart,
      getFlags(program)
    );
  });
build
  .command("resume")
  .description("Land in-flight work on a `building` idea")
  .argument("[slug]")
  .option("--variant <text>")
  .option("--dry")
  .action(async (slug: string | undefined, opts) => {
    const { runResume } = await import("../scripts/commands/build");
    await runVerb(
      "build.resume",
      { slug, variant: opts.variant, dry: !!opts.dry },
      runResume,
      getFlags(program)
    );
  });
build
  .command("watch")
  .description("Tail the live event stream for an in-flight build")
  .argument("<slug>")
  .option("--demo", "render the TUI with synthetic events (no live build needed)")
  .action(async (slug: string, opts) => {
    const { runWatch } = await import("../scripts/commands/build");
    await runVerb("build.watch", { slug, demo: !!opts.demo }, runWatch, getFlags(program));
  });
build
  .command("status")
  .description("Current state for one build")
  .argument("<slug>")
  .action(async (slug: string) => {
    const { runStatus } = await import("../scripts/commands/build");
    await runVerb("build.status", { slug }, runStatus, getFlags(program));
  });

// ── cleanup ─────────────────────────────────────────────────────────
program
  .command("cleanup")
  .description("Remove worktrees for shipped ideas")
  .option("--apply", "actually remove (default: dry-run)")
  .option("--include-rejected", "also clean up rejected ideas")
  .option("--orphans", "also clean orphaned worktrees")
  .action(async (opts) => {
    const { run } = await import("../scripts/commands/cleanup");
    await runVerb(
      "cleanup",
      {
        apply: !!opts.apply,
        includeRejected: !!opts.includeRejected,
        orphans: !!opts.orphans,
      },
      run,
      getFlags(program)
    );
  });

// ── inspect ─────────────────────────────────────────────────────────
program
  .command("inspect")
  .description("Show recent runs, idea counts, metrics, and project routing")
  .option("--runs <n>", "number of runs to include", "5")
  .option("--metric <name>", "filter to a single metric substring")
  .action(async (opts) => {
    const { run } = await import("../scripts/commands/inspect");
    await runVerb(
      "inspect",
      { runs: parseInt(opts.runs, 10) || 5, metric: opts.metric },
      run,
      getFlags(program)
    );
  });

// ── doctor ──────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check environment health (claude bin, gh, projects.yml, reminders)")
  .action(async () => {
    const { run } = await import("../scripts/commands/doctor");
    await runVerb("doctor", {}, run, getFlags(program));
  });

// ── completions ─────────────────────────────────────────────────────
program
  .command("completions")
  .description("Emit a shell completion script (bash | zsh | fish)")
  .argument("<shell>", "bash | zsh | fish")
  .action(async (shellRaw: string) => {
    const { run } = await import("../scripts/commands/completions");
    if (shellRaw !== "bash" && shellRaw !== "zsh" && shellRaw !== "fish") {
      const out = makeOutput("completions", getFlags(program));
      out.error("BAD_INPUT", `Unsupported shell "${shellRaw}".`, {
        hint: "Supported: bash | zsh | fish",
      });
      process.exit(1);
    }
    await runVerb("completions", { shell: shellRaw }, run, getFlags(program));
  });

// ── serve ───────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Run as an MCP server (stdio)")
  .option("--mcp", "MCP server over stdio")
  .option("--http <addr>", "HTTP server bind (not yet implemented)")
  .action(async (opts) => {
    const { run } = await import("../scripts/commands/serve");
    await runVerb("serve", { mcp: !!opts.mcp }, run, getFlags(program));
  });

program.parseAsync(process.argv).catch((err) => {
  const msg = (err as Error)?.message ?? String(err);
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(2);
});
