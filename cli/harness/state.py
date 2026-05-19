"""
Idea state — frontmatter parser, dataclass, atomic writes.

The canonical store is ~/.claude/plans/specs/<slug>/idea.md. Frontmatter
is a *strict subset* of YAML: top-level `key: value` pairs only, no
nested mappings, no anchors, no flow style. Values may be quoted with
single or double quotes; the parser strips them. `~` or empty is null.

We deliberately don't pull in PyYAML — the schema is narrow enough that
a 40-line parser handles everything we write, and adding a runtime dep
just for this would be silly.

Writes go through `Idea.save()` which:
  1. re-renders the entire idea.md (frontmatter + body) from the
     in-memory `Idea` instance
  2. writes to <path>.tmp
  3. fsyncs and renames over the original (atomic on POSIX)

This means two concurrent writers will not interleave bytes; the loser's
write replaces the winner's. That's acceptable for our cadence — the
LaunchAgent cron + manual CLI invocations don't overlap in practice, and
losing the rare race is better than corruption.
"""

from __future__ import annotations

import datetime
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

HOME = Path.home()
SPECS_DIR = HOME / ".claude" / "plans" / "specs"

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)
KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$")

# Order in which keys are rendered when re-serializing. Unknown keys are
# preserved at the end in their input order.
FRONTMATTER_KEY_ORDER = (
    "id",
    "slug",
    "title",
    "status",
    "source",
    "project",
    "score",
    "captured_at",
    "brainstormed_at",
    "decided_at",
    "last_touched",
    "critic_verdict",
    "loop_count",
    "do_not_build",
    "github_issue",
    "github_pr",
)


VALID_STATUSES = (
    "captured",
    "brainstormed",
    "needs-critic-review",
    "needs-detail",
    "accepted",
    "building",
    "pr-open",
    "shipped",
    "rejected",
)


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse leading frontmatter; return (fm_dict, body)."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    fm_text, body = m.group(1), m.group(2)
    fm: dict[str, Any] = {}
    for line in fm_text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = KEY_RE.match(line)
        if not match:
            # Tolerate continuation / unparseable lines by skipping; we
            # never round-trip them, but we don't want to crash on them
            # either.
            continue
        key, raw = match.group(1), match.group(2)
        value = _strip_quotes(raw)
        if value in ("", "~", "null", "None"):
            fm[key] = None
        elif value.lower() in ("true", "false"):
            fm[key] = value.lower() == "true"
        else:
            try:
                fm[key] = int(value)
            except ValueError:
                fm[key] = value
    return fm, body


