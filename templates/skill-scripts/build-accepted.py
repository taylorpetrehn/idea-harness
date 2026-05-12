#!/usr/bin/env python3
"""
build-accepted.py — for any idea.md with status: brainstormed (= accepted
in this consolidated flow), spawn one autonomous Claude session that runs
idea-harness SKILL.md Step 7 (build) on the oldest pending idea.

We build ONE idea per tick — caps cost per cron tick and avoids worktree
contention. Subsequent brainstormed ideas wait for the next tick.

To stop a specific idea from auto-building, set its status to `rejected`
or add `do_not_build: true` to its frontmatter.

Run by ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-build.plist
every ~15 minutes.
"""

import datetime
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

HOME = Path.home()
SPECS_DIR = HOME / ".claude" / "plans" / "specs"
LAUNCH_WORKSPACE = Path(
    os.environ.get("HARNESS_LAUNCH_WORKSPACE", str(HOME / "Projects" / "idea-harness"))
)
CLAUDE_BIN = Path(
    os.environ.get("HARNESS_CLAUDE_BIN", str(HOME / ".local" / "bin" / "claude"))
)
LOG_FILE = HOME / ".claude" / "skills" / "idea-harness" / "logs" / "build.log"

# Tier 2 codebase reads + write access for the orchestrator session.
# The orchestrator spawns its own builder children (claude --print)
# inside each target repo's working dir; those children get their own
# trust state from the project being approved at install time.
PROJECT_PATHS = [
    HOME / "Projects" / "PrimaryBarker" / "LetsBarker",
]

SEED = """Run the idea-harness skill in build mode for a single brainstormed idea.

Read ~/.claude/skills/idea-harness/SKILL.md for the full Step 7 flow. Also read references/handoff-to-build.md, references/simplicity-rules.md, and references/branch-hygiene.md so the spawned builder can be seeded with them.

Step 0 first (reconcile): for any idea.md at status `pr-open` or `building`, query GitHub via gh and update status to match (merged → shipped, closed → rejected, change-requests → leave for now). Use the Edit tool for status updates.

Then for the BUILD step:

1. Find the OLDEST idea.md under ~/.claude/plans/specs/*/idea.md whose frontmatter has:
     - status: brainstormed
     - critic_verdict: pass
     - decided_at: not null (if there was an Open Question, Taylor's resolved it)
     - do_not_build: not true (or absent)
     - project: a non-null value matching a key in references/projects.yml
   Sort by `last_touched` ascending (oldest first). If none match, exit cleanly with code 0 and no notification.

2. Resolve the project from references/projects.yml. Read it via the Read tool. Resolve per-project context paths (product, decisions, conventions) per SKILL.md's "Per-project context resolution" rule: prefer {local_path}/{path} when projects.yml has the path set and the file exists on the working tree; otherwise fall back to references/context/{name}/{file}.md. If the resolved product.md still contains the literal word "STUB", skip the idea and continue to the next match.

3. Validate handoff (references/handoff-to-build.md): all required frontmatter fields present, brainstorm has the chosen variant marked. If invalid, revert status to brainstormed (or its current state) with a Notes entry explaining what's missing, and continue to the next idea.

4. (Phase 3) Delegate the worktree + env install + smoke + builder hand-off to ~/.claude/skills/idea-harness/scripts/worktree-runner.sh. Compose the builder seed prompt (step 5 below) and write it to a temp file, then invoke:
       bash -lc "BUILDER_SEED_FILE=/tmp/build-seed-{slug}.md ~/.claude/skills/idea-harness/scripts/worktree-runner.sh {project} {slug}"
   The runner reads `.harness/config.json:env_install` for the project's stacks and runs them in order, then runs `commands.smoke`, then spawns `claude --print` with the seed inside the worktree. Stdout is tee'd to spec_dir/build.log.
   - If the runner is missing (older installs): fall back to the inline worktree-create logic — `bash -lc "cd {project.local_path} && git fetch origin && git worktree add {project.worktree_pattern} -B idea/{slug-stub}-{id4} origin/{project.vcs.base_branch}"`, then run env install + smoke + spawn the builder yourself.
   - If `project.vcs.uses_worktrees` is false: skip worktree creation; build_path is `project.local_path`. Refuse if it has a dirty working tree.

5. Update the idea's frontmatter: status: building, set last_touched. Use a single Edit call.

6. Compose a builder seed prompt for `claude --print` that includes:
     - The brainstorm body (just the ## Brainstorm and ## Decision sections)
     - The chosen variant (from the "## Decision" section, or "If accepted, build:" line in the brainstorm)
     - The branch name: idea/{slug-stub}-{id4}
     - The base branch from project.vcs.base_branch
     - The full content of references/simplicity-rules.md
     - The full content of references/branch-hygiene.md
     - The full content of the project's conventions.md (resolved per SKILL.md's "Per-project context resolution" rule — repo-side {local_path}/{conventions_path} if set and present, else references/context/{name}/conventions.md)
     - The bot identity setup commands (from project.vcs.bot)
     - Instructions: implement on a feature branch, run project.commands.test_*, commit with descriptive message, push using the bot PAT, gh pr create against base_branch, print exactly one line `PR_URL=<url>` on success or `PR_FAILED=<reason>` on any failure. Never push to base_branch directly. Never use --no-verify.
     - Claude Code 2.1.139+: prepend the seed with `/goal "PR open with passing CI on {branch}"` so Claude Code runs its own iteration loop until the goal is reached or it gives up. The harness no longer hand-rolls a turn counter; /goal handles convergence and signals completion when the PR is open and CI is green. If /goal isn't available on the spawned claude binary, the rest of the seed still works as a single-turn directive.

7. Spawn the builder: use the Bash tool to run claude --print with that seed in the project's local_path (or in a fresh worktree if project.vcs.uses_worktrees is true). Capture stdout to a log at the spec dir's build.log.

8. Parse the spawn's output for PR_URL=<url>. On success: update the idea's frontmatter to status: pr-open, set github_pr to the URL, append a "## PR" section to the idea body with the URL. On PR_FAILED or absence of PR_URL: revert status to brainstormed, append a Notes entry pointing at build.log.

9. Run the review gauntlet (only if PR_URL was parsed in step 8). Use the Bash tool to invoke ~/.claude/skills/idea-harness/scripts/review-gauntlet.py:
       bash -lc "python3 ~/.claude/skills/idea-harness/scripts/review-gauntlet.py --pr <pr_number_from_url> --repo {project.github_repo} --spec ~/.claude/plans/specs/<slug>/idea.md --idea-slug <slug> --cwd <build_path> >> ~/.claude/skills/idea-harness/logs/gauntlet.log 2>&1 || true"
   The gauntlet waits up to 5 minutes for required CI to settle, then runs four parallel reviewers (spec-fidelity, codebase-patterns, risk; plus ux if the PR touches UI files) and posts an aggregated comment on the PR. It writes review.json next to idea.md. The gauntlet does NOT block on changes_requested — it just records the verdict for Taylor's eyes. If the script is missing (older installs without the Phase 1 ports), the `|| true` swallows the error — skip silently. If it errors at runtime, the log captures the stderr but we continue. Do NOT revert the PR_URL state because the gauntlet failed.

10. If uses_worktrees AND the build succeeded, remove the worktree (gh pr branch is now on origin).

11. Send a single ntfy notification: `curl -s -d "Harness · built {title}: {pr_url}" ntfy.sh/taylor-barker` on success, or `curl -s -d "Harness · build FAILED for {title} — see {build.log}" ntfy.sh/taylor-barker` on failure.

Process ONE idea per invocation. Do not loop to the next brainstormed idea — the next cron tick handles it. This bounds cost per tick.

Exit cleanly when done."""


