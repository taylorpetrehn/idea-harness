#!/usr/bin/env tsx
/**
 * bin/harness.ts
 *
 * Single binary entrypoint. Every verb is implemented in
 * scripts/commands/<verb>.ts as `run(args, output)`. This file just
 * wires commander → verb fn → Output, and is the only argv consumer
 * in the codebase.
 *
 * Output mode is selected once from the top-level flags (--json or
 * --ndjson) and threaded into every command via the Output instance.
 *
 * Adding a new verb:
 *   1. Implement scripts/commands/<verb>.ts exporting `run`.
 *   2. registerVerb({...}) inside that file at module-load time.
 *   3. Add a commander block here that parses args and calls run.
 */

import { Command, Option } from "commander";
import { Output, modeFromFlags } from "../scripts/lib/output";
import { ErrorCode } from "../scripts/lib/contracts";

interface GlobalFlags {
  json?: boolean;
  ndjson?: boolean;
  noColor?: boolean;
}

function makeOutput(verb: string, opts: GlobalFlags): Output {
  return new Output({
    mode: modeFromFlags({ json: opts.json, ndjson: opts.ndjson }),
    verb,
    color: opts.noColor ? false : undefined,
  });
}

/**
 * Wrap a verb fn so any thrown error becomes a clean envelope on the
 * Output object instead of an uncaught exception. Verb fns are
 * expected to call `out.result()` / `out.error()` themselves on the
 * happy / known-error paths; this is the safety net for the unknown.
 */
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

// ── Stub for verbs not yet ported ───────────────────────────────────
// Phase 2 wires only `contracts`. Every other verb gets this stub
// until phase 3 lands. Helps confirm the routing works without
// pretending verbs are functional.

async function notYetImplemented(verb: string, out: Output): Promise<void> {
  out.error(
    "BAD_INPUT" satisfies ErrorCode,
    `\`${verb}\` will be available after phase 3 lands.`,
    { hint: "See proposals/next-gen-cli.md for the migration plan." }
  );
}

// ── Build the command tree ──────────────────────────────────────────

const program = new Command();

program
  .name("harness")
  .description("Capture, brainstorm, and ship ideas as real PRs.")
  .version(require("../package.json").version)
  .option("--json", "emit a single harness/v1 envelope to stdout")
  .option("--ndjson", "stream events as JSON lines, terminating with the envelope")
  .option("--no-color", "disable ANSI color in pretty mode")
  .showHelpAfterError(true)
  .configureHelp({
    sortSubcommands: true,
  });

// `harness contracts` ───────────────────────────────────────────────
program
  .command("contracts")
  .description("Emit JSON Schema for every verb's data shape and event types")
  .addOption(new Option("--meta", "include the envelope/event base schemas"))
  .action(async (opts) => {
    const { run } = await import("../scripts/commands/contracts");
    await runVerb(
      "contracts",
      { includeMeta: !!opts.meta },
      run,
      program.opts<GlobalFlags>()
    );
  });

// ── Verb stubs (phase 2 placeholder — phase 3 replaces these) ──────
const STUB_VERBS: Array<[string, string, (sub: Command) => void]> = [
  ["capture", "Add a new idea (text | --from reminders|stdin|issue)", (cmd) => {
    cmd.argument("[text...]", "raw idea text");
    cmd.option("--from <source>", "source: reminders|stdin|issue|text");
    cmd.option("--project <key>", "project key from projects.yml");
  }],
  ["brainstorm", "Plan → harvest → brainstorm → schema → critic", (cmd) => {
    cmd.option("--idea <slug>", "focus on one idea");
    cmd.option("--dry", "plan only, do not execute");
  }],
  ["ship", "Do the obvious next thing — pick an idea and graduate/resume it", (cmd) => {
    cmd.argument("[slug]", "explicit idea slug");
    cmd.option("--variant <text>", "override variant choice");
    cmd.option("-y, --yes", "skip confirmation when auto-accepting");
    cmd.option("--dry", "preview the prompt without spawning");
  }],
  ["resume", "Recover a `building` idea by landing in-flight work", (cmd) => {
    cmd.argument("<slug>", "idea slug");
  }],
  ["cleanup", "Remove worktrees for shipped ideas", (cmd) => {
    cmd.option("--apply", "actually remove (default: dry-run)");
    cmd.option("--include-rejected", "also clean up rejected ideas");
    cmd.option("--orphans", "also clean orphaned worktrees");
  }],
  ["inspect", "Show recent runs and rolling metrics", (cmd) => {
    cmd.option("--runs <n>", "number of runs to include", "5");
    cmd.option("--metric <name>", "filter to a single metric");
  }],
  ["doctor", "Check environment health: projects.yml, claude bin, gh auth, …", () => {}],
  ["completions", "Emit a shell completion script", (cmd) => {
    cmd.argument("<shell>", "bash | zsh | fish");
  }],
  ["serve", "Run as an MCP or HTTP server (lands in phase 7)", (cmd) => {
    cmd.option("--mcp", "MCP server over stdio");
    cmd.option("--http <addr>", "HTTP server, e.g. :7717");
  }],
];

