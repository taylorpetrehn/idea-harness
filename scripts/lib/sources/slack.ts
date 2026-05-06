/**
 * scripts/lib/sources/slack.ts
 *
 * Phase 4 capture source. Polls a Slack channel for messages tagged
 * with a specific reaction emoji (default ⭐ / `star`) and turns each
 * into a RawCapture. The reaction marks the human intent — "this is
 * an idea, not just a message" — so the bot doesn't slurp every
 * channel message.
 *
 * Env knobs:
 *   SLACK_BOT_TOKEN                 — required Bearer token
 *   IDEA_HARNESS_SLACK_CHANNEL      — required channel ID
 *   IDEA_HARNESS_SLACK_CAPTURE_EMOJI — emoji name (default "star")
 *   IDEA_HARNESS_SLACK_LOOKBACK_HOURS — how far back to scan (default 24)
 *
 * `acknowledge` posts a `eyes` reaction to the message so a re-poll
 * doesn't double-count. (We don't use `reactions.remove` of the
 * trigger emoji — that would alter the user's surface state. The
 * dedupe is by `external_id = "<channel>:<ts>"` instead.)
 *
 * No external SDK: uses built-in `fetch`. Tests inject a custom
 * fetcher via `setSlackFetch`.
 */

import { Source, RawCapture } from "./types";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

let fetcher: FetchLike = async (url, init) => {
  // Cast through unknown so the optional global fetch lines up.
  // Some bundlers / Node versions need this dance.
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("global fetch is unavailable; pass a fetcher via setSlackFetch");
  return f(url, init);
};

export function setSlackFetch(next: FetchLike): FetchLike {
  const prev = fetcher;
  fetcher = next;
  return prev;
}

const SLACK_API = "https://slack.com/api";

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  reactions?: Array<{ name: string; count: number; users?: string[] }>;
}

export const SlackSource: Source = {
  id: "slack",

  available(): boolean {
    return !!process.env.SLACK_BOT_TOKEN && !!process.env.IDEA_HARNESS_SLACK_CHANNEL;
  },

  async fetch(): Promise<RawCapture[]> {
    if (!this.available()) return [];
    const token = process.env.SLACK_BOT_TOKEN as string;
    const channel = process.env.IDEA_HARNESS_SLACK_CHANNEL as string;
    const emoji = (process.env.IDEA_HARNESS_SLACK_CAPTURE_EMOJI ?? "star").replace(/^:|:$/g, "");
    const hours = parseInt(process.env.IDEA_HARNESS_SLACK_LOOKBACK_HOURS ?? "24", 10);
    const oldest = (Date.now() / 1000 - hours * 3600).toFixed(3);

    const body = new URLSearchParams({ channel, oldest, limit: "200" });
    const res = await fetcher(`${SLACK_API}/conversations.history`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { ok?: boolean; messages?: SlackMessage[] };
    if (!data.ok || !Array.isArray(data.messages)) return [];

    const out: RawCapture[] = [];
    for (const m of data.messages) {
      if (!m.reactions?.some((r) => r.name === emoji)) continue;
      const alreadyConsumed = m.reactions?.some((r) => r.name === "eyes");
      if (alreadyConsumed) continue;
      const text = (m.text ?? "").trim();
      if (!text) continue;
      out.push({
        title: text.slice(0, 120),
        notes: text.length > 120 ? text : undefined,
        external_id: `${channel}:${m.ts}`,
      });
    }
    return out;
  },

  async acknowledge(capture: RawCapture): Promise<void> {
    if (!capture.external_id) return;
    if (!this.available()) return;
    const [channel, ts] = capture.external_id.split(":");
    if (!channel || !ts) return;
    const token = process.env.SLACK_BOT_TOKEN as string;
    const body = new URLSearchParams({ channel, timestamp: ts, name: "eyes" });
    await fetcher(`${SLACK_API}/reactions.add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  },
};