def has_buildable_ideas() -> bool:
    """Cheap check: any idea.md with status: brainstormed and not opted out."""
    if not SPECS_DIR.is_dir():
        return False
    for spec_dir in SPECS_DIR.iterdir():
        if not spec_dir.is_dir():
            continue
        idea = spec_dir / "idea.md"
        if not idea.is_file():
            continue
        try:
            text = idea.read_text()
        except Exception:
            continue
        m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
        if not m:
            continue
        fm = {}
        for line in m.group(1).splitlines():
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"').strip("'")
        if fm.get("status") != "brainstormed":
            continue
        if fm.get("do_not_build", "").lower() in ("true", "yes", "1"):
            continue
        # We do NOT require decided_at here — some brainstormed ideas
        # had no open question and so never had decided_at set. The
        # orchestrator session does the deeper validation.
        return True
    return False


def main() -> int:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    if not has_buildable_ideas():
        # Silent no-op — most ticks will land here.
        return 0

    if not LAUNCH_WORKSPACE.is_dir():
        sys.stderr.write(f"[build] launch workspace missing: {LAUNCH_WORKSPACE}\n")
        return 1
    if not (CLAUDE_BIN.is_file() and os.access(CLAUDE_BIN, os.X_OK)):
        sys.stderr.write(f"[build] claude not at {CLAUDE_BIN}\n")
        return 1

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    add_dirs = [
        str(SPECS_DIR),
        str(HOME / ".claude" / "skills" / "idea-harness"),
    ]
    for p in PROJECT_PATHS:
        if p.is_dir():
            add_dirs.append(str(p))

    argv = [
        str(CLAUDE_BIN),
        "--print",
        "--permission-mode", "bypassPermissions",
    ]
    for d in add_dirs:
        argv += ["--add-dir", d]
    # `--` terminates options. Without it, --add-dir's variadic <directories...>
    # greedily consumes the trailing positional prompt as another directory,
    # leaving claude --print with no prompt and silently waiting on stdin
    # (which is /dev/null in this daemon context).
    argv += ["--", SEED]

    with open(LOG_FILE, "a") as logf:
        logf.write(f"\n[{now}] build orchestrator starting\n")
        logf.flush()
        proc = subprocess.run(
            argv,
            cwd=str(LAUNCH_WORKSPACE),
            stdout=logf,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        end = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        logf.write(f"\n[{end}] build orchestrator exit {proc.returncode}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