for (const [name, desc, configure] of STUB_VERBS) {
  const cmd = program.command(name).description(desc);
  configure(cmd);
  cmd.action(async () => {
    const out = makeOutput(name, program.opts<GlobalFlags>());
    await notYetImplemented(name, out);
    process.exit(1);
  });
}

// ── Verb groups (phase 3 fills these in) ───────────────────────────

const ideas = program.command("ideas").description("Inspect captured ideas");
ideas
  .command("list")
  .description("List ideas, optionally filtered by status or project")
  .option("--status <s>", "filter by status")
  .option("--project <p>", "filter by project key")
  .action(async () => {
    const out = makeOutput("ideas.list", program.opts<GlobalFlags>());
    await notYetImplemented("ideas.list", out);
    process.exit(1);
  });
ideas
  .command("show")
  .description("Show one idea")
  .argument("<slug>")
  .option("--section <name>", "frontmatter | brainstorm | notes")
  .action(async () => {
    const out = makeOutput("ideas.show", program.opts<GlobalFlags>());
    await notYetImplemented("ideas.show", out);
    process.exit(1);
  });
ideas
  .command("waiting")
  .description("Ideas with status=brainstormed | needs-critic-review")
  .action(async () => {
    const out = makeOutput("ideas.waiting", program.opts<GlobalFlags>());
    await notYetImplemented("ideas.waiting", out);
    process.exit(1);
  });

const review = program.command("review").description("Conversational review hooks");
for (const sub of ["next", "in-flight"] as const) {
  review.command(sub).description(`harness review ${sub}`).action(async () => {
    const out = makeOutput(`review.${sub}`, program.opts<GlobalFlags>());
    await notYetImplemented(`review.${sub}`, out);
    process.exit(1);
  });
}
for (const sub of ["accept", "reject", "thought"] as const) {
  review
    .command(sub)
    .description(`Mark an idea as ${sub === "thought" ? "needs-more-thought" : sub + "ed"}`)
    .argument("<slug>")
    .option("--note <text>", "free-form note appended to ## Notes")
    .option("--variant <text>", "(accept only) variant chosen during review")
    .action(async () => {
      const out = makeOutput(`review.${sub}`, program.opts<GlobalFlags>());
      await notYetImplemented(`review.${sub}`, out);
      process.exit(1);
    });
}
review
  .command("set")
  .description("Set arbitrary status (advanced)")
  .argument("<slug>")
  .argument("<status>")
  .option("--note <text>")
  .action(async () => {
    const out = makeOutput("review.set", program.opts<GlobalFlags>());
    await notYetImplemented("review.set", out);
    process.exit(1);
  });

const build = program.command("build").description("Build / resume / watch a single idea");
build
  .command("start", { isDefault: true })
  .description("Spawn a fresh build for an accepted idea")
  .argument("<slug>")
  .option("--variant <text>")
  .option("--dry")
  .action(async () => {
    const out = makeOutput("build.start", program.opts<GlobalFlags>());
    await notYetImplemented("build.start", out);
    process.exit(1);
  });
build
  .command("resume")
  .description("Land in-flight work on a `building` idea")
  .argument("<slug>")
  .action(async () => {
    const out = makeOutput("build.resume", program.opts<GlobalFlags>());
    await notYetImplemented("build.resume", out);
    process.exit(1);
  });
build
  .command("watch")
  .description("Tail the live event stream for an in-flight build")
  .argument("<slug>")
  .action(async () => {
    const out = makeOutput("build.watch", program.opts<GlobalFlags>());
    await notYetImplemented("build.watch", out);
    process.exit(1);
  });
build
  .command("status")
  .description("Current state for one build")
  .argument("<slug>")
  .action(async () => {
    const out = makeOutput("build.status", program.opts<GlobalFlags>());
    await notYetImplemented("build.status", out);
    process.exit(1);
  });

// ── Parse and run ───────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  // commander's own errors (unknown command, missing arg) are already
  // pretty; we surface anything else as an envelope on stderr.
  const msg = (err as Error)?.message ?? String(err);
  process.stderr.write(`harness: ${msg}\n`);
  process.exit(2);
});
