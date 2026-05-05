/**
 * scripts/lib/sources/text.ts
 *
 * Inline-text source — the `harness capture "your idea here"` path.
 * Args are joined into a single title; notes come in via `--notes` if
 * the caller cares.
 */

import { Source, RawCapture } from "./types";

export const TextSource: Source = {
  id: "text",

  available(): boolean {
    return true;
  },

  async fetch(opts?: { project?: string; raw?: string }): Promise<RawCapture[]> {
    const title = (opts?.raw ?? "").trim();
    if (!title) return [];
    return [{ title, project: opts?.project }];
  },
};
