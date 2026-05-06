/**
 * scripts/lib/sources/email.ts
 *
 * Phase 4 capture source. Polls a JSON-over-HTTPS email-inbox endpoint
 * (e.g., Cloudflare Email Workers, an SES-fronted Lambda, or your own
 * mail-to-API gateway) and turns each unread message into a
 * RawCapture. Acknowledge marks the message as consumed via a DELETE.
 *
 * Rationale for the JSON shape rather than direct IMAP: Node has no
 * built-in IMAP client. Pulling in `imapflow` or `mailparser` for
 * one source is too heavy. A small "email gateway" service is a
 * cleaner boundary — it's also what most folks operating idea
 * harnesses already have for forward-to-Slack flows.
 *
 * Env knobs:
 *   IDEA_HARNESS_EMAIL_ENDPOINT — required HTTPS endpoint that returns
 *     `{ messages: [{ id, subject, body }] }` on GET.
 *   IDEA_HARNESS_EMAIL_TOKEN    — bearer token, optional but recommended.
 *
 * Tests inject a custom fetcher via `setEmailFetch`.
 */

import { Source, RawCapture } from "./types";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

let fetcher: FetchLike = async (url, init) => {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("global fetch is unavailable; pass a fetcher via setEmailFetch");
  return f(url, init);
};

export function setEmailFetch(next: FetchLike): FetchLike {
  const prev = fetcher;
  fetcher = next;
  return prev;
}

interface EmailMessage {
  id: string;
  subject?: string;
  body?: string;
}

function buildHeaders(): Record<string, string> {
  const token = process.env.IDEA_HARNESS_EMAIL_TOKEN;
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export const EmailSource: Source = {
  id: "email",

  available(): boolean {
    return !!process.env.IDEA_HARNESS_EMAIL_ENDPOINT;
  },

  async fetch(): Promise<RawCapture[]> {
    if (!this.available()) return [];
    const endpoint = process.env.IDEA_HARNESS_EMAIL_ENDPOINT as string;
    const res = await fetcher(endpoint, { method: "GET", headers: buildHeaders() });
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: EmailMessage[] };
    if (!Array.isArray(data?.messages)) return [];

    const out: RawCapture[] = [];
    for (const m of data.messages) {
      const subject = (m.subject ?? "").trim();
      const body = (m.body ?? "").trim();
      const title = subject || body.split(/\n/, 1)[0]?.slice(0, 120) || "(no subject)";
      out.push({
        title: title.slice(0, 120),
        notes: body && body !== title ? body : undefined,
        external_id: m.id,
      });
    }
    return out;
  },

  async acknowledge(capture: RawCapture): Promise<void> {
    if (!capture.external_id) return;
    if (!this.available()) return;
    const endpoint = process.env.IDEA_HARNESS_EMAIL_ENDPOINT as string;
    await fetcher(`${endpoint}/${encodeURIComponent(capture.external_id)}`, {
      method: "DELETE",
      headers: buildHeaders(),
    });
  },
};
