"""SQLite mirror of ~/.claude/plans/specs/<slug>/idea.md frontmatter.

The filesystem is canonical; this is just a derived cache that lets
list/search be fast on a big queue. Built (or rebuilt) by
`harness reindex`. If the file is missing or stale, list/show still work
— they fall back to filesystem scans.

Schema:
  ideas(slug TEXT PK, status, title, project, score INTEGER, ...)

Rebuild semantics: `reindex` blows away the table and re-inserts every
idea. No incremental sync — cheap on the scale we expect (<1000 ideas).
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Iterable

from .state import Idea, SPECS_DIR, iter_ideas

HOME = Path.home()
INDEX_PATH = Path(os.environ.get("HARNESS_INDEX", str(HOME / ".claude" / "plans" / "index.sqlite")))

INDEXED_KEYS: tuple[str, ...] = (
    "slug",
    "status",
    "title",
    "project",
    "score",
    "source",
    "captured_at",
    "brainstormed_at",
    "decided_at",
    "last_touched",
    "critic_verdict",
    "loop_count",
    "github_issue",
    "github_pr",
    "do_not_build",
)

DDL = """
CREATE TABLE IF NOT EXISTS ideas (
    slug TEXT PRIMARY KEY,
    status TEXT,
    title TEXT,
    project TEXT,
    score INTEGER,
    source TEXT,
    captured_at TEXT,
    brainstormed_at TEXT,
    decided_at TEXT,
    last_touched TEXT,
    critic_verdict TEXT,
    loop_count INTEGER,
    github_issue TEXT,
    github_pr TEXT,
    do_not_build INTEGER,
    path TEXT
);
CREATE INDEX IF NOT EXISTS ideas_status ON ideas(status);
CREATE INDEX IF NOT EXISTS ideas_project ON ideas(project);
CREATE INDEX IF NOT EXISTS ideas_last_touched ON ideas(last_touched DESC);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or INDEX_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.executescript(DDL)
    return conn


def _row_for(idea: Idea) -> dict[str, object]:
    row: dict[str, object] = {key: None for key in INDEXED_KEYS}
    for key in INDEXED_KEYS:
        if key in idea.frontmatter:
            value = idea.frontmatter[key]
            if key == "do_not_build" and isinstance(value, bool):
                row[key] = 1 if value else 0
            else:
                row[key] = value
    row["slug"] = idea.slug
    row["path"] = str(idea.path)
    return row


def rebuild(specs_dir: Path | None = None, db_path: Path | None = None) -> int:
    """Wipe and re-insert. Returns the row count."""
    conn = connect(db_path)
    with conn:
        conn.execute("DELETE FROM ideas")
        count = 0
        for idea in iter_ideas(specs_dir):
            row = _row_for(idea)
            placeholders = ", ".join(":" + k for k in row)
            cols = ", ".join(row.keys())
            conn.execute(f"INSERT INTO ideas ({cols}) VALUES ({placeholders})", row)
            count += 1
    conn.close()
    return count


def upsert(idea: Idea, db_path: Path | None = None) -> None:
    """Insert or replace one idea in the index. Best-effort; failures
    are not fatal (filesystem is canonical)."""
    try:
        conn = connect(db_path)
        with conn:
            row = _row_for(idea)
            placeholders = ", ".join(":" + k for k in row)
            cols = ", ".join(row.keys())
            conn.execute(
                f"INSERT OR REPLACE INTO ideas ({cols}) VALUES ({placeholders})", row
            )
        conn.close()
    except Exception:
        import sys
        sys.stderr.write("[harness] index upsert failed (non-fatal)\n")


def query(
    db_path: Path | None = None,
    *,
    status: str | None = None,
    project: str | None = None,
    score_gte: int | None = None,
) -> Iterable[sqlite3.Row]:
    conn = connect(db_path)
    where = []
    params: dict[str, object] = {}
    if status:
        where.append("status = :status")
        params["status"] = status
    if project:
        where.append("project = :project")
        params["project"] = project
    if score_gte is not None:
        where.append("COALESCE(score, 0) >= :score_gte")
        params["score_gte"] = score_gte
    sql = "SELECT * FROM ideas"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY last_touched DESC"
    yield from conn.execute(sql, params)
    conn.close()
