"""harness reconcile — poll pr-open ideas and update status from GitHub.

For every idea at status `pr-open`, ask `gh` for the PR's GitHub state
and map it back to a harness status. Mirrors Step 0 of the SKILL.md
flow, but factored into a CLI verb so cron + manual triggers go through
the same path.

Status mapping (matches SKILL.md Step 0):

    GitHub state                    new status        side effect
    ───────────────────────────────────────────────────────────
    merged                          shipped           note: "merged at <ts>"
    closed (not merged)             rejected          note: "PR closed without merge"
    open + change requests          stay pr-open      add note (one-shot per run)
    open + CI failing               stay pr-open      add note (one-shot per run)
    open + no review                no change         no note

No retries or builder re-spawns here — those are Phase 3 work. This
verb's job is purely to keep `harness ideas list` honest.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any

from ..state import Idea, filter_ideas, iter_ideas, now_iso


def cmd_reconcile(args: argparse.Namespace) -> int:
    pr_open = filter_ideas(iter_ideas(), status="pr-open")
    if not pr_open:
        sys.stdout.write("no pr-open ideas — nothing to reconcile\n")
        return 0

    sys.stdout.write(f"reconciling {len(pr_open)} pr-open idea(s)…\n")
    changed = 0
    for idea in pr_open:
        pr_url = idea.get("github_pr") or ""
        if not pr_url or "/pull/" not in pr_url:
            sys.stdout.write(f"  ~ {idea.slug}: missing github_pr; skipping\n")
            continue
        meta = _gh_pr_meta(pr_url)
        if not meta:
            sys.stdout.write(f"  ! {idea.slug}: gh pr view failed for {pr_url}\n")
            continue
        new_status, note = _classify(meta)
        if new_status == idea.status:
            sys.stdout.write(f"  · {idea.slug}: {idea.status} (no change)\n")
            continue
        sys.stdout.write(f"  → {idea.slug}: {idea.status} → {new_status}\n")
        if args.dry_run:
            continue
        idea.set_status(new_status)
        if note:
            idea.append_note(note)
        idea.save()
        changed += 1

    if args.dry_run:
        sys.stdout.write(f"\ndry-run: would have changed {len(pr_open) - changed} ideas (rerun without --dry-run).\n")
    else:
        sys.stdout.write(f"\nchanged {changed} of {len(pr_open)} ideas\n")
    return 0


def _gh_pr_meta(pr_url: str) -> dict[str, Any] | None:
    cmd = [
        "gh", "pr", "view", pr_url,
        "--json", "state,mergedAt,closedAt,reviewDecision,statusCheckRollup",
    ]
    try:
        proc = subprocess.run(["bash", "-lc", " ".join(cmd)], capture_output=True, text=True, timeout=30)
    except Exception as exc:  # noqa: BLE001 — surface anything to caller
        sys.stderr.write(f"[harness] gh invocation failed: {exc!r}\n")
        return None
    if proc.returncode != 0:
        sys.stderr.write(f"[harness] gh pr view returned {proc.returncode}: {proc.stderr.strip()}\n")
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def _classify(meta: dict[str, Any]) -> tuple[str, str | None]:
    state = (meta.get("state") or "").upper()
    if state == "MERGED" or meta.get("mergedAt"):
        ts = meta.get("mergedAt") or now_iso()
        return "shipped", f"PR merged at {ts}"
    if state == "CLOSED":
        return "rejected", "PR closed without merge"
    review = meta.get("reviewDecision")
    checks = meta.get("statusCheckRollup") or []
    failing = [c for c in checks if (c.get("conclusion") or "").upper() in ("FAILURE", "TIMED_OUT", "CANCELLED")]
    if review == "CHANGES_REQUESTED":
        return "pr-open", "change requests on PR (reconcile detected)"
    if failing:
        return "pr-open", f"{len(failing)} required check(s) failing (reconcile detected)"
    return "pr-open", None
