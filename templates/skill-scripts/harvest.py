#!/usr/bin/env python3
"""
harvest.py — pull new "App Ideas" reminders into ~/.claude/plans/specs/.

Each incomplete reminder becomes ~/.claude/plans/specs/{slug}/idea.md
with status: captured. Dedup is by slug stem (lowercase kebab of title).
Reminders are NOT marked complete here — that happens later, after the
brainstorm passes the critic.

Usage:
  ./harvest.py                  # default: list "App Ideas"
  ./harvest.py --list "Other"   # different reminders list
  ./harvest.py --dry-run        # show what would be created, write nothing
"""

import argparse
import datetime
import re
import secrets
import subprocess
import sys
from pathlib import Path

PLANS_DIR = Path.home() / ".claude" / "plans" / "specs"
RECORD_SEP = "<<<R>>>"
FIELD_SEP = "<<<F>>>"

# Reminders sometimes hangs (sync churn, app not running, TCC issues). Hard caps
# so a stuck osascript can never starve the LaunchAgent.
APPLESCRIPT_TIMEOUT_SECONDS = 15
SUBPROCESS_TIMEOUT_SECONDS = 20


def slugify(s: str, max_len: int = 50) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:max_len].rstrip("-")


def fetch_reminders(list_name: str) -> list[tuple[str, str]]:
    """Returns [(title, body), ...] for incomplete reminders in `list_name`.

    Both AppleScript and the subprocess get hard timeouts. Reminders has been
    observed to hang during iCloud sync; without these caps a stuck osascript
    blocks every subsequent harvester tick.
    """
    script = f'''
with timeout of {APPLESCRIPT_TIMEOUT_SECONDS} seconds
  tell application "Reminders"
    set output to ""
    try
      set theList to list "{list_name}"
    on error
      return ""
    end try
    set theReminders to every reminder in theList whose completed is false
    repeat with r in theReminders
      set rName to name of r
      set rBody to ""
      try
        set rBody to body of r
      end try
      set output to output & rName & "{FIELD_SEP}" & rBody & "{RECORD_SEP}"
    end repeat
    return output
  end tell
end timeout
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        sys.stderr.write(
            f"osascript wall-clock timeout after {SUBPROCESS_TIMEOUT_SECONDS}s "
            f"reading list '{list_name}' — Reminders likely hung\n"
        )
        return []

    if result.returncode != 0:
        sys.stderr.write(f"osascript failed: {result.stderr.strip()}\n")
        return []

    raw = result.stdout.strip()
    if not raw:
        return []

    records = []
    for chunk in raw.split(RECORD_SEP):
        chunk = chunk.strip()
        if not chunk:
            continue
        if FIELD_SEP in chunk:
            title, body = chunk.split(FIELD_SEP, 1)
        else:
            title, body = chunk, ""
        title = title.strip()
        body = body.strip()
        # AppleScript renders an empty body as the literal string "missing value".
        if body == "missing value":
            body = ""
        records.append((title, body))
    return records


def mark_reminder_complete(list_name: str, title: str) -> bool:
    """Mark the first incomplete reminder matching `title` as completed.

    Matches by exact name; falls back to a startswith match against the first
    40 characters (titles with embedded URLs sometimes get truncated by the
    Reminders sync layer). Returns True on success, False on any failure —
    failures are non-fatal: the idea.md still got written.
    """
    title_escaped = title.replace('"', '\\"')
    prefix = title[:40].replace('"', '\\"')
    script = f'''
with timeout of {APPLESCRIPT_TIMEOUT_SECONDS} seconds
  tell application "Reminders"
    try
      set theList to list "{list_name}"
    on error
      return "no-list"
    end try
    -- Try exact match first.
    try
      set matches to (every reminder in theList whose completed is false and name is "{title_escaped}")
      if (count of matches) > 0 then
        set completed of (item 1 of matches) to true
        return "ok-exact"
      end if
    end try
    -- Fallback: startswith match against first 40 chars.
    try
      set matches to (every reminder in theList whose completed is false and name starts with "{prefix}")
      if (count of matches) > 0 then
        set completed of (item 1 of matches) to true
        return "ok-prefix"
      end if
    end try
    return "no-match"
  end tell
