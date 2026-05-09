#!/usr/bin/env python3
"""
brainstorm-captured.py — when any idea.md has status: captured, spawn a
single autonomous Claude session that runs the idea-harness skill's
brainstorm phase (steps 2-5 of SKILL.md) on the batch.

No pty needed: this session uses --print mode, which is fully autonomous.
The session spawns its own critic subagents per idea.

Silent no-op when no captured ideas exist. Notification (via ntfy.sh) is
the spawned session's responsibility — only fires if something changed.

Run by ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-brainstorm.plist
every hour.
"""

import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
SPECS_DIR = HOME / ".claude" / "plans" / "specs"
LAUNCH_WORKSPACE = Path(
    os.environ.get("HARNESS_LAUNCH_WORKSPACE", str(HOME / "Projects" / "idea-harness"))
)
CLAUDE_BIN = Path(
    os.environ.get("HARNESS_CLAUDE_BIN", str(HOME / ".local" / "bin" / "claude"))
)
LOG_FILE = HOME / ".claude" / "skills" / "idea-harness" / "logs" / "brainstorm.log"

# Tier 2 codebase reads need filesystem access. Add target-repo paths here as
# you onboard them. Stubbed projects (openclaw, rewilding) route to
# needs-detail before requiring a codebase read, so they don't need entries.
PROJECT_PATHS = [
    HOME / "Projects" / "PrimaryBarker" / "LetsBarker",
]

SEED = """Run the idea-harness skill in brainstorm-batch mode.

Read ~/.claude/skills/idea-harness/SKILL.md. Process every idea.md under ~/.claude/plans/specs/*/idea.md whose frontmatter has `status: captured`. Run steps 2 (score+route), 3 (brainstorm), 4 (critique via fresh subagent), and 5 (sharpen if needs-more-thought). Skip step 1 (harvest), step 7 (build), step 8 (watch PRs).

Constraints:
  - Use the Edit tool for all idea.md modifications (no Bash sed/awk).
  - If a project's references/context/{name}/product.md still contains the literal word "STUB", set the idea's status to needs-detail with a "## Notes" entry pointing at that gap, and skip brainstorm for it.
  - The critic must be a fresh subagent (Agent tool, general-purpose) with the brainstorm + raw idea + references/critic-rubric.md as input. Returns JSON to spec-eval.json.

After processing all captured ideas, count what changed and send ONE notification only if anything moved into a state Taylor would care about:

  bash -c 'curl -s -d "Harness · brainstormed: <N1> · needs-critic-review: <N2> · needs-detail: <N3>" ntfy.sh/taylor-barker'

Skip the notification entirely if N1+N2+N3 == 0. Exit cleanly when done — do not run tests, builds, or anything outside the brainstorm phase."""


def has_captured_ideas() -> bool:
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
        for line in m.group(1).splitlines():
            if line.startswith("status:"):
                if line.split(":", 1)[1].strip().strip('"').strip("'") == "captured":
                    return True
                break
    return False


def main() -> int:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    if not has_captured_ideas():
        # Silent no-op — most ticks will land here.
        return 0

    if not LAUNCH_WORKSPACE.is_dir():
        sys.stderr.write(f"[brainstorm] launch workspace missing: {LAUNCH_WORKSPACE}\n")
        return 1
    if not (CLAUDE_BIN.is_file() and os.access(CLAUDE_BIN, os.X_OK)):
        sys.stderr.write(f"[brainstorm] claude not at {CLAUDE_BIN}\n")
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
        logf.write(f"\n[{now}] brainstorm batch starting\n")
        logf.flush()
        proc = subprocess.run(
            argv,
            cwd=str(LAUNCH_WORKSPACE),
            stdout=logf,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        end = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        logf.write(f"\n[{end}] brainstorm batch exit {proc.returncode}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
