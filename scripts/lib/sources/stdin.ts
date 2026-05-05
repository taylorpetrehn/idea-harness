/**
 * scripts/lib/sources/stdin.ts
 *
 * Stdin source. Accepts:
 *   - JSON object   {"title": "...", "notes": "...", "project": "..."}
 *   - JSON array    [{"title": "..."}, ...]
 *   - Plain text    one idea per line
 */

import { Source, RawCapture } from "./types";

async function readAll(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

export const StdinSource: Source = {
  id: "stdin",

  available(): boolean {
    return !process.stdin.isTTY;
  },

  async fetch(opts?: { project?: string; raw?: string }): Promise<RawCapture[]> {
    const raw = (opts?.raw ?? (await readAll())).trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .map((p): RawCapture => ({
          title: String(p.title ?? "").trim(),
          notes: p.notes ?? undefined,
          project: p.project ?? opts?.project,
        }))
        .filter((c) => !!c.title);
    } catch {
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((title) => ({ title, project: opts?.project }));
    }
  },
};
