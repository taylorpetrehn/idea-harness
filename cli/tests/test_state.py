"""Frontmatter round-trip + status guard rails."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from harness.state import (
    Idea,
    InvalidStatus,
    parse_frontmatter,
    render_frontmatter,
)


SAMPLE_FM = textwrap.dedent("""\
    ---
    id: abc1
    slug: example-idea-abc1
    title: "Example idea"
    status: captured
    source: cli
    project: letsbarker
    score: 12
    captured_at: 2026-05-11T20:00:00Z
    last_touched: 2026-05-11T20:00:00Z
    loop_count: 0
    ---

    ## Raw Idea

    Example idea
    """)


def test_parse_frontmatter_basic():
    fm, body = parse_frontmatter(SAMPLE_FM)
    assert fm["id"] == "abc1"
    assert fm["slug"] == "example-idea-abc1"
    assert fm["title"] == "Example idea"
    assert fm["status"] == "captured"
    assert fm["score"] == 12  # int coercion
    assert fm["loop_count"] == 0
    assert "Example idea" in body


def test_parse_frontmatter_null_values():
    text = "---\nfoo: ~\nbar:\nbaz: null\n---\n"
    fm, _ = parse_frontmatter(text)
    assert fm["foo"] is None
    assert fm["bar"] is None
    assert fm["baz"] is None


def test_parse_frontmatter_booleans():
    text = "---\nflag: true\nother: false\n---\nbody\n"
    fm, body = parse_frontmatter(text)
    assert fm["flag"] is True
    assert fm["other"] is False
    assert body == "body\n"


def test_render_frontmatter_key_order():
    # FRONTMATTER_KEY_ORDER puts id → slug → title → status → ... → score
    fm = {"score": 9, "title": "x", "slug": "x-1234", "status": "captured"}
    rendered = render_frontmatter(fm)
    lines = [ln for ln in rendered.splitlines() if ":" in ln]
    keys = [ln.split(":")[0] for ln in lines]
    assert keys.index("slug") < keys.index("title") < keys.index("status") < keys.index("score")


def test_render_frontmatter_quoting():
    fm = {"title": "has: colon"}
    rendered = render_frontmatter(fm)
    assert 'title: "has: colon"' in rendered


def test_idea_round_trip(tmp_path: Path):
    path = tmp_path / "specs" / "demo" / "idea.md"
    path.parent.mkdir(parents=True)
    path.write_text(SAMPLE_FM)
    idea = Idea.load(path)
    assert idea.status == "captured"
    assert idea.score == 12
    assert idea.project == "letsbarker"
    idea.save()
    # Re-load and assert nothing important drifted.
    reloaded = Idea.load(path)
    assert reloaded.frontmatter == idea.frontmatter


def test_set_status_validates(tmp_path: Path):
    path = tmp_path / "specs" / "demo" / "idea.md"
    path.parent.mkdir(parents=True)
    path.write_text(SAMPLE_FM)
    idea = Idea.load(path)
    with pytest.raises(InvalidStatus):
        idea.set_status("nope")
    idea.set_status("brainstormed")
    assert idea.status == "brainstormed"
    assert idea.frontmatter["last_touched"]  # bumped


def test_append_note_creates_section(tmp_path: Path):
    path = tmp_path / "specs" / "demo" / "idea.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nstatus: captured\n---\n\n## Raw Idea\n\nhi\n")
    idea = Idea.load(path)
    idea.append_note("first note")
    assert "## Notes" in idea.body
    assert "first note" in idea.body


def test_append_note_into_existing_section(tmp_path: Path):
    path = tmp_path / "specs" / "demo" / "idea.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nstatus: captured\n---\n\n## Raw Idea\n\nhi\n\n## Notes\n\n> 2026-01-01: old note\n")
    idea = Idea.load(path)
    idea.append_note("second note")
    assert "second note" in idea.body
    assert "old note" in idea.body  # didn't clobber

    # Should appear ABOVE the existing notes (insert after section header)
    notes_idx = idea.body.index("## Notes")
    new_idx = idea.body.index("second note", notes_idx)
    old_idx = idea.body.index("old note", notes_idx)
    assert new_idx < old_idx
