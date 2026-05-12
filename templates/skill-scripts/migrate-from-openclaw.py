#!/usr/bin/env python3
"""
migrate-from-openclaw.py — one-shot port of OpenClaw's ideas.jsonl into the
idea-harness filesystem state.

Reads ~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl and, for
each record NOT in a terminal status, creates a corresponding
~/.claude/plans/specs/<slug>/idea.md (if one doesn't already exist).
Records in terminal statuses are summarized in a single migration ledger
under ~/.claude/skills/idea-harness/logs/openclaw-migration.json so we
have a record without polluting `/inflight` with historical work.

Idempotent: re-running is a no-op when ~/.claude/plans/specs/<slug>/idea.md
already exists for a given record.

Defaults to --dry-run. Pass --apply to actually write files. On the
HEAD snapshot of ideas.jsonl every record is terminal, so the expected
output of `--apply` is "0 idea.md files written, N records archived to
ledger".

Usage:
  migrate-from-openclaw.py [--dry-run | --apply] [--source PATH] [--ledger PATH]
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

HOME = Path.home()
DEFAULT_SOURCE = (
    HOME
    / ".openclaw"
    / "workspace-bonnie"
    / "data"
    / "idea-pipeline"
    / "ideas.jsonl"
)
DEFAULT_SPECS = HOME / ".claude" / "plans" / "specs"
DEFAULT_LEDGER = (
    HOME / ".claude" / "skills" / "idea-harness" / "logs" / "openclaw-migration.json"
)

# Statuses that mean "no live work to recover — record in ledger and move on".
# All of these were terminal in the OpenClaw flow: PR was created, shipped,
# cancelled, or the spec was filed and the work-of-record now lives in the
# target repo. None require an idea.md in idea-harness state.
TERMINAL_STATUSES = {
    "completed",
    "complete",
    "cancelled",
    "closed_duplicate",
    "already_processed",
    "spec_pr_created",
    "spec_complete",
    "specced",
    "shipped",
    "rejected",
    "merged",
    "pr_closed",
    "pr_open",          # In OpenClaw vocab, pr_open = PR has been created. The work lives on origin; no harness state needed.
    "pr_created",
    "pr_updated",
    "issue_created",
    "review_complete",
    "review_ready",
    "logged",
    "build_failed",     # OpenClaw's failed builds — Taylor already triaged
}

# Map old status names → harness status names (for the few records that
# might still be worth carrying over: things that hadn't reached a PR yet).
STATUS_MAP = {
    "not_started": "captured",
    "needs_detail": "needs-detail",
    "needs_clarification": "needs-detail",
    "needs_spec": "captured",
    "in_progress": "building",
    "building": "building",
}

# Map old project key → canonical projects.yml key.
PROJECT_MAP = {
    "LetsBarker": "letsbarker",
    "Clawd": "openclaw",
    "OpenClaw": "openclaw",
    "Rewilding": "rewilding",
}


def slugify(title: str, id_suffix: str) -> str:
    s = re.sub(r"[^a-z0-9\s-]", "", title.lower())
    s = re.sub(r"\s+", "-", s).strip("-")
    s = s[:50].rstrip("-")
    return f"{s}-{id_suffix[:4]}" if id_suffix else s


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def emit_idea_md(record: dict[str, Any], specs_dir: Path) -> tuple[Path, bool]:
    """Return (spec_dir_path, would_write). would_write=False if dir exists."""
    raw_id = str(record.get("id", "")).removeprefix("idea_")
    id_short = raw_id.zfill(4)[-4:]
    title = str(record.get("title", "untitled")).strip()
    slug = slugify(title, id_short)
    spec_dir = specs_dir / slug
    idea_path = spec_dir / "idea.md"

    if idea_path.exists():
        return spec_dir, False

    status = STATUS_MAP.get(record.get("status", ""), str(record.get("status", "captured")))
    project = PROJECT_MAP.get(record.get("project", ""), str(record.get("project", "")).lower())
    captured_at = record.get("captured_at") or now_iso()
    last_touched = record.get("processed_at") or captured_at
    score = record.get("confidence_score")

    fm_lines = [
        "---",
        f'id: "{raw_id or slug}"',
        f"slug: {slug}",
        f'title: "{title.replace(chr(34), chr(39))}"',
        f"status: {status}",
        f"source: openclaw-migration",
        f"captured_at: {captured_at}",
        f"last_touched: {last_touched}",
    ]
    if project:
        fm_lines.append(f"project: {project}")
    if score is not None:
        fm_lines.append(f"score: {score}")
    if record.get("github_pr") or record.get("pr_number"):
        pr = record.get("github_pr") or f"#{record['pr_number']}"
        fm_lines.append(f'github_pr: "{pr}"')
    if record.get("github_issue") or record.get("issue_number"):
        issue = record.get("github_issue") or f"#{record['issue_number']}"
        fm_lines.append(f'github_issue: "{issue}"')
    fm_lines.append("---")
    fm_lines.append("")

    body = [
        "## Raw Idea",
        "",
        title,
        "",
    ]
    if record.get("notes"):
        body += ["## Notes", "", str(record["notes"]), ""]
    if record.get("spec_path"):
        body += [
            "## Migrated from OpenClaw",
            "",
            f"This idea was ported from `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl`.",
            f"Original spec lives at `{record['spec_path']}` in its target repo.",
            "",
        ]

    return spec_dir, True


def is_terminal(status: str) -> bool:
    return status in TERMINAL_STATUSES


def main() -> int:
    parser = argparse.ArgumentParser(description="Port OpenClaw ideas.jsonl into idea-harness state.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", default=True, help="Report only (default).")
    group.add_argument("--apply", action="store_true", help="Actually write idea.md files and ledger.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help=f"ideas.jsonl path (default: {DEFAULT_SOURCE})")
    parser.add_argument("--specs-dir", default=str(DEFAULT_SPECS), help=f"Target specs dir (default: {DEFAULT_SPECS})")
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER), help=f"Migration ledger path (default: {DEFAULT_LEDGER})")
    args = parser.parse_args()

    apply = bool(args.apply)
    source = Path(args.source).expanduser()
    specs_dir = Path(args.specs_dir).expanduser()
    ledger_path = Path(args.ledger).expanduser()

    if not source.is_file():
        sys.stderr.write(f"[migrate] source not found: {source}\n")
        return 0  # not an error — OpenClaw may already be gone

    records: list[dict[str, Any]] = []
    with source.open() as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                sys.stderr.write(f"[migrate] {source}:{lineno} skipped — {exc}\n")
                continue

    written = 0
    skipped_exists = 0
    archived: list[dict[str, Any]] = []

    for rec in records:
        status = rec.get("status", "")
        if is_terminal(status):
            archived.append(
                {
                    "id": rec.get("id"),
                    "title": rec.get("title"),
                    "status": status,
                    "project": rec.get("project"),
                    "pr_number": rec.get("pr_number"),
                    "spec_path": rec.get("spec_path"),
                    "processed_at": rec.get("processed_at"),
                }
            )
            continue

        spec_dir, would_write = emit_idea_md(rec, specs_dir)
        if not would_write:
            skipped_exists += 1
            continue
        if apply:
            spec_dir.mkdir(parents=True, exist_ok=True)
            (spec_dir / "idea.md").write_text(render_idea_md(rec))
        written += 1

    if apply:
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        ledger_path.write_text(
            json.dumps(
                {
                    "migrated_at": now_iso(),
                    "source": str(source),
                    "terminal_archived": archived,
                    "non_terminal_written": written,
                    "non_terminal_skipped_existing": skipped_exists,
                },
                indent=2,
            )
            + "\n"
        )

    print(f"[migrate] mode={'apply' if apply else 'dry-run'}")
    print(f"[migrate] source: {source}")
    print(f"[migrate] total records: {len(records)}")
    print(f"[migrate] terminal archived to ledger: {len(archived)}")
    print(f"[migrate] non-terminal idea.md {'written' if apply else 'would be written'}: {written}")
    print(f"[migrate] non-terminal already-present (idempotent skip): {skipped_exists}")
    if apply:
        print(f"[migrate] ledger: {ledger_path}")

    return 0


def render_idea_md(record: dict[str, Any]) -> str:
    """Compose the idea.md text. Mirrors emit_idea_md's body builder."""
    raw_id = str(record.get("id", "")).removeprefix("idea_")
    id_short = raw_id.zfill(4)[-4:]
    title = str(record.get("title", "untitled")).strip()
    slug = slugify(title, id_short)
    status = STATUS_MAP.get(record.get("status", ""), str(record.get("status", "captured")))
    project = PROJECT_MAP.get(record.get("project", ""), str(record.get("project", "")).lower())
    captured_at = record.get("captured_at") or now_iso()
    last_touched = record.get("processed_at") or captured_at
    score = record.get("confidence_score")

    fm_lines = [
        "---",
        f'id: "{raw_id or slug}"',
        f"slug: {slug}",
        f'title: "{title.replace(chr(34), chr(39))}"',
        f"status: {status}",
        "source: openclaw-migration",
        f"captured_at: {captured_at}",
        f"last_touched: {last_touched}",
    ]
    if project:
        fm_lines.append(f"project: {project}")
    if score is not None:
        fm_lines.append(f"score: {score}")
    if record.get("github_pr") or record.get("pr_number"):
        pr = record.get("github_pr") or f"#{record['pr_number']}"
        fm_lines.append(f'github_pr: "{pr}"')
    if record.get("github_issue") or record.get("issue_number"):
        issue = record.get("github_issue") or f"#{record['issue_number']}"
        fm_lines.append(f'github_issue: "{issue}"')
    fm_lines.append("---")
    fm_lines.append("")

    body = [
        "## Raw Idea",
        "",
        title,
        "",
    ]
    if record.get("notes"):
        body += ["## Notes", "", str(record["notes"]), ""]
    if record.get("spec_path"):
        body += [
            "## Migrated from OpenClaw",
            "",
            "This idea was ported from `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl`.",
            f"Original spec lives at `{record['spec_path']}` in its target repo.",
            "",
        ]
    return "\n".join(fm_lines + body)


if __name__ == "__main__":
    sys.exit(main())
