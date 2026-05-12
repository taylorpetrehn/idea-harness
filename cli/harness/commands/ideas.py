"""harness ideas {list, show, accept, reject, reroute, build, brainstorm}."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from ..state import (
    Idea,
    IdeaNotFound,
    InvalidStatus,
    SPECS_DIR,
    filter_ideas,
    iter_ideas,
    now_iso,
)
from ..ui import render_inflight, render_show, to_json, to_json_lines

HOME = Path.home()
SKILL_DIR = Path(
    os.environ.get(
        "HARNESS_SKILL_DIR", str(HOME / ".claude" / "skills" / "idea-harness")
    )
)


# ----- list / show ------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> int:
    ideas = filter_ideas(
        iter_ideas(),
        status=args.status,
        project=args.project,
        score_gte=args.score_gte,
    )
    if args.json:
        sys.stdout.write(to_json_lines(ideas))
    else:
        sys.stdout.write(render_inflight(ideas))
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    try:
        idea = Idea.from_slug(args.slug)
    except IdeaNotFound as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 1
    if args.json:
        sys.stdout.write(to_json(idea) + "\n")
    else:
        sys.stdout.write(render_show(idea))
    return 0


# ----- accept / reject / reroute ----------------------------------------


def cmd_accept(args: argparse.Namespace) -> int:
    return _mutate_status(args.slug, "brainstormed", note=args.note, action="accepted")


def cmd_reject(args: argparse.Namespace) -> int:
    return _mutate_status(args.slug, "rejected", note=args.note, action="rejected")


def cmd_reroute(args: argparse.Namespace) -> int:
    try:
        idea = Idea.from_slug(args.slug)
    except IdeaNotFound as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 1
    previous = idea.project or "~"
    idea.set(project=args.project, last_touched=now_iso())
    if args.note:
        idea.append_note(f"rerouted from {previous} → {args.project}: {args.note}")
    else:
        idea.append_note(f"rerouted from {previous} → {args.project}")
    idea.save()
    sys.stdout.write(f"rerouted {args.slug} to project={args.project}\n")
    return 0


def _mutate_status(slug: str, new_status: str, *, note: str | None, action: str) -> int:
    try:
        idea = Idea.from_slug(slug)
    except IdeaNotFound as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 1
    prev = idea.status
    try:
        idea.set_status(new_status)
    except InvalidStatus as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 2
    # decided_at marks Taylor's explicit decision — used by build-accepted.py
    # to gate ideas with open questions.
    if new_status in ("brainstormed", "rejected"):
        idea.set(decided_at=now_iso())
    if note:
        idea.append_note(f"{action} via harness: {note}")
    else:
        idea.append_note(f"{action} via harness (status: {prev} → {new_status})")
    idea.save()
    sys.stdout.write(f"{slug}: {prev} → {new_status}\n")
    return 0


# ----- build / brainstorm (delegate to existing scripts) ----------------

# These verbs flip status + immediately shell out to the matching cron
# script with HARNESS_TARGET_SLUG set. The scripts pick that up and
# build/brainstorm just that one idea instead of scanning the queue.


def cmd_brainstorm(args: argparse.Namespace) -> int:
    try:
        idea = Idea.from_slug(args.slug)
    except IdeaNotFound as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 1
    script = SKILL_DIR / "scripts" / "brainstorm-captured.py"
    if not script.is_file():
        sys.stderr.write(
            f"[harness] missing brainstorm script at {script}; "
            "the harness skill isn't installed on this machine.\n"
        )
        return 2
    env = os.environ.copy()
    env["HARNESS_TARGET_SLUG"] = idea.slug
    sys.stdout.write(f"spawning brainstormer for {idea.slug}…\n")
    sys.stdout.flush()
    return subprocess.call([sys.executable, str(script)], env=env)


def cmd_build(args: argparse.Namespace) -> int:
    """Dispatch a single idea to one of the workers (local / gh-action / codespace).

    Worker selection precedence:
      1. --worker CLI flag (explicit)
      2. The project's `.harness/config.json:vcs.default_worker`
      3. "local"
    """
    from .. import workers as workers_pkg

    try:
        idea = Idea.from_slug(args.slug)
    except IdeaNotFound as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 1
    if idea.status not in ("brainstormed", "accepted", "needs-detail"):
        sys.stderr.write(
            f"[harness] refusing to build {idea.slug}: status is {idea.status!r}; "
            "expected brainstormed/accepted/needs-detail.\n"
        )
        return 2

    worker_name = _resolve_worker(args.worker, idea)
    try:
        worker = workers_pkg.get_worker(worker_name)
    except KeyError as exc:
        sys.stderr.write(f"[harness] {exc}\n")
        return 2
    sys.stdout.write(f"[harness] worker={worker_name} for {idea.slug}\n")
    sys.stdout.flush()
    result = worker.build(idea)
    if result.ok:
        sys.stdout.write(f"[harness] dispatched ok. pr_url={result.pr_url or '(pending)'}\n")
        return 0
    sys.stderr.write(f"[harness] build failed: {result.reason}\n")
    if result.log_excerpt:
        sys.stderr.write(result.log_excerpt[-1000:] + "\n")
    return 1


def _resolve_worker(cli_flag: str, idea: Idea) -> str:
    """Resolve the worker name from the precedence above."""
    if cli_flag and cli_flag != "auto":
        return cli_flag
    # Try the project's .harness/config.json.
    project = idea.project
    if project:
        cfg = _read_project_default_worker(project)
        if cfg:
            return cfg
    return "local"


def _read_project_default_worker(project_key: str) -> str | None:
    """Best-effort: read references/projects.yml → local_path →
    .harness/config.json:vcs.default_worker."""
    import json
    import re
    from pathlib import Path

    yml = SKILL_DIR / "references" / "projects.yml"
    if not yml.is_file():
        return None
    text = yml.read_text()
    m = re.search(rf"^\s{{2}}{re.escape(project_key)}:\s*$", text, re.M)
    if not m:
        return None
    body = text[m.end():]
    next_proj = re.search(r"^\s{2}[A-Za-z0-9_-]+:\s*$", body, re.M)
    if next_proj:
        body = body[: next_proj.start()]
    lp_m = re.search(r"^\s+local_path:\s*[\"']?([^\"'\n]+)[\"']?", body, re.M)
    if not lp_m:
        return None
    local_path = Path(lp_m.group(1).strip()).expanduser()
    cfg_path = local_path / ".harness" / "config.json"
    if not cfg_path.is_file():
        return None
    try:
        cfg = json.loads(cfg_path.read_text())
    except Exception:  # noqa: BLE001
        return None
    return ((cfg.get("vcs") or {}).get("default_worker")) or None
