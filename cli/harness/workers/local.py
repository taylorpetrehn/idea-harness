"""local worker — wraps the existing build-accepted.py spawn flow.

This is what `harness ideas build <slug>` has done since Phase 2: shell out
to ~/.claude/skills/idea-harness/scripts/build-accepted.py with
HARNESS_TARGET_SLUG set, let the orchestrator spawn `claude --print` in
a worktree, parse the build.log for PR_URL after it exits.

The Phase 3 `worktree-runner.sh` handles the worktree+env+smoke; this
worker is the cron entry point that triggers the orchestrator above it.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from ..state import Idea, SPECS_DIR
from . import BuildResult

HOME = Path.home()
SKILL_DIR = Path(
    os.environ.get("HARNESS_SKILL_DIR", str(HOME / ".claude" / "skills" / "idea-harness"))
)

name = "local"


def build(idea: Idea) -> BuildResult:
    script = SKILL_DIR / "scripts" / "build-accepted.py"
    if not script.is_file():
        return BuildResult(
            ok=False,
            reason=f"missing build script at {script}; install the harness skill first",
        )
    env = os.environ.copy()
    env["HARNESS_TARGET_SLUG"] = idea.slug

    sys.stdout.write(f"[worker:local] spawning build-accepted.py for {idea.slug}…\n")
    sys.stdout.flush()
    proc = subprocess.run([sys.executable, str(script)], env=env)
    if proc.returncode != 0:
        return BuildResult(
            ok=False,
            reason=f"build-accepted.py exited {proc.returncode}",
        )
    # The orchestrator writes PR_URL into idea.md frontmatter on success.
    # Re-load and inspect.
    try:
        refreshed = Idea.from_slug(idea.slug)
    except Exception as exc:  # noqa: BLE001
        return BuildResult(ok=False, reason=f"could not re-read idea: {exc!r}")
    pr_url = refreshed.get("github_pr")
    if pr_url and isinstance(pr_url, str) and "/pull/" in pr_url:
        return BuildResult(ok=True, pr_url=pr_url)
    # Fallback: scrape build.log for PR_URL= if frontmatter didn't update.
    build_log = SPECS_DIR / idea.slug / "build.log"
    if build_log.is_file():
        text = build_log.read_text()
        match = re.search(r"PR_URL=(\S+)", text)
        if match:
            return BuildResult(ok=True, pr_url=match.group(1))
        failed = re.search(r"PR_FAILED=(.+)", text)
        if failed:
            return BuildResult(ok=False, reason=failed.group(1).strip())
    return BuildResult(
        ok=False,
        reason="orchestrator exited 0 but no PR_URL was captured — check build.log",
    )
