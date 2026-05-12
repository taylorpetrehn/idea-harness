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
    redispatched = 0
    for idea in pr_open:
        pr_url = idea.get("github_pr") or ""
        if not pr_url or "/pull/" not in pr_url:
            sys.stdout.write(f"  ~ {idea.slug}: missing github_pr; skipping\n")
            continue
        meta = _gh_pr_meta(pr_url)
        if not meta:
            sys.stdout.write(f"  ! {idea.slug}: gh pr view failed for {pr_url}\n")
            continue
        new_status, note, should_redispatch = _classify(meta)

        if new_status != idea.status:
            sys.stdout.write(f"  → {idea.slug}: {idea.status} → {new_status}\n")
            if not args.dry_run:
                idea.set_status(new_status)
                if note:
                    idea.append_note(note)
                idea.save()
                changed += 1
        elif should_redispatch:
            # Phase 4: same status (pr-open), but the PR has change requests
            # or failing CI. Re-dispatch the builder via the same worker.
            already = idea.get("reconcile_redispatched_at")
            if already and not args.force_redispatch:
                sys.stdout.write(
                    f"  · {idea.slug}: already re-dispatched at {already}; skipping "
                    "(pass --force-redispatch to re-trigger)\n"
                )
                continue
            if args.no_redispatch:
                sys.stdout.write(f"  · {idea.slug}: {note} (re-dispatch disabled via --no-redispatch)\n")
                if note and not args.dry_run:
                    idea.append_note(note)
                    idea.save()
                continue
            worker_name = idea.get("worker") or "local"
            sys.stdout.write(f"  ↻ {idea.slug}: re-dispatch via worker={worker_name} ({note})\n")
            if args.dry_run:
                continue
            ok = _redispatch(idea, worker_name)
            idea.set(reconcile_redispatched_at=now_iso(), reconcile_redispatch_reason=note)
            if note:
                idea.append_note(f"reconcile re-dispatched ({worker_name}): {note}")
            idea.save()
            if ok:
                redispatched += 1
        else:
            sys.stdout.write(f"  · {idea.slug}: {idea.status} (no change)\n")

    if args.dry_run:
        sys.stdout.write(f"\ndry-run: would have changed {changed} ideas, re-dispatched {redispatched}.\n")
    else:
        sys.stdout.write(f"\nchanged {changed}, re-dispatched {redispatched} (of {len(pr_open)} pr-open)\n")
    return 0


def _redispatch(idea: Idea, worker_name: str) -> bool:
    """Re-spawn the builder via the named worker. Errors are non-fatal —
    reconcile keeps running for the other ideas."""
    try:
        from .. import workers as workers_pkg
        worker = workers_pkg.get_worker(worker_name)
    except KeyError as exc:
        sys.stderr.write(f"[reconcile] unknown worker {worker_name!r}: {exc}\n")
        return False
    try:
        result = worker.build(idea)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[reconcile] worker {worker_name!r} crashed: {exc!r}\n")
        return False
    if not result.ok:
        sys.stderr.write(f"[reconcile] re-dispatch via {worker_name} failed: {result.reason}\n")
        return False
    return True


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


def _classify(meta: dict[str, Any]) -> tuple[str, str | None, bool]:
    """Return (new_status, note, should_redispatch).

    `should_redispatch` is True for the open-with-change-requests and
    open-with-failing-CI cases; reconcile uses it (Phase 4) to fire
    the builder one more time so the agent can address the comments.
    """
    state = (meta.get("state") or "").upper()
    if state == "MERGED" or meta.get("mergedAt"):
        ts = meta.get("mergedAt") or now_iso()
        return "shipped", f"PR merged at {ts}", False
    if state == "CLOSED":
        return "rejected", "PR closed without merge", False
    review = meta.get("reviewDecision")
    checks = meta.get("statusCheckRollup") or []
    failing = [
        c for c in checks
        if (c.get("conclusion") or "").upper() in ("FAILURE", "TIMED_OUT", "CANCELLED")
    ]
    if review == "CHANGES_REQUESTED":
        return "pr-open", "change requests on PR (reconcile detected)", True
    if failing:
        return "pr-open", f"{len(failing)} required check(s) failing (reconcile detected)", True
    return "pr-open", None, False
