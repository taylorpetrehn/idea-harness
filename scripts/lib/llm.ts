/**
 * scripts/lib/llm.ts
 *
 * Thin adapter layer for model calls. Two clients, deliberately:
 *   - Brainstormer: a strong reasoning model (Opus-class). Quality matters.
 *   - Critic: a small, cheap model. Speed and cost matter.
 *
 * This file is the ONLY place model identifiers live. Swapping models
 * should not require touching agent code.
 *
 * Three transport modes, picked at runtime:
 *
 *   1. SDK         — set `ANTHROPIC_API_KEY` to use @anthropic-ai/sdk directly.
 *                    Lowest latency, gives real token counts.
 *   2. Claude CLI  — default when no API key is set: shells out to
 *                    `claude --print --model <m> --system-prompt <s>`.
 *                    Uses whatever auth the user has configured for the CLI
 *                    (subscription / OAuth / keychain). Forced via
 *                    `IDEA_HARNESS_LLM=cli`. Token counts are best-effort:
 *                    parsed from `--output-format json` when available.
 *   3. Offline     — `IDEA_HARNESS_LLM=offline` (or no API key + no CLI):
 *                    deterministic stubs, used by tests and dry runs.
 *
 * Other env knobs:
 *   IDEA_HARNESS_BRAINSTORMER_MODEL — model id (default claude-opus-4-7)
 *   IDEA_HARNESS_CRITIC_MODEL       — model id (default claude-haiku-4-5-...)
 *   IDEA_HARNESS_BRAINSTORMER_MAX_TOKENS / IDEA_HARNESS_CRITIC_MAX_TOKENS
 *   IDEA_HARNESS_CLAUDE_BIN         — path to the `claude` binary
 *   IDEA_HARNESS_CLAUDE_TIMEOUT_MS  — per-call timeout (default 300000)
 */

import { spawn } from "child_process";
import * as fs from "fs";
import { ContextRequest } from "../agents/brainstormer";
import { log } from "./log";

const DEFAULT_MODELS = {
  brainstormer: "claude-opus-4-7",
  critic: "claude-haiku-4-5-20251001",
};

const MODELS = {
  brainstormer: process.env.IDEA_HARNESS_BRAINSTORMER_MODEL ?? DEFAULT_MODELS.brainstormer,
  critic: process.env.IDEA_HARNESS_CRITIC_MODEL ?? DEFAULT_MODELS.critic,
};

const MAX_TOKENS = {
  brainstormer: parseIntEnv("IDEA_HARNESS_BRAINSTORMER_MAX_TOKENS", 4096),
  critic: parseIntEnv("IDEA_HARNESS_CRITIC_MAX_TOKENS", 1024),
};

type Mode = "offline" | "sdk" | "cli";

function resolveMode(): Mode {
  const explicit = process.env.IDEA_HARNESS_LLM?.toLowerCase();
  if (explicit === "offline") return "offline";
  if (explicit === "sdk") return "sdk";
  if (explicit === "cli") return "cli";
  if (process.env.ANTHROPIC_API_KEY) return "sdk";
  return cliAvailable() ? "cli" : "offline";
}

let cachedCliBin: string | null | undefined;
function claudeBin(): string | null {
  if (cachedCliBin !== undefined) return cachedCliBin;
  const explicit = process.env.IDEA_HARNESS_CLAUDE_BIN;
  if (explicit && fs.existsSync(explicit)) {
    cachedCliBin = explicit;
    return cachedCliBin;
  }
  // Let PATH resolution happen in spawn; record the literal name.
  cachedCliBin = "claude";
  return cachedCliBin;
}

function cliAvailable(): boolean {
  // We can't synchronously stat a PATH binary cheaply; assume present if
  // the env explicitly points at one, or trust spawn() to fail loudly.
  if (process.env.IDEA_HARNESS_CLAUDE_BIN) return fs.existsSync(process.env.IDEA_HARNESS_CLAUDE_BIN);
  return true;
}

export interface BrainstormerResponse {
  output: string;
  tokensUsed: number;
  contextRequests: ContextRequest[];
}

export async function callBrainstormerModel(opts: {
  prompt: string;
  budgetTokens: number;
}): Promise<BrainstormerResponse> {
  const mode = resolveMode();
  if (mode === "offline") return offlineBrainstorm(opts.prompt);

  const { text, tokensUsed } =
    mode === "sdk"
      ? await callSdk(MODELS.brainstormer, MAX_TOKENS.brainstormer, opts.prompt)
      : await callCli(MODELS.brainstormer, opts.prompt);

  return {
    output: stripContextRequests(text),
    tokensUsed,
    contextRequests: extractContextRequests(text),
  };
}

export interface CriticResponse {
  output: string;
  tokensUsed: number;
}

export async function callCriticModel(opts: { prompt: string }): Promise<CriticResponse> {
  const mode = resolveMode();
  if (mode === "offline") return offlineCritic();

  const { text, tokensUsed } =
    mode === "sdk"
      ? await callSdk(MODELS.critic, MAX_TOKENS.critic, opts.prompt)
      : await callCli(MODELS.critic, opts.prompt);

  return { output: text, tokensUsed };
}

// ── SDK transport (lazy import so the dep is optional) ────────────────

async function callSdk(
  model: string,
  maxTokens: number,
  prompt: string
): Promise<{ text: string; tokensUsed: number }> {
  let Anthropic: any;
  try {
    Anthropic = (await import("@anthropic-ai/sdk")).default;
  } catch (err) {
    throw new Error(
      "@anthropic-ai/sdk is not installed. Either `npm install @anthropic-ai/sdk` " +
        "or unset ANTHROPIC_API_KEY to use the Claude CLI transport instead."
    );
  }
  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  return {
    text,
    tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
  };
}

