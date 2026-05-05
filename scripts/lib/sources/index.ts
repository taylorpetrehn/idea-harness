/**
 * scripts/lib/sources/index.ts
 *
 * Source registry. Adding a new ingestion path is now: implement
 * `Source` in a sibling file, register it here, and `harness capture
 * --from <id>` works.
 */

import { Source } from "./types";
import { RemindersSource } from "./reminders";
import { StdinSource } from "./stdin";
import { TextSource } from "./text";
import { IssueSource } from "./issue";
import { SlackSource } from "./slack";

const REGISTRY: Source[] = [
  RemindersSource,
  StdinSource,
  TextSource,
  IssueSource,
  SlackSource,
];

export function listSources(): Source[] {
  return REGISTRY;
}

export function getSource(id: string): Source | null {
  return REGISTRY.find((s) => s.id === id) ?? null;
}

export { Source, RawCapture } from "./types";
