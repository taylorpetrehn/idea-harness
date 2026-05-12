"""SQLite index rebuild + query."""

from __future__ import annotations

import textwrap
from pathlib import Path

from harness import index as index_mod
from harness.state import Idea


def _make_idea(specs_dir: Path, slug: str, status: str, project: str | None, score: int) -> Path:
    spec_dir = specs_dir / slug
    spec_dir.mkdir(parents=True)
    fm = [
        "---",
        f"slug: {slug}",
        f'title: "Test {slug}"',
        f"status: {status}",
    ]
    if project:
        fm.append(f"project: {project}")
    fm.append(f"score: {score}")
    fm.append("last_touched: 2026-05-11T00:00:00Z")
    fm.append("---")
    fm.append("\n## Raw Idea\n\nbody\n")
    (spec_dir / "idea.md").write_text("\n".join(fm))
    return spec_dir / "idea.md"


def test_rebuild_indexes_all(tmp_path: Path):
    specs = tmp_path / "specs"
    _make_idea(specs, "alpha-1234", "captured", "letsbarker", 10)
    _make_idea(specs, "bravo-2345", "shipped", "tooter", 12)
    _make_idea(specs, "cee-3456", "rejected", None, 5)

    db = tmp_path / "index.sqlite"
    count = index_mod.rebuild(specs_dir=specs, db_path=db)
    assert count == 3


def test_query_filters(tmp_path: Path):
    specs = tmp_path / "specs"
    _make_idea(specs, "alpha-1234", "captured", "letsbarker", 10)
    _make_idea(specs, "bravo-2345", "shipped", "tooter", 12)
    _make_idea(specs, "cee-3456", "rejected", "letsbarker", 5)

    db = tmp_path / "index.sqlite"
    index_mod.rebuild(specs_dir=specs, db_path=db)

    captured = list(index_mod.query(db, status="captured"))
    assert len(captured) == 1
    assert captured[0]["slug"] == "alpha-1234"

    letsbarker = list(index_mod.query(db, project="letsbarker"))
    assert {r["slug"] for r in letsbarker} == {"alpha-1234", "cee-3456"}

    high_score = list(index_mod.query(db, score_gte=10))
    assert {r["slug"] for r in high_score} == {"alpha-1234", "bravo-2345"}


def test_upsert_idempotent(tmp_path: Path):
    specs = tmp_path / "specs"
    path = _make_idea(specs, "alpha-1234", "captured", "letsbarker", 10)
    db = tmp_path / "index.sqlite"
    index_mod.rebuild(specs_dir=specs, db_path=db)

    idea = Idea.load(path)
    idea.set(status="brainstormed")
    index_mod.upsert(idea, db)

    rows = list(index_mod.query(db))
    assert len(rows) == 1
    assert rows[0]["status"] == "brainstormed"
