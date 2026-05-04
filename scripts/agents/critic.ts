/**
 * scripts/agents/critic.ts
 *
 * L5: Verification — qualitative half. Structural validation already ran
 * deterministically (lib/schema.ts) before this — if we got here, schema
 * is correct. The critic's job now is judgment-only: specificity,
 * context citation, verdict justification, variant differentiation,
 * honest hedging, sycophancy/padding patterns.
 *
 * Uses a smaller/cheaper model than the brainstormer.
 *
 * Outputs a verdict: pass | revise | escalate.
 */

import * as fs from "fs";
import * as path from "path";
import { Run } from "../lib/runs";
import { callCriticModel } from "../lib/llm";

const CONTRACTS_DIR = path.join(__dirname, "..", "..", "contracts");
const CRITIC_RUBRIC = readFileOrThrow(path.join(CONTRACTS_DIR, "critic-rubric.md"));
const BRAINSTORM_CONTRACT = readFileOrThrow(path.join(CONTRACTS_DIR, "brainstorm-output.md"));

function readFileOrThrow(p: string): string {
  if (!fs.existsSync(p)) throw new Error(`Required harness file missing: ${p}`);
  return fs.readFileSync(p, "utf8");
}

export type CriticVerdict = "pass" | "revise" | "escalate";

export interface CriticResult {
  verdict: CriticVerdict;
  checks: Record<string, "pass" | string>; // pass, or "fail: <reason>"
  feedback: string;
  tokensUsed: number;
}

export async function critique(opts: {
  brainstorm: string;
  rawIdea: string;
  run: Run;
}): Promise<CriticResult> {
  const { brainstorm, rawIdea } = opts;

  const prompt = `You are the critic agent in the idea harness. Your job is
to gate brainstorm output before it reaches Taylor. You do not regenerate
or improve — you only check.

A deterministic schema check has ALREADY validated structure (required
H3 sections, verdict-line format). Don't re-check structure — focus on
the qualitative checks below.

## Contract the brainstorm was written against (verbatim)

${BRAINSTORM_CONTRACT}

## Critic Rubric (verbatim)

${CRITIC_RUBRIC}

## The raw idea (for context)

${rawIdea}

## The brainstorm to check

${brainstorm}

## Your output
Return ONLY a JSON object with this shape:

{
  "verdict": "pass" | "revise" | "escalate",
  "checks": {
    "specificity": "pass" | "fail: <one-line reason citing the offending text>",
    "context_citation": "pass" | "fail: <reason>",
    "verdict_justification": "pass" | "fail: <reason>",
    "variant_differentiation": "pass" | "fail: <reason>",
    "honest_hedging": "pass" | "fail: <reason>",
    "forbidden_patterns": "pass" | "fail: <which pattern + where>"
  },
  "feedback": "<one paragraph telling the brainstormer what to fix, OR empty string if pass>"
}

Decision rules (apply mechanically):
- 0 failures → "pass"
- 1-2 fixable failures → "revise"
- 3+ failures, OR same failure repeated after a revision → "escalate"

Be strict but fair. Pass when the brainstorm is substantively useful for
Taylor's decision, even if not perfect. Reject only when there's a real
quality problem — and when you reject, quote the specific offending text
in your reason so the brainstormer knows what to change.`;

  const { output, tokensUsed } = await callCriticModel({ prompt });
  const parsed = parseCriticOutput(output);

  return { ...parsed, tokensUsed };
}

export function parseCriticOutput(raw: string): Omit<CriticResult, "tokensUsed"> {
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  const candidate = extractJsonObject(cleaned);
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      const verdict = isValidVerdict(obj.verdict) ? obj.verdict : "escalate";
      return {
        verdict,
        checks: typeof obj.checks === "object" && obj.checks ? obj.checks : {},
        feedback: typeof obj.feedback === "string" ? obj.feedback : "",
      };
    } catch {
      // fall through to escalate
    }
  }
  return {
    verdict: "escalate",
    checks: { parse_error: "fail: critic returned non-JSON output" },
    feedback: "Critic output could not be parsed. Manual review required.",
  };
}

function isValidVerdict(v: unknown): v is CriticVerdict {
  return v === "pass" || v === "revise" || v === "escalate";
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
