/**
 * scripts/lib/reminders.ts
 *
 * Apple Reminders adapter. Modeled on the idea-to-pr skill, which uses
 * osascript directly (the `reminders` CLI hangs without UI interaction;
 * the Reminders MCP `reminder_search_v0` / `reminder_update_v0` tools
 * are only available inside a Claude Code session, not from a plain
 * Node process).
 *
 * Two modes:
 *   1. osascript (default) — talks to the Reminders app via AppleScript.
 *   2. dry-run — returns an empty list and silently no-ops on completion.
 *      Enabled by IDEA_HARNESS_REMINDERS=dry, or when osascript fails
 *      (e.g., running in CI / on Linux).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "./log";

const execFileAsync = promisify(execFile);

export interface Reminder {
  id: string;
  title: string;
  notes: string | null;
}

const DEFAULT_LIST = "App Ideas";

function dryMode(): boolean {
  return process.env.IDEA_HARNESS_REMINDERS === "dry" || process.platform !== "darwin";
}

export async function listReminders(listName: string = DEFAULT_LIST): Promise<Reminder[]> {
  if (dryMode()) {
    log.debug(`reminders: dry mode, skipping list "${listName}"`);
    return [];
  }
  const script = `
    set out to ""
    tell application "Reminders"
      try
        set theList to list "${escapeForAppleScript(listName)}"
      on error
        return ""
      end try
      repeat with r in (every reminder in theList whose completed is false)
        set rId to id of r
        set rName to name of r
        try
          set rBody to body of r
        on error
          set rBody to ""
        end try
        if rBody is missing value then set rBody to ""
        set out to out & rId & "\\t" & rName & "\\t" & my replaceLF(rBody) & "\\n"
      end repeat
    end tell
    return out

    on replaceLF(t)
      set AppleScript's text item delimiters to {character id 10}
      set parts to text items of t
      set AppleScript's text item delimiters to "\\\\n"
      set joined to parts as string
      set AppleScript's text item delimiters to {""}
      return joined
    end replaceLF
  `;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    return parseRemindersOutput(stdout);
  } catch (err) {
    log.warn(`reminders: osascript failed, falling back to dry mode (${(err as Error).message})`);
    return [];
  }
}

export async function completeReminder(
  reminderId: string,
  listName: string = DEFAULT_LIST
): Promise<void> {
  if (dryMode()) {
    log.debug(`reminders: dry mode, skipping complete ${reminderId}`);
    return;
  }
  // Apple Reminders IDs are URLs like "x-apple-reminderkit://...". Match by
  // id within the named list, falling back to a name-prefix match if the
  // direct id lookup fails.
  const script = `
    tell application "Reminders"
      try
        set theList to list "${escapeForAppleScript(listName)}"
      on error
        return "no_list"
      end try
      try
        set targetReminder to (first reminder in theList whose id is "${escapeForAppleScript(reminderId)}")
        set completed of targetReminder to true
        return "ok"
      on error
        return "not_found"
      end try
    end tell
  `;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 10_000,
    });
    const result = stdout.trim();
    if (result === "ok") return;
    log.warn(`reminders: completeReminder returned "${result}" for ${reminderId}`);
  } catch (err) {
    log.warn(`reminders: complete failed for ${reminderId}: ${(err as Error).message}`);
  }
}

export async function completeReminderByTitlePrefix(
  titlePrefix: string,
  listName: string = DEFAULT_LIST
): Promise<boolean> {
  if (dryMode()) {
    log.debug(`reminders: dry mode, skipping complete by prefix "${titlePrefix}"`);
    return false;
  }
  const trimmed = titlePrefix.slice(0, 40);
  const script = `
    tell application "Reminders"
      try
        set theList to list "${escapeForAppleScript(listName)}"
      on error
        return "no_list"
      end try
      try
        set theReminder to (first reminder in theList whose completed is false and name starts with "${escapeForAppleScript(trimmed)}")
        set completed of theReminder to true
        return "ok"
      on error
        return "not_found"
      end try
    end tell
  `;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
    return stdout.trim() === "ok";
  } catch {
    return false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseRemindersOutput(stdout: string): Reminder[] {
  const lines = stdout.split("\n").filter((l) => l.trim());
  const reminders: Reminder[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const [id, title, notes] = parts;
    reminders.push({
      id: id.trim(),
      title: title.trim(),
      notes: notes ? notes.replace(/\\n/g, "\n").trim() || null : null,
    });
  }
  return reminders;
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
