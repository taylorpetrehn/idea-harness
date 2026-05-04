/**
 * scripts/lib/graduator.ts
 *
 * Shared worker for the three commands that drive an idea toward a PR:
 *
 *   - graduate <slug>   → fresh build from an `accepted` idea
 *   - ship              → "do the obvious next thing" — picks the newest
 *                         accepted idea (auto-accepts a brainstormed one if
 *                         that's the only kind waiting) and graduates it
 *   - resume <slug>     → recover a `building` idea by committing/pushing
 *                         whatever's already on the branch and opening a PR
 *
 * Each entry point eventually funnels through `graduateOne` here. Keeping the
 * status transitions, run-artifact writes, and failure-mode messaging in one
 * place is the whole point — the three commands shouldn't drift apart.
 */

import { Run, writeRunArtifact } from "./runs";
import { setStatus, IdeaSummary } from "./ideas";
import { recordMetric } from "./metrics";
import { build, recordPrOnIdea } from "../agents/builder";
import { log } from "./log";

export interface GraduateOptions {
  /** "build" (default) or "resume" — passed straight through to the builder. */
  intent?: "build" | "resume";
  /** Override variant; falls back to **If accepted, build:** in the brainstorm. */
  variant?: string;
  /** Don't actually spawn — just print the prompt. Implies dry mode in the builder. */
  dry?: boolean;
}

export type GraduateOutcome = "passed" | "failed" | "dry" | "crashed";

export async function graduateOne(
  idea: IdeaSummary,
  run: Run,
  opts: GraduateOptions = {}
): Promise<GraduateOutcome> {
  const intent = opts.intent ?? "build";
  const verb = intent === "resume" ? "Resuming" : "Graduating";
  log.info(`${verb} ${idea.slug}…`);

  if (opts.dry) {
    process.env.IDEA_HARNESS_BUILDER = "dry";
  } else if (intent === "build") {
    // Fresh build: flip to `building` so a concurrent `harness ideas waiting` call
    // sees the in-flight work. Resume already runs against `building` ideas;
    // no transition needed.
    setStatus(idea.slug, "building");
    recordMetric("build.started", 1);
  }

  try {
    const result = await build(idea, run, { variant: opts.variant, intent });

    if (result.status === "pr-open" && result.pr_url) {
      recordPrOnIdea(idea, result.pr_url);
      log.info(`✓ ${idea.slug} → ${result.pr_url}`);
      recordMetric(intent === "resume" ? "resume.pr_open" : "build.pr_open", 1);
      return "passed";
    }

    if (result.status === "dry") {
      log.info(`(dry) ${idea.slug} prompt prepared.`);
      return "dry";
    }

    // Failure — preserve `building` status so `resume` can recover the
    // branch's in-flight work. Reverting to `accepted` would tempt a
    // destructive re-build from scratch.
    log.error(`✗ ${idea.slug} ${intent} failed (exit ${result.exitCode}).`);
    log.error(`  stdout tail:\n${result.stdoutTail}`);
    log.error(`  stderr tail:\n${result.stderrTail}`);
    log.error(`  Recovery: \`harness resume ${idea.slug}\` to land any in-flight work on ${result.branch}.`);
    setStatus(
      idea.slug,
      "building",
      `${intent === "resume" ? "Resume" : "Build"} did not reach PR at ${new Date().toISOString()} on ${result.branch}. ` +
        `Run \`harness resume ${idea.slug}\` to land the work, or inspect runs/${run.id}/build-${idea.slug}.{json,log}.`
    );
    recordMetric(`${intent}.failed`, 1);
    return "failed";
  } catch (err) {
    log.error(`✗ ${idea.slug} crashed:`, err);
    writeRunArtifact(run, `build-${idea.slug}.error.json`, {
      slug: idea.slug,
      intent,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    // Crashes (vs. failed builds) usually mean the session never landed any
    // work — safe to revert to `accepted` so the user can retry cleanly.
    if (intent !== "resume") {
      setStatus(idea.slug, "accepted", `Build crashed: ${(err as Error).message}`);
    }
    recordMetric(`${intent}.crashed`, 1);
    return "crashed";
  }
}
