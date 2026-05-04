/**
 * scripts/lib/schema.ts
 *
 * Deterministic structural validation of brainstorm output against
 * contracts/brainstorm-output.md.
 *
 * Runs BEFORE the LLM critic. The critic is for qualitative judgment
 * (specificity, sycophancy, generic verdicts). The structural shape —
 * required headers, verdict line format — is mechanically checkable
 * and shouldn't burn critic tokens or trust the LLM to get it right.
 *
 * Live failure mode this fixes: in the dm-cohorts run the model invented
 * its own headers ("Effort estimate", "Fit with current focus", "Recommendation")
 * and used "**Verdict: build**" instead of "**Recommended action:** accept",
 * yet the LLM critic stamped pass. Downstream parsers then silently failed
 * to surface the verdict.
 */

export const REQUIRED_HEADERS = [
  "Problem",
  "Audience and frequency",
  "Existing footprint",
  "Simplest version",
  "Variants",
  "Risks and open questions",
  "Past idea overlap",
  "Verdict",
] as const;

export type SchemaCheckResult = {
  ok: boolean;
  failures: string[];
  /** Single human-readable feedback string suitable for handing back to the brainstormer for a revision pass. */
  feedback: string;
};

/**
 * Validate a brainstorm body. Body is the markdown produced by the
 * brainstormer (everything that would be inserted under "## Brainstorm").
 */
export function checkBrainstormSchema(body: string): SchemaCheckResult {
  const failures: string[] = [];

  // 1. All required H3 headers present, in order.
  const presentInOrder: string[] = [];
  let cursor = 0;
  for (const heading of REQUIRED_HEADERS) {
    const re = new RegExp(`^### ${escapeRegex(heading)}\\s*$`, "m");
    const match = body.slice(cursor).match(re);
    if (!match || match.index === undefined) {
      failures.push(`missing required section "### ${heading}"`);
      continue;
    }
    presentInOrder.push(heading);
    cursor += match.index + match[0].length;
  }

  // 2. Verdict block: exact 4 bold-prefixed lines, in order, with allowed values.
  const verdictBlock = extractVerdictBlock(body);
  if (!verdictBlock) {
    failures.push(
      `verdict block missing — must end with **Recommended action:**, **Confidence:**, **Why:**, **If accepted, build:** lines`
    );
  } else {
    const action = verdictBlock.action?.toLowerCase();
    if (!action) {
      failures.push(`"**Recommended action:**" line missing or malformed`);
    } else if (!["accept", "reject", "needs-more-thought"].includes(action)) {
      failures.push(
        `"**Recommended action:**" must be one of accept | reject | needs-more-thought (got "${action}")`
      );
    }

    const confidence = verdictBlock.confidence?.toLowerCase();
    if (!confidence) {
      failures.push(`"**Confidence:**" line missing or malformed`);
    } else if (!["high", "medium", "low"].includes(confidence)) {
      failures.push(
        `"**Confidence:**" must be one of high | medium | low (got "${confidence}")`
      );
    }

    if (!verdictBlock.why || verdictBlock.why.length < 10) {
      failures.push(`"**Why:**" line missing or too short`);
    }

    if (!verdictBlock.build || verdictBlock.build.length < 5) {
      failures.push(
        `"**If accepted, build:**" line missing — must name simplest version or a variant`
      );
    }
  }

  // 3. Headers we DON'T want — quick check for the drift patterns we've seen.
  const driftHeaders = ["Recommendation", "Effort estimate", "Fit with current focus"];
  for (const h of driftHeaders) {
    if (new RegExp(`^### ${escapeRegex(h)}\\s*$`, "m").test(body)) {
      failures.push(
        `non-canonical section "### ${h}" — fold its content into the required sections (Verdict / Risks / Variants)`
      );
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    feedback: failures.length === 0 ? "" : buildFeedback(failures),
  };
}

interface VerdictBlock {
  action: string | null;
  confidence: string | null;
  why: string | null;
  build: string | null;
}

function extractVerdictBlock(body: string): VerdictBlock | null {
  const action = matchBoldLine(body, "Recommended action");
  const confidence = matchBoldLine(body, "Confidence");
  const why = matchBoldLine(body, "Why");
  const build = matchBoldLine(body, "If accepted, build");
  if (!action && !confidence && !why && !build) return null;
  return { action, confidence, why, build };
}

function matchBoldLine(body: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)`, "i");
  const m = body.match(re);
  return m ? m[1].trim().replace(/\*+$/, "").trim() : null;
}

function buildFeedback(failures: string[]): string {
  return (
    "Schema check failed. Fix these specific issues and re-emit the full brainstorm:\n" +
    failures.map((f) => `  - ${f}`).join("\n") +
    "\n\nThe contract requires these H3 sections in order: " +
    REQUIRED_HEADERS.map((h) => `### ${h}`).join(", ") +
    ". The verdict MUST end with these four lines, exactly:\n" +
    "**Recommended action:** accept | reject | needs-more-thought\n" +
    "**Confidence:** high | medium | low\n" +
    "**Why:** <one sentence specific to this idea>\n" +
    "**If accepted, build:** <simplest version | variant 1 | variant 2 | etc>"
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