end timeout
'''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        sys.stderr.write(f"  ⚠ timeout marking reminder complete: {title!r}\n")
        return False
    if result.returncode != 0:
        sys.stderr.write(f"  ⚠ osascript failed marking complete: {result.stderr.strip()}\n")
        return False
    return result.stdout.strip().startswith("ok")


def existing_slug_stems(plans_dir: Path) -> set[str]:
    """Return slug stems (without -xxxx suffix) already in PLANS_DIR.

    A directory `profile-completion-nudges-a3f2` has stem
    `profile-completion-nudges` (last hyphen-separated 4-char hex stripped
    if it looks like an id; otherwise the full name).
    """
    if not plans_dir.exists():
        return set()
    stems: set[str] = set()
    id_suffix = re.compile(r"^(.*)-([0-9a-f]{4})$")
    for p in plans_dir.iterdir():
        if not p.is_dir():
            continue
        match = id_suffix.match(p.name)
        if match:
            stems.add(match.group(1))
        else:
            stems.add(p.name)
    return stems


def build_idea_content(idx: str, title: str, slug: str, body: str, now: str) -> str:
    title_escaped = title.replace('"', '\\"')
    content = (
        "---\n"
        f"id: {idx}\n"
        f'title: "{title_escaped}"\n'
        f"slug: {slug}\n"
        "status: captured\n"
        "source: reminders\n"
        "project: ~\n"
        f"captured_at: {now}\n"
        "brainstormed_at: ~\n"
        "decided_at: ~\n"
        "critic_verdict: ~\n"
        "github_issue: ~\n"
        "github_pr: ~\n"
        "loop_count: 0\n"
        f"last_touched: {now}\n"
        "---\n\n"
        "## Raw Idea\n\n"
        f"{title}\n"
    )
    if body:
        content += f"\n## Notes\n\n{body}\n"
    content += "\n## Brainstorm\n\n<!-- Filled by the brainstormer. -->\n"
    return content


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--list", default="App Ideas", help='Reminders list name (default: "App Ideas")'
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Show what would be created; write nothing"
    )
    args = parser.parse_args()

    reminders = fetch_reminders(args.list)
    if not reminders:
        print(f"no incomplete reminders in '{args.list}' (or list missing)")
        return 0

    existing = existing_slug_stems(PLANS_DIR)
    new_count = 0
    skipped_count = 0

    if not args.dry_run:
        PLANS_DIR.mkdir(parents=True, exist_ok=True)

    for title, body in reminders:
        if not title:
            continue
        stem = slugify(title)
        if not stem:
            continue
        if stem in existing:
            skipped_count += 1
            continue

        idx = secrets.token_hex(4)
        slug = f"{stem}-{idx[:4]}"
        spec_dir = PLANS_DIR / slug
        now = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        content = build_idea_content(idx, title, slug, body, now)

        if args.dry_run:
            print(f"  [dry-run] would create: {slug}/idea.md")
        else:
            spec_dir.mkdir(parents=True, exist_ok=True)
            (spec_dir / "idea.md").write_text(content)
            # Mark the source reminder complete now that we have a tracked
            # idea.md. Failures here are non-fatal — the idea is captured
            # either way.
            completed = mark_reminder_complete(args.list, title)
            mark_note = " (reminder marked complete)" if completed else " (reminder NOT marked complete)"
            print(f"  + harvested: {slug}{mark_note}")

        existing.add(stem)
        new_count += 1

    print()
    suffix = " (dry-run)" if args.dry_run else ""
    print(f"harvest summary{suffix}: {new_count} new, {skipped_count} skipped (already captured)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
