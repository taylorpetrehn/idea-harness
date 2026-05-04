/**
 * scripts/commands/capture.ts
 *
 * `harness capture` — add a new idea to the harness.
 *
 * Sources (selected with --from):
 *   reminders  Apple Reminders "App Ideas" list (default on macOS)
 *   stdin      pipe in plain text or JSON {title, notes?, project?}
 *   issue      gh issue view <url> (NOT YET — phase 5)
 *   text       inline text from positional args
 *
 * Capture writes a `status: raw` idea file. The next `harness brainstorm`
 * run picks it up. Capture does NOT spawn LLMs — it's pure ingestion.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { slugify } from "../lib/text";
import { listReminders, completeReminder } from "../lib/reminders";
import { resolveProject } from "../lib/projects";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

export interface CaptureArgs {
  text?: string[];
  from?: "reminders" | "stdin" | "issue" | "text";
  project?: string;
}

const CapturedIdea = z.object({
  slug: z.string(),
  filename: z.string(),
  id: z.string(),
  title: z.string(),
  project: z.string(),
});

const CaptureData = z.object({
  source: z.string(),
  captured: z.array(CapturedIdea),
  count: z.number(),
});

registerVerb({
  verb: "capture",
  description: "Capture a new idea from CLI text, stdin, or an external source.",
  data: CaptureData,
});

interface RawCapture {
  title: string;
  notes?: string;
  project?: string;
  reminder_id?: string;
}

function newId(): string {
  return crypto.randomBytes(4).toString("hex");
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

async function gather(args: CaptureArgs, out: Output): Promise<RawCapture[]> {
  const source = args.from ?? (args.text && args.text.length > 0 ? "text" : "reminders");

  switch (source) {
    case "text": {
      const title = (args.text ?? []).join(" ").trim();
      if (!title) {
        out.error("BAD_INPUT", "No text provided.", {
          hint: 'Usage: `harness capture "your idea here"` or pipe via --from stdin.',
        });
        return [];
      }
      return [{ title, project: args.project }];
    }

    case "stdin": {
      const raw = (await readStdin()).trim();
      if (!raw) {
        out.error("BAD_INPUT", "stdin was empty.");
        return [];
      }
      // Accept either a JSON {title, notes?, project?} or plain text (one
      // idea per line).
      try {
        const parsed = JSON.parse(raw);
        const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
        return arr
          .map((p): RawCapture => ({
            title: String(p.title ?? "").trim(),
            notes: p.notes ?? undefined,
            project: p.project ?? args.project,
          }))
          .filter((c) => !!c.title);
      } catch {
        return raw
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((title) => ({ title, project: args.project }));
      }
    }

    case "reminders": {
      const reminders = await listReminders();
      return reminders.map((r) => ({
        title: r.title,
        notes: r.notes ?? undefined,
        reminder_id: r.id,
        project: args.project,
      }));
    }

    case "issue":
      out.error("BAD_INPUT", "`--from issue` lands in phase 5.", {
        hint: "Workaround: copy the issue title and use `harness capture <text>`.",
      });
      return [];

    default:
      out.error("BAD_INPUT", `Unknown --from source "${source}".`, {
        hint: "Valid sources: reminders | stdin | issue | text",
      });
      return [];
  }
}

function writeIdea(c: RawCapture): z.infer<typeof CapturedIdea> {
  const id = newId();
  const slug = `${slugify(c.title)}-${id.slice(0, 4)}`;
  const filepath = path.join(IDEAS_DIR, `${slug}.md`);
  const project = c.project ?? resolveProject(c.title, c.notes ?? "") ?? "letsbarker";

  const content = `---
id: ${id}
title: "${c.title.replace(/"/g, '\\"')}"
status: raw
source: ${c.reminder_id ? "reminders" : "capture"}
project: ${project}
captured_at: ${new Date().toISOString()}
brainstormed_at: ~
decided_at: ~
github_issue: ~
github_pr: ~
loop_count: 0
---

## Raw Idea

${c.title}
${c.notes ? "\n## Notes\n\n" + c.notes + "\n" : ""}
## Brainstorm

<!-- Filled by the brainstormer. -->
`;

  if (!fs.existsSync(IDEAS_DIR)) fs.mkdirSync(IDEAS_DIR, { recursive: true });
  fs.writeFileSync(filepath, content, "utf8");

  return { slug, filename: `${slug}.md`, id, title: c.title, project };
}

export async function run(args: CaptureArgs, out: Output): Promise<void> {
  const items = await gather(args, out);
  if (out.settled) return;

  const captured: z.infer<typeof CapturedIdea>[] = [];
  for (const c of items) {
    const rec = writeIdea(c);
    captured.push(rec);
    out.event("capture.created", { slug: rec.slug, project: rec.project });
    if (c.reminder_id) {
      try {
        await completeReminder(c.reminder_id);
      } catch (err) {
        out.warn(`Could not mark reminder complete: ${(err as Error).message}`);
      }
    }
    if (out.mode === "pretty") {
      out.stdout(`✓ ${rec.slug}  [${rec.project}]  ${rec.title}\n`);
    }
  }

  if (captured.length === 0) {
    out.result(
      { source: args.from ?? "auto", captured: [], count: 0 },
      "Nothing to capture. Add a text arg, pipe stdin, or fill the Reminders list."
    );
    return;
  }

  out.result(
    { source: args.from ?? "auto", captured, count: captured.length },
    "Next: `harness brainstorm` to process the new idea(s)."
  );
}
