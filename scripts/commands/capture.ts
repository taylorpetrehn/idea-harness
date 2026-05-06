/**
 * scripts/commands/capture.ts
 *
 * `harness capture` — add a new idea to the harness.
 *
 * Sources are pluggable; see scripts/lib/sources/. Selected with --from
 * (default: text if positional args are given, otherwise reminders).
 */

import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { resolveProject } from "../lib/projects";
import { createRawIdea } from "../lib/ideas";
import { getSource, listSources, RawCapture } from "../lib/sources";

export interface CaptureArgs {
  text?: string[];
  from?: string;
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

function writeIdea(c: RawCapture, defaultSource: string): z.infer<typeof CapturedIdea> {
  const project = c.project ?? resolveProject(c.title, c.notes ?? "") ?? "letsbarker";
  const source = c.external_id ? defaultSource : defaultSource === "reminders" ? "reminders" : "capture";
  return createRawIdea({ title: c.title, notes: c.notes, project, source });
}

export async function run(args: CaptureArgs, out: Output): Promise<void> {
  const explicitText = (args.text ?? []).join(" ").trim();
  const sourceId = args.from ?? (explicitText ? "text" : "reminders");
  const source = getSource(sourceId);

  if (!source) {
    const available = listSources()
      .filter((s) => s.available())
      .map((s) => s.id)
      .join(" | ");
    out.error("BAD_INPUT", `Unknown source "${sourceId}".`, {
      hint: `Available: ${available || "(none)"}`,
    });
    return;
  }

  if (!source.available()) {
    out.error("ENV_MISSING", `Source "${sourceId}" is not available in this environment.`, {
      hint: sourceId === "reminders"
        ? "Reminders requires macOS (and System Settings → Privacy → Automation access)."
        : "Check the source's prerequisites.",
    });
    return;
  }

  let items: RawCapture[];
  try {
    items = await source.fetch({ project: args.project, raw: explicitText || undefined });
  } catch (err) {
    out.error("BAD_INPUT", (err as Error).message, {
      hint: "Run `harness doctor` to check the source's environment.",
    });
    return;
  }

  if (items.length === 0) {
    out.result(
      { source: source.id, captured: [], count: 0 },
      sourceId === "reminders"
        ? "Reminders list empty."
        : "Nothing to capture from that source."
    );
    return;
  }

  const captured: z.infer<typeof CapturedIdea>[] = [];
  for (const c of items) {
    const rec = writeIdea(c, source.id);
    captured.push(rec);
    out.event("capture.created", { slug: rec.slug, project: rec.project, source: source.id });
    if (source.acknowledge) {
      try {
        await source.acknowledge(c);
      } catch (err) {
        out.warn(`Source acknowledge failed for "${c.title}": ${(err as Error).message}`);
      }
    }
    if (out.mode === "pretty") {
      out.stdout(`✓ ${rec.slug}  [${rec.project}]  ${rec.title}\n`);
    }
  }

  out.result(
    { source: source.id, captured, count: captured.length },
    "Next: `harness brainstorm` to process the new idea(s)."
  );
}
