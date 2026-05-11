#!/usr/bin/env python3
"""
review-gauntlet.py — run the 4-reviewer gauntlet against an open PR.

Ported from OpenClaw's idea-pipeline:review-gauntlet (markdown for the
orchestrator) into a self-contained Python entry point. Three changes vs.
the OpenClaw version:

  1. Reviewers are not subagent_type'd; they are plain `claude --print`
     spawns seeded with one of the rubric files in review-rubrics/.
  2. No auto-fix loop. The aggregated review is posted to the PR as a
     single comment and `review.json` is written next to the idea's
     spec dir. Taylor (or a manual /idea-build re-trigger) drives the
     next round. The auto-fix loop comes back in Phase 2.
  3. Runtime evaluator (Layer 2) is deferred to Phase 3 (worktree-runner).

Layer 0 (CI health) blocks Layer 1: if any required check is failing, the
gauntlet aborts early and posts an "agent:blocked — CI failing" note. If
checks are still pending, it waits up to GAUNTLET_CI_WAIT_SECONDS (default
300) and re-polls before falling through.

Usage:
  review-gauntlet.py --pr 123 --repo BarkerEnterprises/LetsBarker \\
      --spec ~/.claude/plans/specs/some-slug/idea.md \\
      --idea-slug some-slug
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

HOME = Path.home()
SKILL_DIR = Path(
    os.environ.get(
        "HARNESS_SKILL_DIR",
        str(HOME / ".claude" / "skills" / "idea-harness"),
    )
)
RUBRICS_DIR = Path(
    os.environ.get(
        "HARNESS_REVIEW_RUBRICS_DIR",
        str(SKILL_DIR / "references" / "review-rubrics"),
    )
)
CLAUDE_BIN = Path(
    os.environ.get("HARNESS_CLAUDE_BIN", str(HOME / ".local" / "bin" / "claude"))
)
LOG_FILE = SKILL_DIR / "logs" / "review-gauntlet.log"
CI_WAIT_SECONDS = int(os.environ.get("GAUNTLET_CI_WAIT_SECONDS", "300"))
CI_POLL_INTERVAL = int(os.environ.get("GAUNTLET_CI_POLL_INTERVAL", "30"))
REVIEWER_TIMEOUT = int(os.environ.get("GAUNTLET_REVIEWER_TIMEOUT", "600"))

UI_GLOBS = (
    ".tsx",
    ".jsx",
    ".erb",
    ".css",
    ".scss",
    ".vue",
    ".svelte",
)
UI_PATH_FRAGMENTS = (
    "mobile/src/",
    "mobile/app/",
    "app/views/",
    "app/javascript/",
    "frontend/",
    "src/components/",
)

ALWAYS_REVIEWERS = ("spec-fidelity", "codebase-patterns", "risk")
CONDITIONAL_REVIEWERS = ("ux",)


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a") as fh:
        fh.write(f"[{now_iso()}] {msg}\n")


def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    """Wrap subprocess.run with bash -lc for `gh` to find Homebrew tools."""
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def bash_lc(cmd: str, **kwargs: Any) -> subprocess.CompletedProcess:
    return run(["bash", "-lc", cmd], **kwargs)


def gh_pr_files(pr: int, repo: str) -> list[str]:
    result = bash_lc(
        f"gh pr view {pr} --repo {repo} --json files --jq '.files[].path'"
    )
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def pr_touches_ui(files: list[str]) -> bool:
    for path in files:
        if any(path.endswith(ext) for ext in UI_GLOBS):
            return True
        if any(frag in path for frag in UI_PATH_FRAGMENTS):
            return True
    return False


def check_ci(pr: int, repo: str) -> tuple[str, list[dict[str, Any]]]:
    """Return (state, failing_checks) where state is one of 'pass', 'pending', 'fail'."""
    result = bash_lc(
        f"gh pr checks {pr} --repo {repo} "
        "--json name,state,description,link --required"
    )
    if result.returncode != 0:
        log(f"gh pr checks failed: {result.stderr.strip()}")
        return ("fail", [{"name": "_meta", "state": "ERROR", "description": result.stderr.strip()}])
    try:
        checks = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return ("fail", [{"name": "_meta", "state": "ERROR", "description": "non-json from gh"}])
    if not checks:
        return ("pass", [])
    failing = [c for c in checks if c.get("state") not in ("SUCCESS", "NEUTRAL", "SKIPPED")]
    pending = [c for c in failing if c.get("state") in ("PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED")]
    hard_failing = [c for c in failing if c.get("state") in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE")]
    if hard_failing:
        return ("fail", hard_failing)
    if pending:
        return ("pending", pending)
    return ("pass", [])


def wait_for_ci(pr: int, repo: str) -> tuple[str, list[dict[str, Any]]]:
    deadline = time.monotonic() + CI_WAIT_SECONDS
    state, details = check_ci(pr, repo)
    while state == "pending" and time.monotonic() < deadline:
        log(f"CI pending for PR #{pr} ({len(details)} checks); sleeping {CI_POLL_INTERVAL}s")
        time.sleep(CI_POLL_INTERVAL)
        state, details = check_ci(pr, repo)
    return state, details


def load_rubric(name: str) -> str:
    path = RUBRICS_DIR / f"{name}.md"
    if not path.is_file():
        raise FileNotFoundError(f"rubric missing: {path}")
    return path.read_text()


def spawn_reviewer(
    name: str,
    pr: int,
    repo: str,
    spec_text: str,
    cwd: str,
) -> dict[str, Any]:
    """Spawn one `claude --print` subagent for a single reviewer."""
    rubric = load_rubric(name)
    seed = f"""You are running the `{name}` reviewer in the idea-harness review gauntlet.

