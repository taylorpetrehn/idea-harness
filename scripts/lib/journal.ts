/**
 * scripts/lib/journal.ts
 *
 * runs/journal.ndjson — append-only audit log for every state change
 * across the harness. One JSON line per event. Lets `harness inspect
 * --since 1h` answer "what happened recently" without diffing
 * filesystem snapshots.
 *
 * Writers:
 *   - lib/ideas.ts on every status mutation
 *   - lib/graduator.ts on every build start/finish
 *   - commands/capture.ts on idea creation
 *
 * Callers should never read the journal directly — it's internal. The
 * `harness` verbs that need history surface it through a stable shape.
 */

import * as fs from "fs";
import * as path from "path";

const RUNS_DIR = path.join(__dirname, "..", "..", "runs");
const JOURNAL_PATH = path.join(RUNS_DIR, "journal.ndjson");

export interface JournalEntry {
  ts: string;
  type: string;
  slug?: string;
  data?: Record<string, unknown>;
}

export function appendJournal(entry: Omit<JournalEntry, "ts">): void {
  try {
    if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
    const full: JournalEntry = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(full) + "\n", "utf8");
  } catch {
    // Never let the journal block real work. A failed audit-log write
    // should warn at most; the caller's primary action proceeds.
  }
}

export function readJournal(opts: { since?: Date; limit?: number } = {}): JournalEntry[] {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  const raw = fs.readFileSync(JOURNAL_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as JournalEntry;
      if (opts.since && new Date(e.ts) < opts.since) continue;
      entries.push(e);
    } catch { /* skip malformed line */ }
  }
  if (opts.limit && entries.length > opts.limit) {
    return entries.slice(-opts.limit);
  }
  return entries;
}

export const JOURNAL_FILE = JOURNAL_PATH;

/**
 * Strip every entry for a given slug from the journal. Test-only —
 * production code should never modify the journal in place. Smokes
 * call this on teardown so the rolling TODAY feed doesn't accumulate
 * ghost entries from disposable test ideas. No-op if the journal
 * doesn't exist.
 */
export function purgeJournalForSlug(slug: string): void {
  if (!fs.existsSync(JOURNAL_PATH)) return;
  const raw = fs.readFileSync(JOURNAL_PATH, "utf8");
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as JournalEntry;
      if (e.slug === slug) continue;
    } catch {
      // keep malformed lines — better than silently dropping
    }
    kept.push(line);
  }
  fs.writeFileSync(JOURNAL_PATH, kept.length ? kept.join("\n") + "\n" : "", "utf8");
}
