/**
 * scripts/agents/harvester.ts
 *
 * Tiny stage between L2 (control) and L4 (execution).
 * Takes a HarvestItem from the run plan and creates the corresponding
 * raw idea file on disk. Marks the source Reminder complete.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { HarvestItem } from "./initializer";
import { Run } from "../lib/runs";
import { slugify } from "../lib/text";
import { completeReminder } from "../lib/reminders";
import { log } from "../lib/log";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

function newId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export async function harvest(item: HarvestItem, run: Run): Promise<void> {
  const id = newId();
  const slug = `${slugify(item.title)}-${id.slice(0, 4)}`;
  const filepath = path.join(IDEAS_DIR, `${slug}.md`);

  const project = item.project ?? "letsbarker"; // default; conversational review can correct

  const content = `---
id: ${id}
title: "${item.title.replace(/"/g, '\\"')}"
status: raw
source: reminders
project: ${project}
captured_at: ${new Date().toISOString()}
brainstormed_at: ~
decided_at: ~
github_issue: ~
loop_count: 0
---

## Raw Idea

${item.title}
${item.notes ? "\n## Notes\n\n" + item.notes + "\n" : ""}
## Brainstorm

<!-- Filled by the brainstormer. -->
`;

  fs.writeFileSync(filepath, content, "utf8");
  log.info(`  ✓ Harvested: ${slug}.md`);

  // Mark Reminder complete — failure here shouldn't block the harvest
  try {
    await completeReminder(item.reminder_id);
  } catch (err) {
    log.warn(`  Could not mark reminder complete: ${err}`);
  }
}
