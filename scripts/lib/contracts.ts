/**
 * scripts/lib/contracts.ts
 *
 * Single source of truth for every JSON shape the harness emits.
 *
 * Agents consuming the CLI rely on the `harness/v1` envelope; bumping
 * `SCHEMA_VERSION` is a breaking change and should be paired with a
 * migration note in proposals/.
 *
 * Verb-specific data schemas live alongside their verb (in
 * scripts/commands/<verb>.ts) and are imported here at the bottom of
 * the file to keep `harness contracts` exhaustive without spreading
 * the registration boilerplate around.
 */

import { z } from "zod";

export const SCHEMA_VERSION = "harness/v1" as const;

// ── Error codes ─────────────────────────────────────────────────────
// One enum so error-handling code (CLI, MCP, HTTP) can switch on a
// finite set instead of pattern-matching message strings.

export const ErrorCode = z.enum([
  "BAD_INPUT",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "AMBIGUOUS_SLUG",
  "PROJECT_UNRESOLVED",
  "WORKTREE_FAILED",
  "BUILD_FAILED",
  "BUILD_TIMEOUT",
  "BUILD_CRASHED",
  "BRAINSTORM_FAILED",
  "SCHEMA_FAILED",
  "CRITIC_FAILED",
  "PERMISSION_DENIED",
  "ENV_MISSING",
  "LOCK_HELD",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HarnessError = z.object({
  code: ErrorCode,
  message: z.string(),
  recoverable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});
export type HarnessError = z.infer<typeof HarnessError>;

// ── Envelope ────────────────────────────────────────────────────────

export const SuccessEnvelope = z.object({
  schema: z.literal(SCHEMA_VERSION),
  verb: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
  warnings: z.array(z.string()).default([]),
  hint: z.string().optional(),
  duration_ms: z.number().optional(),
});
export type SuccessEnvelope = z.infer<typeof SuccessEnvelope>;

export const ErrorEnvelope = z.object({
  schema: z.literal(SCHEMA_VERSION),
  verb: z.string(),
  ok: z.literal(false),
  error: HarnessError,
  hint: z.string().optional(),
  duration_ms: z.number().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const Envelope = z.discriminatedUnion("ok", [SuccessEnvelope, ErrorEnvelope]);
export type Envelope = z.infer<typeof Envelope>;

// ── Event base ──────────────────────────────────────────────────────
// NDJSON event stream shape for long-running verbs (brainstorm, build).
// Each event is one JSON object on its own line, with a namespaced
// `type` and a free-form `data` payload that verb modules constrain.

export const HarnessEvent = z.object({
  schema: z.literal(SCHEMA_VERSION),
  verb: z.string(),
  ts: z.string(),  // ISO 8601
  type: z.string(),
  data: z.unknown(),
});
export type HarnessEvent = z.infer<typeof HarnessEvent>;

// ── Shared sub-types ────────────────────────────────────────────────
// Reusable fragments other verb schemas pull in.

export const IdeaStatusSchema = z.enum([
  "raw",
  "brainstormed",
  "needs-critic-review",
  "accepted",
  "rejected",
  "needs-more-thought",
  "building",
  "pr-open",
  "ci-running",
  "ci-failed",
  "review-changes-requested",
  "merged",
  "shipped",
]);
export type IdeaStatusSchemaT = z.infer<typeof IdeaStatusSchema>;

export const IdeaSummarySchema = z.object({
  filename: z.string(),
  slug: z.string(),
  id: z.string(),
  title: z.string(),
  status: IdeaStatusSchema,
  project: z.string(),
  captured_at: z.string(),
  brainstormed_at: z.string(),
  decided_at: z.string(),
  github_issue: z.string(),
  github_pr: z.string(),
  loop_count: z.number(),
  recommended_action: z.enum(["accept", "reject", "needs-more-thought"]).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  if_accepted_build: z.string().optional(),
});
export type IdeaSummarySchemaT = z.infer<typeof IdeaSummarySchema>;

// ── Registry ────────────────────────────────────────────────────────
// Verbs add their data schemas here at module load via `registerVerb`.
// `harness contracts` walks this registry to emit JSON Schema.

export interface VerbContract {
  verb: string;
  description: string;
  data: z.ZodTypeAny;
  events?: Record<string, z.ZodTypeAny>;
}

const REGISTRY = new Map<string, VerbContract>();

export function registerVerb(c: VerbContract): void {
  REGISTRY.set(c.verb, c);
}

export function listVerbContracts(): VerbContract[] {
  return Array.from(REGISTRY.values()).sort((a, b) => a.verb.localeCompare(b.verb));
}

export function getVerbContract(verb: string): VerbContract | undefined {
  return REGISTRY.get(verb);
}
