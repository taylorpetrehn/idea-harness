/**
 * scripts/lib/sources/issue.ts
 *
 * GitHub issue source. Resolves via `gh issue view <url> --json title,body,url`.
 * Requires gh to be installed and authenticated; surface that via doctor.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { Source, RawCapture } from "./types";

const execFileAsync = promisify(execFile);

export const IssueSource: Source = {
  id: "issue",

  available(): boolean {
    // Best-effort: probing `which gh` on every list call would be
    // wasteful. Treat as available; fetch() surfaces a clean error if
    // gh is absent.
    return true;
  },

  async fetch(opts?: { raw?: string; project?: string }): Promise<RawCapture[]> {
    const url = opts?.raw?.trim();
    if (!url) {
      throw new Error("issue source requires a URL or `org/repo#N` identifier");
    }
    let stdout: string;
    try {
      const result = await execFileAsync(
        "gh",
        ["issue", "view", url, "--json", "title,body,url"],
        { encoding: "utf8" }
      );
      stdout = result.stdout;
    } catch (err) {
      throw new Error(
        `gh issue view failed for ${url}: ${(err as Error).message.trim()}. ` +
          `Install gh and run \`gh auth login\` if you haven't.`
      );
    }
    const parsed = JSON.parse(stdout) as { title: string; body: string; url: string };
    return [{
      title: parsed.title,
      notes: parsed.body || undefined,
      external_id: parsed.url,
      project: opts?.project,
    }];
  },
};
