/**
 * scripts/agents/critic.ts
 *
 * L5: Verification. Checks the brainstorm against contracts/critic-rubric.md.
 * Uses a smaller/cheaper model than the brainstormer.
 *
 * Outputs a verdict: pass | revise | escalate.
 */

import { Run } from "../lib/runs";
import { callCriticModel } from "../lib/llm";

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

You are following contracts/critic-rubric.md.

## Required checks

1. schema_completeness — all required sections present, in order, with content
2. specificity — "Simplest version" names a concrete artifact (screen, CTA, field)
3. context_citation — references product.md, decisions.md, or a specific past idea
4. verdict_justification — "Why:" sentence is specific to THIS idea, not generic
5. variant_differentiation — variants meaningfully differ in scope or approach
6. honest_hedging — if "needs-more-thought", names what's specifically missing
7. forbidden_patterns — no sycophancy, hedging without commitment, generic verdicts,
   schema reproduction, or padding

## Decision rules
- 0 failures → "pass"
- 1-2 fixable failures → "revise"
- 3+ failures, OR same failure repeated after a revision → "escalate"

## The raw idea (for context)
${rawIdea}

## The brainstorm to check
${brainstorm}

## Your output
Return ONLY a JSON object with this shape:

{
  "verdict": "pass" | "revise" | "escalate",
  "checks": {
    "schema_completeness": "pass" | "fail: <reason>",
    "specificity": "pass" | "fail: <reason>",
    "context_citation": "pass" | "fail: <reason>",
    "verdict_justification": "pass" | "fail: <reason>",
    "variant_differentiation": "pass" | "fail: <reason>",
    "honest_hedging": "pass" | "fail: <reason>",
    "forbidden_patterns": "pass" | "fail: <reason>"
  },
  "feedback": "<one paragraph telling the brainstormer what to fix, OR empty if pass>"
}

Be a strict but fair auditor. Pass the brainstorm if it's substantively
useful for Taylor's decision, even if not perfect. Reject only when there's
a real quality problem.`;

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
