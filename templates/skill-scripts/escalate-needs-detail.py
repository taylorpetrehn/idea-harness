#!/usr/bin/env python3
"""
escalate-needs-detail.py — for each idea.md with status: needs-detail and
no escalated_at timestamp, spawn a detached Claude session seeded with the
brainstorm + open question. The spawned session edits idea.md directly when
Taylor replies from his phone (Remote Control inherits from the launch
workspace's defaults).

Idempotent: each idea is escalated at most once until status changes off
needs-detail. The script returns immediately after spawning (start_new_session=True).

Run by ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-escalate.plist
"""

import datetime
import os
import pty
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

SEED_TEMPLATE = """There is an idea waiting on a decision. Read IDEA_PATH — there is an open question at the bottom under "## Open Question" that needs Taylor's input. Read the full brainstorm, summarize the question briefly, and walk through the variants so he can decide.

When Taylor gives a decision, do all of the following in a SINGLE Edit-tool call (one Edit, no Bash, no sed) — combine the body append and the frontmatter updates in one diff so it lands as one operation:

  1. Append a "## Decision" section after the existing "## Open Question" section, containing Taylor's answer verbatim plus a one-line interpretation if useful.
  2. In the frontmatter, change:
       status: needs-detail   →   status: brainstormed
       decided_at: ~          →   decided_at: <current UTC ISO 8601>
       last_touched: <old>    →   last_touched: <current UTC ISO 8601>
  3. Leave escalated_at as-is — it's the record of when this session started.
  4. After the Edit lands, exit cleanly. Do not run tests, lint, or any other work.

Be terse — match Taylor's consolidate-and-ride energy. He's likely on a phone."""


def short_name(slug: str) -> str:
    """Shorten the slug for the phone-visible session name.

    Slug format is `<kebab-title>-<id4-hex>`. We keep the first 20 chars
    of the title plus the id4 suffix, e.g.
    `ability-to-draft-and-schedule-publish-message-in-s-4e44`
        → `ability-to-draft-and-4e44`.
    """
    m = re.match(r"^(.*)-([0-9a-f]{4})$", slug)
    if m:
        title, idx = m.group(1), m.group(2)
        return f"{title[:20].rstrip('-')}-{idx}"
    return slug[:25]


def parse_frontmatter(idea_path: Path) -> Optional[dict]:
    text = idea_path.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None
    fm = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        fm[k.strip()] = v.strip().strip('"').strip("'")
    return fm


def mark_escalated(idea_path: Path, ts: str) -> None:
    text = idea_path.read_text()
    if re.search(r"^escalated_at:", text, re.MULTILINE):
        text = re.sub(
            r"^escalated_at:.*$",
            f"escalated_at: {ts}",
            text,
            count=1,
            flags=re.MULTILINE,
        )
    else:
        text = re.sub(
            r"\n---\n", f"\nescalated_at: {ts}\n---\n", text, count=1
        )
    text = re.sub(
        r"^last_touched:.*$",
        f"last_touched: {ts}",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    idea_path.write_text(text)


def spawn_session(spec_dir: Path, idea_path: Path, slug: str, title: str, ts: str) -> None:
    """Daemonize a Claude RC session inside a pseudo-tty.

    Why this dance: `claude --remote-control` needs a TTY on stdin/stdout
    or it auto-detects --print mode and exits after the seed turn. macOS
    `script` can't allocate a pty when the parent has no controlling tty
    (launchd context). Python's `pty.spawn` allocates its own pty and is
    the reliable cross-context primitive. We double-fork so the daemon
    survives the python script's exit, then redirect IO to a log file
    inside the grandchild before calling pty.spawn.
    """
    log_file = spec_dir / ".escalation.log"
    seed = SEED_TEMPLATE.replace("IDEA_PATH", str(idea_path))

    argv = [
        str(CLAUDE_BIN),
        "--remote-control", f"idea/{short_name(slug)}",
        "--add-dir", str(spec_dir),
        # bypassPermissions (vs acceptEdits) suppresses the "Bash sed/date"
        # second prompt some sessions hit when frontmatter updates need a
        # tool other than Edit. The seed instructs Claude to use ONE Edit
        # call, so blast radius is bounded to a single idea.md write.
        "--permission-mode", "bypassPermissions",
        seed,
    ]

    # Pre-write the escalation entry while we still have the parent's
    # ordinary stdout — easier than trying to coordinate from the daemon.
    with open(log_file, "a") as logf:
        logf.write(f"[{ts}] escalating: {slug} ({title})\n")

    # First fork: returns to caller in the parent.
    pid = os.fork()
    if pid > 0:
        os.waitpid(pid, 0)
        return

    # First child: become session leader so the second child can detach.
    os.setsid()

    # Second fork: ensures the daemon can never reacquire a controlling
    # tty by accident.
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Grandchild = the daemon. Redirect stdio to log/devnull then pty.spawn.
    null_fd = os.open(os.devnull, os.O_RDONLY)
    log_fd = os.open(str(log_file), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(null_fd, 0)
    os.dup2(log_fd, 1)
    os.dup2(log_fd, 2)
    os.close(null_fd)
    os.close(log_fd)

    os.chdir(str(LAUNCH_WORKSPACE))

    # pty.spawn allocates a pty, forks claude into it, and copies output
    # to our (now-redirected) stdout (= the log file). It blocks until
    # claude exits — exactly what we want for a long-lived RC session.
    pty.spawn(argv)
    os._exit(0)


def main() -> int:
    if not SPECS_DIR.is_dir():
        return 0
    if not LAUNCH_WORKSPACE.is_dir():
        sys.stderr.write(f"[escalate] launch workspace missing: {LAUNCH_WORKSPACE}\n")
        return 1
    if not (CLAUDE_BIN.is_file() and os.access(CLAUDE_BIN, os.X_OK)):
        sys.stderr.write(f"[escalate] claude binary not at {CLAUDE_BIN}\n")
        return 1

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    escalated = 0

    for spec_dir in sorted(SPECS_DIR.iterdir()):
        if not spec_dir.is_dir():
            continue
        idea_path = spec_dir / "idea.md"
        if not idea_path.is_file():
            continue
        fm = parse_frontmatter(idea_path)
        if not fm:
            continue
        if fm.get("status") != "needs-detail":
            continue
        escalated_at = fm.get("escalated_at", "~")
        if escalated_at and escalated_at != "~":
            continue

        slug = fm.get("slug", spec_dir.name)
        title = fm.get("title", slug)

        # Mark first to prevent duplicate spawns if multiple ticks fire.
        mark_escalated(idea_path, now)
        spawn_session(spec_dir, idea_path, slug, title, now)
        escalated += 1

    if escalated > 0:
        print(f"[{now}] escalated {escalated} idea(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
