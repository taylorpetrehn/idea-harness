/**
 * scripts/lib/events.ts
 *
 * Per-run event log. Every long-running verb (brainstorm, build, ship)
 * opens a `RunEvents` once, then calls `emit(type, data)` at every
 * lifecycle moment. Each emission:
 *   1. Appends a JSON line to runs/<id>/events.ndjson — the durable
 *      audit log. `harness build watch` tails this.
 *   2. Forwards through the Output instance so it surfaces in the
 *      caller's selected mode (pretty / json / ndjson).
 *
 * The same shape that goes on stdout in --ndjson mode also goes into
 * the file — so you can replay a session post-hoc and get the same
 * picture an attached agent saw live.
 */

import * as fs from "fs";
import * as path from "path";
import { Run } from "./runs";
import { Output } from "./output";
import { HarnessEvent, SCHEMA_VERSION } from "./contracts";

export interface RunEvents {
  /** Absolute path to the events.ndjson for this run. */
  readonly filepath: string;
  /** Emit one event. Persists to the file AND forwards to the Output. */
  emit(type: string, data?: unknown): void;
  /** Close the file handle. Safe to call multiple times. */
  close(): void;
}

export function openRunEvents(run: Run, verb: string, out: Output): RunEvents {
  const filepath = path.join(run.dir, "events.ndjson");
  if (!fs.existsSync(run.dir)) fs.mkdirSync(run.dir, { recursive: true });
  // Append mode so a prior run's events file (e.g. on resume) isn't clobbered.
  const fd = fs.openSync(filepath, "a");
  let closed = false;

  return {
    filepath,
    emit(type, data = {}) {
      const evt: HarnessEvent = {
        schema: SCHEMA_VERSION,
        verb,
        ts: new Date().toISOString(),
        type,
        data,
      };
      const line = JSON.stringify(evt) + "\n";
      try {
        if (!closed) fs.writeSync(fd, line);
      } catch {
        // never let a logging failure crash the verb.
      }
      out.event(type, data);
    },
    close() {
      if (closed) return;
      closed = true;
      try { fs.closeSync(fd); } catch { /* ignore */ }
    },
  };
}