// ── Claude CLI transport ──────────────────────────────────────────────

const CLI_TIMEOUT_MS = parseIntEnv("IDEA_HARNESS_CLAUDE_TIMEOUT_MS", 300_000);

const SYSTEM_PROMPT =
  "You are an agent inside the LetsBarker idea harness. Follow the user " +
  "message exactly. Produce ONLY the requested output — no preamble, no " +
  "tool calls, no shell commands. Do not ask follow-up questions.";

async function callCli(
  model: string,
  prompt: string
): Promise<{ text: string; tokensUsed: number }> {
  const bin = claudeBin();
  if (!bin) throw new Error("Claude CLI binary not found");

  const args = [
    "--print",
    "--model",
    model,
    "--system-prompt",
    SYSTEM_PROMPT,
    "--output-format",
    "json",
    // Intentionally NOT passing --bare: that flag forces auth via
    // ANTHROPIC_API_KEY only and disables keychain/OAuth, which defeats
    // the point of the CLI transport (use whatever auth `claude` already has).
  ];

  log.debug(`llm: invoking ${bin} ${args.slice(0, 4).join(" ")}…`);

  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(new Error(`Claude CLI exited ${code}${tail ? `\n${tail}` : ""}`));
        return;
      }
      try {
        resolve(parseCliOutput(stdout));
      } catch (err) {
        reject(err as Error);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseCliOutput(raw: string): { text: string; tokensUsed: number } {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Claude CLI returned empty output");

  // --output-format json yields one JSON object per call. Be tolerant: if
  // the user has flipped to text or stream-json, fall back to raw text.
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      // The CLI returns is_error: true with the message in `result` when
      // auth or upstream API calls fail — surface that as a thrown error
      // so the harness records a brainstorm.error rather than a malformed
      // brainstorm.
      if (obj.is_error === true) {
        const msg = typeof obj.result === "string" && obj.result.trim()
          ? obj.result.trim()
          : `Claude CLI returned is_error=true (status=${obj.api_error_status ?? "unknown"})`;
        throw new Error(`Claude CLI: ${msg}`);
      }
      const text = extractText(obj);
      const tokensUsed = extractTokens(obj);
      if (text) return { text, tokensUsed };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Claude CLI:")) throw err;
      // JSON parse / shape problem — fall through to raw text.
    }
  }
  return { text: trimmed, tokensUsed: 0 };
}

function extractText(obj: any): string {
  if (!obj || typeof obj !== "object") return "";
  if (typeof obj.result === "string") return obj.result;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter((b: any) => b && b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n");
  }
  return "";
}

function extractTokens(obj: any): number {
  const usage = obj?.usage ?? obj?.total_usage ?? null;
  if (!usage) return 0;
  const i = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const o = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  return (Number.isFinite(i) ? i : 0) + (Number.isFinite(o) ? o : 0);
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function extractContextRequests(text: string): ContextRequest[] {
  const requests: ContextRequest[] = [];
  const re = /\{\s*"tool"\s*:\s*"context_request"[\s\S]*?\}/g;
  const matches = text.match(re) ?? [];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m);
      if (!obj.kind || !obj.target) continue;
      requests.push({
        tier: obj.tier === 3 ? 3 : 2,
        kind: obj.kind,
        target: String(obj.target),
        reason: String(obj.reason ?? ""),
        loaded_at: new Date().toISOString(),
      });
    } catch {
      // ignore malformed
    }
  }
  return requests;
}

export function stripContextRequests(text: string): string {
  return text.replace(/\{\s*"tool"\s*:\s*"context_request"[\s\S]*?\}\s*/g, "").trim();
}

function offlineBrainstorm(prompt: string): BrainstormerResponse {
  const titleMatch = prompt.match(/Raw capture:\n([^\n]+)/);
  const title = titleMatch ? titleMatch[1].trim() : "(unknown)";
  const output = [
    "### Problem",
    `Offline stub for "${title}" — set ANTHROPIC_API_KEY or install the Claude CLI for real brainstorms.`,
    "",
    "### Audience and frequency",
    "(stub) audience and frequency information not generated in offline mode.",
    "",
    "### Existing footprint",
    "(stub) no codebase scan performed in offline mode.",
    "",
    "### Simplest version",
    "(stub) The simplest version cannot be specified without product context.",
    "",
    "### Variants",
    "1. Stub variant A — placeholder.",
    "2. Stub variant B — placeholder.",
    "",
    "### Risks and open questions",
    "Running in offline mode — the brainstorm has no real content.",
    "",
    "### Past idea overlap",
    "None checked.",
    "",
    "### Verdict",
    "**Recommended action:** needs-more-thought",
    "**Confidence:** low",
    "**Why:** Offline stub — no real evaluation performed.",
    "**If accepted, build:** simplest version",
  ].join("\n");
  return { output, tokensUsed: 0, contextRequests: [] };
}

function offlineCritic(): CriticResponse {
  const verdict = {
    verdict: "escalate",
    checks: {
      schema_completeness: "fail: offline stub did not produce real content",
      specificity: "fail: offline stub",
      context_citation: "fail: offline stub",
      verdict_justification: "fail: offline stub",
      variant_differentiation: "fail: offline stub",
      honest_hedging: "pass",
      forbidden_patterns: "pass",
    },
    feedback: "Critic ran in offline mode — no real evaluation performed.",
  };
  return { output: JSON.stringify(verdict), tokensUsed: 0 };
}