# Rubric

{rubric}

# Inputs

- PR: #{pr} in {repo}
- Spec (used by spec-fidelity reviewer; other reviewers may consult for context):

```
{spec_text}
```

# Steps

1. Fetch the PR diff: `gh pr diff {pr} --repo {repo}` (use the Bash tool with `bash -lc`).
2. For the codebase-patterns and ux reviewers, also `grep`/`Read` similar
   files in the working tree to ground each comment in a concrete reference.
3. Apply the rubric strictly. Do not comment outside your lane.
4. Emit ONLY the JSON object specified in the rubric on stdout. No prose,
   no markdown fences. If you have no findings, emit `decision: approved`
   with an empty `comments` array.
"""
    argv = [
        str(CLAUDE_BIN),
        "--print",
        "--permission-mode", "bypassPermissions",
        "--add-dir", cwd,
        "--add-dir", str(SKILL_DIR),
        "--",
        seed,
    ]
    log(f"[{name}] spawning reviewer")
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=REVIEWER_TIMEOUT,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        log(f"[{name}] timed out after {REVIEWER_TIMEOUT}s")
        return {
            "reviewer": name.replace("-", "_"),
            "decision": "changes_requested",
            "comments": [{"file": "_meta", "line": 0, "comment": f"reviewer timed out after {REVIEWER_TIMEOUT}s"}],
        }

    raw = proc.stdout.strip()
    verdict = parse_verdict(raw, fallback_reviewer=name.replace("-", "_"))
    if proc.returncode != 0:
        log(f"[{name}] exit {proc.returncode}: {proc.stderr[-500:].strip()}")
    return verdict


def parse_verdict(raw: str, fallback_reviewer: str) -> dict[str, Any]:
    """Be forgiving — accept JSON anywhere in the stdout block."""
    if not raw:
        return {
            "reviewer": fallback_reviewer,
            "decision": "changes_requested",
            "comments": [{"file": "_meta", "line": 0, "comment": "reviewer returned empty output"}],
        }

    candidates = []
    start = raw.find("{")
    while start != -1:
        depth = 0
        for end in range(start, len(raw)):
            ch = raw[end]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(raw[start : end + 1])
                    break
        next_start = raw.find("{", start + 1)
        start = next_start

    for candidate in reversed(candidates):
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if "decision" in obj:
            obj.setdefault("reviewer", fallback_reviewer)
            obj.setdefault("comments", [])
            if obj["decision"] not in ("approved", "changes_requested"):
                obj["decision"] = "changes_requested"
            return obj

    return {
        "reviewer": fallback_reviewer,
        "decision": "changes_requested",
        "comments": [
            {
                "file": "_meta",
                "line": 0,
                "comment": "reviewer output was not parseable JSON; treat as changes_requested",
            }
        ],
    }


def aggregate_to_markdown(verdicts: list[dict[str, Any]], ci_state: str, ci_details: list[dict[str, Any]]) -> str:
    lines = ["## Idea-harness review gauntlet", ""]
    lines.append(f"_Run at {now_iso()}_")
    lines.append("")

    if ci_state == "fail":
        lines.append("### Layer 0 — CI ❌")
        for c in ci_details:
            link = c.get("link") or ""
            lines.append(f"- **{c.get('name', '?')}**: {c.get('state', '?')} — {c.get('description', '')} {link}".rstrip())
        lines.append("")
    elif ci_state == "pending":
        lines.append("### Layer 0 — CI ⏳")
        lines.append(
            f"CI still pending after {CI_WAIT_SECONDS}s. Proceeding with code review; "
            "re-run the gauntlet after CI completes."
        )
        lines.append("")
    else:
        lines.append("### Layer 0 — CI ✅")
        lines.append("")

    any_changes = any(v.get("decision") == "changes_requested" for v in verdicts)
    summary_icon = "❌" if any_changes else "✅"
    lines.append(f"### Layer 1 — Reviewers {summary_icon}")
    lines.append("")

    for v in verdicts:
        decision = v.get("decision", "changes_requested")
        icon = "✅" if decision == "approved" else "❌"
        reviewer = v.get("reviewer", "?")
        lines.append(f"<details><summary><strong>{icon} {reviewer}</strong> — {decision}</summary>")
        lines.append("")
        comments = v.get("comments", []) or []
        if not comments:
            lines.append("_No findings._")
        else:
            for c in comments:
                file = c.get("file", "?")
                line = c.get("line", 0)
                comment = c.get("comment", "")
                lines.append(f"- `{file}:{line}` — {comment}")
        lines.append("")
        lines.append("</details>")
        lines.append("")

    lines.append("---")
    if any_changes or ci_state != "pass":
        lines.append("**Status:** changes requested. The harness will not auto-merge.")
    else:
        lines.append("**Status:** all reviewers approved. Awaiting Taylor's final sign-off + merge.")

    return "\n".join(lines)


def post_pr_comment(pr: int, repo: str, body: str) -> bool:
    proc = bash_lc(
        f"gh pr comment {pr} --repo {repo} --body-file -",
        input=body,
    )
    if proc.returncode != 0:
        log(f"gh pr comment failed: {proc.stderr.strip()}")
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the 4-reviewer gauntlet on an open PR.")
    parser.add_argument("--pr", type=int, required=True, help="PR number")
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument(
        "--spec",
        required=True,
        help="Path to the idea.md spec (used by the spec-fidelity reviewer).",
    )
    parser.add_argument(
        "--idea-slug",
        required=False,
        help="Idea slug — if set, review.json is written to the matching spec dir.",
    )
    parser.add_argument(
        "--cwd",
        required=False,
        help="Working directory for reviewer claude --print spawns (project local_path or worktree).",
    )
    parser.add_argument(
        "--skip-comment",
        action="store_true",
        help="Run the gauntlet but don't post a PR comment (for local testing).",
    )
    args = parser.parse_args()

    spec_path = Path(args.spec).expanduser()
    if not spec_path.is_file():
        sys.stderr.write(f"[gauntlet] spec not found: {spec_path}\n")
        return 2
    spec_text = spec_path.read_text()

    cwd = args.cwd or str(Path.cwd())
    if not Path(cwd).is_dir():
        sys.stderr.write(f"[gauntlet] cwd not a directory: {cwd}\n")
        return 2

    if not (CLAUDE_BIN.is_file() and os.access(CLAUDE_BIN, os.X_OK)):
        sys.stderr.write(f"[gauntlet] claude not at {CLAUDE_BIN}\n")
        return 2

    if not RUBRICS_DIR.is_dir():
        sys.stderr.write(f"[gauntlet] rubrics missing: {RUBRICS_DIR}\n")
        return 2

    log(f"start PR #{args.pr} repo={args.repo} cwd={cwd}")

    ci_state, ci_details = wait_for_ci(args.pr, args.repo)
    log(f"CI state: {ci_state}")
    if ci_state == "fail":
        body = aggregate_to_markdown([], ci_state, ci_details)
        if not args.skip_comment:
            post_pr_comment(args.pr, args.repo, body)
        write_review_json(args, [], ci_state, ci_details)
        return 0

    files = gh_pr_files(args.pr, args.repo)
    reviewers = list(ALWAYS_REVIEWERS)
    if pr_touches_ui(files):
        reviewers += list(CONDITIONAL_REVIEWERS)
        log(f"PR touches UI ({len(files)} files); including ux reviewer")
    else:
        log("PR does not touch UI; skipping ux reviewer")

    verdicts: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=len(reviewers)) as pool:
        futures = {
            pool.submit(spawn_reviewer, name, args.pr, args.repo, spec_text, cwd): name
            for name in reviewers
        }
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                verdict = fut.result()
            except Exception as exc:
                log(f"[{name}] uncaught: {exc!r}")
                verdict = {
                    "reviewer": name.replace("-", "_"),
                    "decision": "changes_requested",
                    "comments": [{"file": "_meta", "line": 0, "comment": f"reviewer crashed: {exc!r}"}],
                }
            verdicts.append(verdict)

    body = aggregate_to_markdown(verdicts, ci_state, ci_details)
    if args.skip_comment:
        sys.stdout.write(body + "\n")
    else:
        if not post_pr_comment(args.pr, args.repo, body):
            sys.stderr.write("[gauntlet] failed to post PR comment; verdict below\n")
            sys.stderr.write(body + "\n")
            return 1

    write_review_json(args, verdicts, ci_state, ci_details)
    log("done")
    return 0


def write_review_json(
    args: argparse.Namespace,
    verdicts: list[dict[str, Any]],
    ci_state: str,
    ci_details: list[dict[str, Any]],
) -> None:
    if not args.idea_slug:
        return
    spec_dir = HOME / ".claude" / "plans" / "specs" / args.idea_slug
    if not spec_dir.is_dir():
        log(f"spec dir missing for --idea-slug={args.idea_slug}; skipping review.json write")
        return
    record = {
        "pr": args.pr,
        "repo": args.repo,
        "run_at": now_iso(),
        "ci_state": ci_state,
        "ci_details": ci_details,
        "verdicts": verdicts,
    }
    (spec_dir / "review.json").write_text(json.dumps(record, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
