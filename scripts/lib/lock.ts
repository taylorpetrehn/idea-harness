/**
 * scripts/lib/lock.ts
 *
 * File-based concurrency lock. Used by long-running verbs that
 * shouldn't trample each other's state — chiefly `harness brainstorm`
 * (rewrites ideas/) and `harness ship`/`harness build` (mutates
 * worktrees and frontmatter).
 *
 * Lock files live at state/<name>.lock and contain { pid, started_at }.
 * Acquisition is O_EXCL; if the file exists, we check whether the
 * holder is alive — if not, the lock is stale and we steal it.
 *
 * Usage:
 *   const lock = acquireLock("brainstorm");
 *   try { ... } finally { lock.release(); }
 */

import * as fs from "fs";
import * as path from "path";

const STATE_DIR = path.join(__dirname, "..", "..", "state");

export interface Lock {
  readonly name: string;
  readonly path: string;
  release(): void;
}

export class LockHeldError extends Error {
  readonly heldBy: number;
  readonly startedAt: string;
  constructor(name: string, heldBy: number, startedAt: string) {
    super(`Lock "${name}" is held by pid ${heldBy} since ${startedAt}.`);
    this.name = "LockHeldError";
    this.heldBy = heldBy;
    this.startedAt = startedAt;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver a signal; just probes existence.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(name: string): Lock {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const lockPath = path.join(STATE_DIR, `${name}.lock`);
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Stale-lock check.
    let holder: { pid: number; started_at: string } = { pid: 0, started_at: "" };
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch { /* malformed — treat as stale */ }
    if (!holder.pid || !isProcessAlive(holder.pid)) {
      // Steal it.
      fs.writeFileSync(lockPath, payload, "utf8");
    } else {
      throw new LockHeldError(name, holder.pid, holder.started_at);
    }
  }

  let released = false;
  return {
    name,
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        // Only remove if WE still own it.
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (current.pid === process.pid) fs.unlinkSync(lockPath);
      } catch { /* ignore — best-effort cleanup */ }
    },
  };
}
