"""Worker backends for `harness ideas build --worker {local,gh-action,codespace}`.

Each worker takes one idea and produces a `PR_URL=<url>` (or `PR_FAILED=<reason>`).
The orchestration on top is the same — only where the builder runs changes.
"""

from __future__ import annotations

from typing import Protocol

from ..state import Idea


class BuildResult:
    """Lightweight tuple: (ok, pr_url_or_reason, log_excerpt)."""

    __slots__ = ("ok", "pr_url", "reason", "log_excerpt")

    def __init__(
        self,
        ok: bool,
        *,
        pr_url: str | None = None,
        reason: str | None = None,
        log_excerpt: str = "",
    ) -> None:
        self.ok = ok
        self.pr_url = pr_url
        self.reason = reason
        self.log_excerpt = log_excerpt

    def __repr__(self) -> str:
        if self.ok:
            return f"BuildResult(ok=True, pr_url={self.pr_url!r})"
        return f"BuildResult(ok=False, reason={self.reason!r})"


class Worker(Protocol):
    """Each worker module exposes `name` and a `build(idea)` function."""

    name: str

    def build(self, idea: Idea) -> BuildResult: ...


def get_worker(name: str) -> "Worker":
    """Factory — returns the worker module by name. Raises KeyError on
    unknown names.

    Worker selection precedence (handled by the caller):
        1. --worker CLI flag (explicit)
        2. .harness/config.json:vcs.default_worker
        3. "local"
    """
    if name == "local":
        from . import local
        return local
    if name == "gh-action":
        from . import gh_action
        return gh_action
    if name == "codespace":
        from . import codespace
        return codespace
    raise KeyError(f"unknown worker: {name!r} (expected local|gh-action|codespace)")


VALID_WORKERS = ("local", "gh-action", "codespace")
