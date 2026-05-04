/**
 * scripts/lib/loops.ts
 *
 * Loop detection state. Counts how many times each idea has bounced
 * back to needs-more-thought. Stored at state/loops.json so it survives
 * across runs.
 *
 * The loop_count is also mirrored on the idea file frontmatter — this
 * file is the durable state for the harness, the frontmatter is the
 * human-readable display.
 */

import * as fs from "fs";
import * as path from "path";

const STATE_DIR = path.join(__dirname, "..", "..", "state");
const LOOPS_FILE = path.join(STATE_DIR, "loops.json");

export type LoopState = Record<string, number>;

export function getLoopState(): LoopState {
  if (!fs.existsSync(LOOPS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOOPS_FILE, "utf8")) as LoopState;
  } catch {
    return {};
  }
}

export function setLoopCount(slug: string, count: number): void {
  const state = getLoopState();
  if (count <= 0) {
    delete state[slug];
  } else {
    state[slug] = count;
  }
  writeLoopState(state);
}

export function bumpLoopCount(slug: string): number {
  const state = getLoopState();
  const next = (state[slug] ?? 0) + 1;
  state[slug] = next;
  writeLoopState(state);
  return next;
}

export function resetLoopCount(slug: string): void {
  const state = getLoopState();
  if (slug in state) {
    delete state[slug];
    writeLoopState(state);
  }
}

function writeLoopState(state: LoopState): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LOOPS_FILE, JSON.stringify(state, null, 2), "utf8");
}
