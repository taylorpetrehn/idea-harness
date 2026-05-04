#!/usr/bin/env ts-node
/**
 * scripts/review.ts
 *
 * Helpers Claude uses during the conversational review step.
 *
 * Usage:
 *   npm run waiting              # list ideas with status: brainstormed
 *   npm run review next          # one-line summary of the next idea to review
 *   npm run review show <slug>   # full file contents for one idea
 *   npm run review accept <slug> [note]
 *   npm run review reject <slug> [note]
 *   npm run review thought <slug> [note]   # mark needs-more-thought, increment loop
 */

import {
  listIdeas,
  setStatus,
  readIdeaFile,
  incrementLoopCount,
  IdeaStatus,
} from "./lib/ideas";
import { recordMetric } from "./lib/metrics";
import { resetLoopCount, bumpLoopCount } from "./lib/loops";

const VALID_STATUSES: IdeaStatus[] = [
  "raw",
  "brainstormed",
  "needs-critic-review",
  "accepted",
  "rejected",
  "needs-more-thought",
  "building",
  "shipped",
];

const [, , command, ...args] = process.argv;

function nextWaiting() {
  const waiting = listIdeas("brainstormed").concat(listIdeas("needs-critic-review"));
  if (waiting.length === 0) {
    console.log("No ideas waiting.");
    process.exit(0);
  }
  const next = waiting[0];
  console.log(JSON.stringify(
    {
      slug: next.slug,
      title: next.title,
      status: next.status,
      recommended_action: next.recommended_action,
      confidence: next.confidence,
      simplest_version: next.if_accepted_build,
      brainstormed_at: next.brainstormed_at,
      total_waiting: waiting.length,
    },
    null,
    2
  ));
}

function listWaiting() {
  const waiting = listIdeas("brainstormed").concat(listIdeas("needs-critic-review"));
  if (waiting.length === 0) {
    console.log("No ideas waiting.");
    return;
  }
  for (const idea of waiting) {
    const tag = idea.status === "needs-critic-review" ? " [⚠ critic escalated]" : "";
    console.log(`${idea.slug}${tag}`);
    console.log(`  ${idea.title}`);
    if (idea.recommended_action) {
      console.log(`  → ${idea.recommended_action} (${idea.confidence})`);
    }
    if (idea.if_accepted_build) {
      console.log(`  build: ${idea.if_accepted_build}`);
    }
    console.log();
  }
}

if (command === "next") nextWaiting();
else if (command === "list") listWaiting();
else if (command === "show") {
  console.log(readIdeaFile(args[0]));
} else if (command === "accept") {
  const [slug, ...noteParts] = args;
  if (!slug) usageAndExit();
  setStatus(slug, "accepted", noteParts.join(" ") || undefined);
  resetLoopCount(slug);
  recordMetric("decision.accept", 1);
  console.log(`✓ ${slug} → accepted`);
} else if (command === "reject") {
  const [slug, ...noteParts] = args;
  if (!slug) usageAndExit();
  setStatus(slug, "rejected", noteParts.join(" ") || undefined);
  resetLoopCount(slug);
  recordMetric("decision.reject", 1);
  console.log(`✓ ${slug} → rejected`);
} else if (command === "thought") {
  const [slug, ...noteParts] = args;
  if (!slug) usageAndExit();
  setStatus(slug, "needs-more-thought", noteParts.join(" ") || undefined);
  const count = incrementLoopCount(slug);
  bumpLoopCount(slug);
  recordMetric("decision.needs_more_thought", 1);
  console.log(`✓ ${slug} → needs-more-thought (loop_count: ${count})`);
  if (count >= 3) {
    console.log(`⚠ This idea has bounced ${count} times. Next surfacing will escalate.`);
  }
} else if (command === "set") {
  const [slug, status, ...noteParts] = args;
  if (!slug || !status) usageAndExit();
  if (!VALID_STATUSES.includes(status as IdeaStatus)) {
    console.error(`Invalid status: ${status}`);
    console.error(`Valid: ${VALID_STATUSES.join(", ")}`);
    process.exit(2);
  }
  setStatus(slug, status as IdeaStatus, noteParts.join(" ") || undefined);
  recordMetric(`decision.${status.replace(/-/g, "_")}`, 1);
  console.log(`✓ ${slug} → ${status}`);
} else {
  usageAndExit();
}

function usageAndExit(): never {
  console.log(`Usage:
  review next                    JSON for the next idea to review
  review list                    list all waiting ideas
  review show <slug>             full file contents
  review accept <slug> [note]    mark accepted
  review reject <slug> [note]    mark rejected
  review thought <slug> [note]   mark needs-more-thought, ++loop_count
  review set <slug> <status>     set arbitrary status (advanced)`);
  process.exit(1);
}