def render_frontmatter(fm: dict[str, Any]) -> str:
    """Render frontmatter back to YAML-ish text, key order stable."""
    seen: set[str] = set()
    lines = ["---"]
    for key in FRONTMATTER_KEY_ORDER:
        if key in fm:
            lines.append(f"{key}: {_format_value(fm[key])}")
            seen.add(key)
    for key, value in fm.items():
        if key in seen:
            continue
        lines.append(f"{key}: {_format_value(value)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def _format_value(value: Any) -> str:
    if value is None:
        return "~"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    s = str(value)
    # Quote when it contains anything YAML-special so a downstream parser
    # treats it as a plain string. The harvest scripts already write
    # title with double quotes; mirror that.
    needs_quote = any(c in s for c in (":", "#", "\n")) or s.startswith(
        (" ", "-", "[", "{", "*", "&", "!", "|", ">", "%", "@", "`")
    )
    if needs_quote:
        escaped = s.replace('"', '\\"')
        return f'"{escaped}"'
    return s


@dataclass
class Idea:
    """In-memory view of an idea.md file. The path is canonical."""

    path: Path
    frontmatter: dict[str, Any] = field(default_factory=dict)
    body: str = ""

    # ----- read ---------------------------------------------------------

    @classmethod
    def load(cls, path: Path) -> "Idea":
        text = path.read_text()
        fm, body = parse_frontmatter(text)
        return cls(path=path, frontmatter=fm, body=body)

    @classmethod
    def from_slug(cls, slug: str, specs_dir: Path | None = None) -> "Idea":
        sd = specs_dir or SPECS_DIR
        path = sd / slug / "idea.md"
        if not path.is_file():
            raise IdeaNotFound(f"no idea.md at {path}")
        return cls.load(path)

    # ----- field accessors with defaults --------------------------------

    @property
    def slug(self) -> str:
        return self.get("slug") or self.path.parent.name

    @property
    def status(self) -> str:
        return self.get("status") or "captured"

    @property
    def title(self) -> str:
        return self.get("title") or self.slug

    @property
    def project(self) -> str | None:
        v = self.get("project")
        return v if v else None

    @property
    def score(self) -> int | None:
        v = self.get("score")
        if isinstance(v, int):
            return v
        if isinstance(v, str) and v.isdigit():
            return int(v)
        return None

    @property
    def last_touched(self) -> str:
        return self.get("last_touched") or "1970-01-01T00:00:00Z"

    def get(self, key: str, default: Any = None) -> Any:
        return self.frontmatter.get(key, default)

    # ----- write --------------------------------------------------------

    def set(self, **updates: Any) -> "Idea":
        """In-place merge. Returns self for chaining."""
        for key, value in updates.items():
            if value is None and key in self.frontmatter and self.frontmatter[key] is not None:
                # Don't accidentally drop a real value to null unless caller
                # explicitly passes None for a present key.
                pass
            self.frontmatter[key] = value
        return self

    def set_status(self, new_status: str) -> "Idea":
        if new_status not in VALID_STATUSES:
            raise InvalidStatus(f"{new_status!r} is not a valid status; expected one of {VALID_STATUSES}")
        self.frontmatter["status"] = new_status
        self.frontmatter["last_touched"] = now_iso()
        return self

    def append_note(self, note: str) -> "Idea":
        """Append a dated entry under `## Notes`. Creates the section if missing."""
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        entry = f"> {stamp}: {note}\n"
        if "## Notes" in self.body:
            # Insert immediately after the `## Notes` header line.
            lines = self.body.splitlines(keepends=True)
            out: list[str] = []
            inserted = False
            for line in lines:
                out.append(line)
                if not inserted and line.strip() == "## Notes":
                    out.append("\n")
                    out.append(entry)
                    inserted = True
            self.body = "".join(out)
        else:
            # Append a new Notes section at the end.
            sep = "" if self.body.endswith("\n") else "\n"
            self.body = f"{self.body}{sep}\n## Notes\n\n{entry}"
        return self

    def append_decision(self, text: str) -> "Idea":
        """Append a dated entry under `## Decision`. Creates the section if
        missing. This is the canonical artifact SKILL.md expects when an
        open question is resolved (alongside status: brainstormed +
        decided_at); the builder reads it as steering context."""
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        entry = f"> {stamp}: {text.strip()}\n"
        if "## Decision" in self.body:
            lines = self.body.splitlines(keepends=True)
            out: list[str] = []
            inserted = False
            for line in lines:
                out.append(line)
                if not inserted and line.strip() == "## Decision":
                    out.append("\n")
                    out.append(entry)
                    inserted = True
            self.body = "".join(out)
        else:
            sep = "" if self.body.endswith("\n") else "\n"
            self.body = f"{self.body}{sep}\n## Decision\n\n{entry}"
        return self

    def render(self) -> str:
        fm = render_frontmatter(self.frontmatter)
        body = self.body if self.body.startswith("\n") else "\n" + self.body
        return fm + body

    def save(self) -> None:
        rendered = self.render()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(rendered)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)


# ----- exceptions --------------------------------------------------------


class IdeaError(Exception):
    """Base class."""


class IdeaNotFound(IdeaError):
    """Raised when a slug doesn't map to a file."""


class InvalidStatus(IdeaError):
    """Raised when set_status is called with an unknown status."""


# ----- iteration helpers -------------------------------------------------


def iter_ideas(specs_dir: Path | None = None) -> Iterator[Idea]:
    """Yield every idea.md under specs_dir, parsed."""
    sd = specs_dir or SPECS_DIR
    if not sd.is_dir():
        return
    for child in sorted(sd.iterdir()):
        if not child.is_dir():
            continue
        idea_path = child / "idea.md"
        if idea_path.is_file():
            try:
                yield Idea.load(idea_path)
            except Exception:
                # A broken idea.md shouldn't crash list/show. Skip with
                # a stderr note for the operator.
                import sys
                sys.stderr.write(f"[harness] skipping unreadable {idea_path}\n")


def filter_ideas(
    ideas: Iterable[Idea],
    *,
    status: str | None = None,
    project: str | None = None,
    score_gte: int | None = None,
) -> list[Idea]:
    out: list[Idea] = []
    for idea in ideas:
        if status and idea.status != status:
            continue
        if project and idea.project != project:
            continue
        if score_gte is not None and (idea.score or 0) < score_gte:
            continue
        out.append(idea)
    return out
