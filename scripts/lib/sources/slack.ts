/**
 * scripts/lib/sources/slack.ts
 *
 * Stub source. Slack ingestion isn't wired yet — phase 5 lays out the
 * interface so a future PR can drop in a Slack adapter (likely via the
 * Slack MCP) without touching the dispatcher in commands/capture.ts.
 *
 * `available()` is false so `harness capture --from slack` returns a
 * clean BAD_INPUT until this lands.
 */

import { Source, RawCapture } from "./types";

export const SlackSource: Source = {
  id: "slack",

  available(): boolean {
    return false;
  },

  async fetch(): Promise<RawCapture[]> {
    throw new Error(
      "slack source is not implemented. Drop a Slack MCP adapter in lib/sources/slack.ts."
    );
  },
};
