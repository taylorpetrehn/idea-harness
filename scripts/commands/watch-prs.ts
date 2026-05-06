/**
 * scripts/commands/watch-prs.ts
 *
 * `harness watch-prs` — Phase 3 daemon.
 *
 * Long-running loop that calls `runFollow` every `--interval`
 * seconds (default 300). Exits cleanly on SIGINT/SIGTERM. Runs
 * indefinitely otherwise.
 *
 * Honors `IDEA_HARNESS_AUTO_FOLLOW=true` exactly like the one-shot
 * `harness follow` verb — without it, every cycle is a dry probe.
 *
 * Webhook receivers were called out as a follow-on in the roadmap
 * but are out of scope here; this poll-based daemon is the first cut.
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { runFollow } from "./follow";

export interface WatchPrsArgs {
  interval?: number;
  /** Optional limit on cycles. Mainly for tests; production uses Infinity. */
  maxCycles?: number;
}

const WatchPrsData = z.object({
  cycles: z.number(),
  stopped: z.enum(["signal", "max-cycles"]),
});

registerVerb({
  verb: "watch-prs",
  description: "Daemon mode: poll open PRs and act on them on an interval.",
  data: WatchPrsData,
});

export async function runWatchPrs(args: WatchPrsArgs, out: Output): Promise<void> {
  const intervalSec = args.interval ?? 300;
  const intervalMs = Math.max(5_000, intervalSec * 1000);
  const maxCycles = args.maxCycles ?? Number.POSITIVE_INFINITY;

  let cycles = 0;
  let shouldStop = false;
  let stopReason: "signal" | "max-cycles" = "signal";
  const onSignal = () => { shouldStop = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (out.mode === "pretty") {
    out.stdout(`harness watch-prs — interval=${intervalSec}s\n`);
  }

  try {
    while (!shouldStop && cycles < maxCycles) {
      cycles += 1;
      if (out.mode === "pretty") {
        out.stdout(`\n[cycle ${cycles}] ${new Date().toISOString()}\n`);
      }
      try {
        // runFollow's structured envelope would clobber the daemon's
        // own envelope, so we run it in a side-channel Output that
        // discards stdout / result. warn/error still propagate up
        // because the actual class instance is shared.
        await runFollow({}, makeQuietOutput(out));
      } catch (err) {
        out.warn(`cycle ${cycles} failed: ${(err as Error).message}`);
      }
      if (cycles >= maxCycles) {
        stopReason = "max-cycles";
        break;
      }
      // Sleep with early-wake on signal.
      await sleepUntilSignal(intervalMs, () => shouldStop);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  out.result({ cycles, stopped: stopReason });
}

/** runFollow's pretty output is per-cycle progress; in daemon mode we
 *  want the cycle banner from us, not duplicate per-call summaries.
 *  Returns a Proxy over the parent Output that no-ops `stdout` and
 *  `result` while delegating everything else. */
function makeQuietOutput(parent: Output): Output {
  return new Proxy(parent, {
    get(target, prop, receiver) {
      if (prop === "stdout") return () => {};
      if (prop === "result") return () => {};
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function sleepUntilSignal(ms: number, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (isStopped()) return resolve();
    const start = Date.now();
    const timer = setInterval(() => {
      if (isStopped() || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}
