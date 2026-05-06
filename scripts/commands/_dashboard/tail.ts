/**
 * scripts/commands/_dashboard/tail.ts
 *
 * Multi-stream NDJSON tail for the dashboard's IN FLIGHT zone.
 *
 * Each active run has its own events.ndjson; the dashboard wants to see
 * the latest event from every active run simultaneously. Spawning one
 * Watcher per run keeps the polling cost trivial (~1KB read every
 * 400ms) while sidestepping the complexity of a shared kqueue/inotify
 * service.
 *
 * Watchers track byte position so re-reads are incremental, and split
 * incoming chunks on newlines so a poll boundary that lands mid-write
 * doesn't feed JSON.parse a half-line.
 */

import * as fs from "fs";
import type { ParsedEvent } from "./data";

export interface Watcher {
  /** runs/<id> — used as the watcher's stable key. */
  runId: string;
  eventsPath: string;
  /** Stop polling. Idempotent. */
  stop(): void;
}

export interface OpenWatcherOpts {
  runId: string;
  eventsPath: string;
  /** Called once per parsed event, in append order. */
  onEvent: (ev: ParsedEvent) => void;
  /** Polling interval; default 400ms (matches the watch TUI). */
  intervalMs?: number;
}

export function openWatcher(opts: OpenWatcherOpts): Watcher {
  const { runId, eventsPath, onEvent, intervalMs = 400 } = opts;

  let position = 0;
  let leftover = "";
  let stopped = false;

  const ingest = (line: string) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      onEvent({
        ts: parsed.ts ?? new Date().toISOString(),
        type: parsed.type ?? "unknown",
        data: parsed.data ?? {},
      });
    } catch {
      // skip malformed line
    }
  };

  const drainChunk = (chunk: string) => {
    const combined = leftover + chunk;
    const nl = combined.lastIndexOf("\n");
    if (nl < 0) {
      leftover = combined;
      return;
    }
    const complete = combined.slice(0, nl);
    leftover = combined.slice(nl + 1);
    for (const line of complete.split("\n")) ingest(line);
  };

  // Read existing contents synchronously so the watcher starts from "now"
  // rather than replaying history. Callers that want history should read
  // it themselves from disk before opening the watcher.
  if (fs.existsSync(eventsPath)) {
    try {
      const { size } = fs.statSync(eventsPath);
      position = size;
    } catch { /* no-op */ }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      if (!fs.existsSync(eventsPath)) return;
      const { size } = fs.statSync(eventsPath);
      if (size > position) {
        const fd = fs.openSync(eventsPath, "r");
        const buf = Buffer.alloc(size - position);
        fs.readSync(fd, buf, 0, size - position, position);
        fs.closeSync(fd);
        drainChunk(buf.toString("utf8"));
        position = size;
      } else if (size < position) {
        // File rotated/truncated underneath us — reset.
        position = 0;
        leftover = "";
      }
    } catch {
      // file vanished — keep polling
    }
  }, intervalMs);

  return {
    runId,
    eventsPath,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Manage a fleet of watchers keyed by runId. Pass the current set of
 * active runs each tick; watchers for new runs are spawned, watchers
 * for runs that finalized are stopped.
 */
export class WatcherFleet {
  private active = new Map<string, Watcher>();

  reconcile(
    targets: { runId: string; eventsPath: string }[],
    onEvent: (runId: string, ev: ParsedEvent) => void
  ): void {
    const wantedIds = new Set(targets.map((t) => t.runId));

    // Stop watchers whose runs are gone.
    for (const [id, w] of this.active) {
      if (!wantedIds.has(id)) {
        w.stop();
        this.active.delete(id);
      }
    }

    // Start watchers for new runs.
    for (const t of targets) {
      if (this.active.has(t.runId)) continue;
      const w = openWatcher({
        runId: t.runId,
        eventsPath: t.eventsPath,
        onEvent: (ev) => onEvent(t.runId, ev),
      });
      this.active.set(t.runId, w);
    }
  }

  stopAll(): void {
    for (const w of this.active.values()) w.stop();
    this.active.clear();
  }

  size(): number {
    return this.active.size;
  }
}
