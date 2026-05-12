"""gh-action worker — dispatch claude.yml via workflow_dispatch.

Flow:
  1. Resolve the project's github_repo from idea.frontmatter.project →
     projects.yml.
  2. `gh workflow run claude.yml --repo <repo> --ref <base> -f idea_slug=<slug>`
  3. Return immediately with the run URL stuffed into BuildResult.reason
     (idea status stays `building` until `harness reconcile` ingests the
     PR_URL the workflow posts back as a PR comment / status check).

Async-by-design: the GH Action posts back `PR_URL=` either by appending
`github_pr: <url>` to the idea's frontmatter via `harness ideas accept`
on the next reconcile tick, or by adding a PR comment that contains the
literal token `PR_URL=https://...` which reconcile.py parses.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

from ..state import Idea
from . import BuildResult

name = "gh-action"


def build(idea: Idea) -> BuildResult:
    project = idea.project
    if not project:
        return BuildResult(ok=False, reason="idea has no project; can't pick a repo")
    repo, base_branch = _resolve_repo(project)
    if not repo:
        return BuildResult(ok=False, reason=f"projects.yml entry for {project!r} missing github_repo")

    # gh workflow run returns the URL of the queued run on stdout if the
    # caller passes --json. We don't dispatch directly to a status URL —
    # we just record the run URL so the operator can click through, and
    # let `harness reconcile` ingest the eventual PR_URL.
    argv = [
        "gh", "workflow", "run", "claude.yml",
        "--repo", repo,
        "--ref", base_branch,
        "-f", f"idea_slug={idea.slug}",
    ]
    sys.stdout.write(f"[worker:gh-action] dispatching: {' '.join(shlex.quote(a) for a in argv)}\n")
    sys.stdout.flush()
    proc = subprocess.run(
        ["bash", "-lc", " ".join(shlex.quote(a) for a in argv)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        return BuildResult(
            ok=False,
            reason=f"gh workflow run exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}",
            log_excerpt=proc.stderr or proc.stdout,
        )

    run_url = _latest_run_url(repo)
    note = f"dispatched to GH Action; run: {run_url or '(URL not yet available)'}"
    # Update idea: status: building, append a note pointing at the run.
    idea.set_status("building")
    idea.set(worker="gh-action")
    if run_url:
        idea.set(github_action_run=run_url)
    idea.append_note(f"build via gh-action — {note}")
    idea.save()
    # We don't have a PR_URL yet — that's reconcile's job to ingest.
    # Return ok=True so the caller treats this as a successful dispatch.
    return BuildResult(ok=True, pr_url=None, reason=note)


def _resolve_repo(project_key: str) -> tuple[str | None, str]:
    """Read references/projects.yml and pull github_repo + base_branch."""
    yml = Path.home() / ".claude" / "skills" / "idea-harness" / "references" / "projects.yml"
    if not yml.is_file():
        return None, "main"
    text = yml.read_text()
    m = re.search(rf"^\s{{2}}{re.escape(project_key)}:\s*$", text, re.M)
    if not m:
        return None, "main"
    body = text[m.end():]
    next_proj = re.search(r"^\s{2}[A-Za-z0-9_-]+:\s*$", body, re.M)
    if next_proj:
        body = body[: next_proj.start()]
    repo_m = re.search(r"^\s+github_repo:\s*[\"']?([^\"'\n]+)[\"']?", body, re.M)
    branch_m = re.search(r"^\s+base_branch:\s*[\"']?([^\"'\n]+)[\"']?", body, re.M)
    return (
        repo_m.group(1).strip() if repo_m else None,
        branch_m.group(1).strip() if branch_m else "main",
    )


def _latest_run_url(repo: str) -> str | None:
    """Best-effort: fetch the most recent run of claude.yml via gh api."""
    try:
        proc = subprocess.run(
            ["bash", "-lc", f"gh run list --repo {shlex.quote(repo)} --workflow=claude.yml --limit 1 --json url"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode == 0:
            data = json.loads(proc.stdout)
            if isinstance(data, list) and data:
                return data[0].get("url")
    except Exception:  # noqa: BLE001 — best effort only
        return None
    return None
