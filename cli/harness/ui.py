"""Text rendering for the CLI. Mirrors the inflight.sh layout so the
output is familiar."""

from __future__ import annotations

import json as _json
from typing import Iterable

from .state import Idea

# Status grouping order — anything not listed is appended alphabetically.
GROUP_ORDER: tuple[str, ...] = (
    "needs-critic-review",
    "brainstormed",
    "needs-detail",
    "accepted",
    "building",
    "pr-open",
    "captured",
    "shipped",
    "rejected",
)


def render_inflight(ideas: list[Idea]) -> str:
    """Group + sort + format. The output of `harness ideas list` (sans
    JSON), and the body of `/inflight`."""
    if not ideas:
        return "no ideas in flight\n"

    by_status: dict[str, list[Idea]] = {}
    for idea in ideas:
        by_status.setdefault(idea.status, []).append(idea)

    ordered: list[str] = []
    for status in GROUP_ORDER:
        if status in by_status:
            ordered.append(status)
    for status in sorted(by_status):
        if status not in ordered:
            ordered.append(status)

    out: list[str] = []
    total = sum(len(v) for v in by_status.values())
    out.append(f"ideas in flight: {total} total · across {len(ordered)} statuses\n")
    for status in ordered:
        rows = sorted(by_status[status], key=lambda i: i.last_touched, reverse=True)
        out.append(f"── {status} · {len(rows)} ──")
        for idea in rows:
            project = f"[{idea.project or '?'}]"
            title = idea.title
            if len(title) > 60:
                title = title[:57] + "…"
            out.append(f"  {project:<12}  {title:<60}  specs/{idea.slug}/idea.md")
        out.append("")
    return "\n".join(out) + "\n"


def render_show(idea: Idea) -> str:
    """Pretty single-idea detail. Used by `harness ideas show <slug>`."""
    lines: list[str] = []
    lines.append(f"# {idea.title}")
    lines.append("")
    lines.append("## Frontmatter")
    lines.append("")
    for key, value in idea.frontmatter.items():
        display = "~" if value is None else str(value)
        lines.append(f"  {key:18} {display}")
    lines.append("")
    lines.append("## Body")
    lines.append("")
    body = idea.body.strip()
    if body:
        lines.append(body)
    else:
        lines.append("(empty)")
    lines.append("")
    return "\n".join(lines)


def to_json_lines(ideas: Iterable[Idea]) -> str:
    """JSON Lines, one idea per line."""
    out: list[str] = []
    for idea in ideas:
        record = dict(idea.frontmatter)
        record.setdefault("slug", idea.slug)
        record["path"] = str(idea.path)
        out.append(_json.dumps(record, sort_keys=True))
    return "\n".join(out) + ("\n" if out else "")


def to_json(idea: Idea) -> str:
    record = dict(idea.frontmatter)
    record.setdefault("slug", idea.slug)
    record["path"] = str(idea.path)
    record["body"] = idea.body
    return _json.dumps(record, indent=2, sort_keys=True)
