/**
 * scripts/lib/atomic.ts
 *
 * Atomic file writes via temp + rename. POSIX guarantees rename within
 * the same filesystem is atomic, so a crash mid-write either leaves
 * the old file intact or the new file complete — never a half-written
 * frontmatter that breaks parseIdeaFile.
 *
 * Use everywhere we modify state files (ideas, state/*.json, run
 * artifacts that other processes might read).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export function atomicWriteFileSync(filepath: string, data: string | Buffer, encoding: BufferEncoding = "utf8"): void {
  const dir = path.dirname(filepath);
  const base = path.basename(filepath);
  const tmp = path.join(dir, `.${base}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  if (typeof data === "string") {
    fs.writeFileSync(tmp, data, encoding);
  } else {
    fs.writeFileSync(tmp, data);
  }
  try {
    fs.renameSync(tmp, filepath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}
