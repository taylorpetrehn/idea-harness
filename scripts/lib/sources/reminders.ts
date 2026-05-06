/**
 * scripts/lib/sources/reminders.ts
 *
 * Thin adapter around lib/reminders.ts (the osascript-backed adapter
 * for the Apple Reminders app) that conforms to the Source interface.
 */

import { Source, RawCapture } from "./types";
import { listReminders, completeReminder, appendToReminder } from "../reminders";

const id = "reminders" as const;

export const RemindersSource: Source = {
  id,

  available(): boolean {
    return process.platform === "darwin" && process.env.IDEA_HARNESS_REMINDERS !== "dry";
  },

  async fetch(): Promise<RawCapture[]> {
    if (!this.available()) return [];
    const items = await listReminders();
    return items.map((r) => ({
      title: r.title,
      notes: r.notes ?? undefined,
      external_id: r.id,
    }));
  },

  async acknowledge(capture: RawCapture): Promise<void> {
    if (!capture.external_id) return;
    await completeReminder(capture.external_id);
  },

  async writeBack(capture: RawCapture, text: string): Promise<boolean> {
    if (!this.available()) return false;
    if (!capture.external_id) return false;
    return appendToReminder(capture.external_id, text);
  },
};
