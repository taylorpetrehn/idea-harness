"""codespace worker — spin up a Codespace, run worktree-runner.sh there.

Flow:
  1. `gh codespace create --repo <repo> --branch <base> -m basicLinux32gb`
  2. `gh codespace ssh -c <name> -- bash -lc '~/.claude/skills/idea-harness/scripts/worktree-runner.sh <project> <slug>'`
  3. Capture PR_URL from the remote stdout (codespace must be set up with
     a bot PAT in its env so `gh pr create` works).

For Phase 4 we ship the dispatch shell; the cloud-image setup (cloning
the harness skill into the codespace, prewiring the bot PAT) is a
follow-up since it depends on the project's codespace devcontainer.json
which lives in the target repo, not here.

If you don't have Codespaces enabled on the target repo, the worker
returns a clear error rather than a cryptic gh exit code.
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

name = "codespace"


def build(idea: Idea) -> BuildResult:
    project = idea.project
    if not project:
        return BuildResult(ok=False, reason="idea has no project; can't pick a repo")
    repo, base_branch = _resolve_repo(project)
    if not repo:
        return BuildResult(ok=False, reason=f"projects.yml entry for {project!r} missing github_repo")

    sys.stdout.write(f"[worker:codespace] creating codespace on {repo}…\n")
    sys.stdout.flush()
    create = subprocess.run(
        [
            "bash", "-lc",
            f"gh codespace create --repo {shlex.quote(repo)} --branch {shlex.quote(base_branch)} "
            f"--machine basicLinux32gb --display-name harness-{idea.slug}",
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if create.returncode != 0:
        return BuildResult(
            ok=False,
            reason=f"gh codespace create failed: {create.stderr.strip()[:300]}",
            log_excerpt=create.stderr,
        )
    codespace_name = create.stdout.strip().splitlines()[-1] if create.stdout.strip() else ""
    if not codespace_name:
        return BuildResult(ok=False, reason="gh codespace create returned no name")

    sys.stdout.write(f"[worker:codespace] running worktree-runner.sh in {codespace_name}…\n")
    sys.stdout.flush()

    # The codespace must have the harness skill cloned and `harness` on
    # PATH — see templates/codespace/README.md for the devcontainer bits.
    remote_cmd = (
        f"~/.claude/skills/idea-harness/scripts/worktree-runner.sh "
        f"{shlex.quote(project)} {shlex.quote(idea.slug)}"
    )
    run = subprocess.run(
        ["bash", "-lc", f"gh codespace ssh -c {shlex.quote(codespace_name)} -- bash -lc {shlex.quote(remote_cmd)}"],
        capture_output=True,
        text=True,
        timeout=3600,  # 1h — generous for slow-stack builds
    )

    # Always try to clean up the codespace.
    _delete_codespace(codespace_name)

    if run.returncode != 0:
        return BuildResult(
            ok=False,
            reason=f"worktree-runner.sh in codespace exited {run.returncode}",
            log_excerpt=run.stderr or run.stdout,
        )

    match = re.search(r"PR_URL=(\S+)", run.stdout)
    if match:
        return BuildResult(ok=True, pr_url=match.group(1), log_excerpt=run.stdout[-2000:])
    failed = re.search(r"PR_FAILED=(.+)", run.stdout)
    if failed:
        return BuildResult(ok=False, reason=failed.group(1).strip(), log_excerpt=run.stdout[-2000:])
    return BuildResult(
        ok=False,
        reason="codespace exited 0 but no PR_URL in stdout",
        log_excerpt=run.stdout[-2000:],
    )


def _delete_codespace(name: str) -> None:
    try:
        subprocess.run(
            ["bash", "-lc", f"gh codespace delete --codespace {shlex.quote(name)} --force"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception:  # noqa: BLE001 — best effort
        pass


def _resolve_repo(project_key: str) -> tuple[str | None, str]:
    """Same tiny YAML reader as gh_action.py; lifted to avoid a circular import."""
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
