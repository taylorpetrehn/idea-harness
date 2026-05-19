"""ideas.decide — structured ## Decision write + decided_at + status flip."""

from __future__ import annotations

import argparse
import textwrap
from pathlib import Path

from harness.commands import ideas as ideas_cmd
from harness.commands.mcp_server import TOOL_REGISTRY, tool_ideas_decide
from harness.state import Idea

NEEDS_DETAIL = textwrap.dedent("""\
    ---
    id: dec1
    slug: steer-me-dec1
    title: "Steer me"
    status: needs-detail
    project: letsbarker
    decided_at: ~
    last_touched: 2026-05-11T20:00:00Z
    ---

    ## Brainstorm

    ### Variants

    - variant 1: do the simple thing
    - variant 2: do the fancy thing

    ## Open Question

    Which variant?
    """)


def _spec(tmp_path: Path, body: str = NEEDS_DETAIL, slug: str = "steer-me-dec1") -> Path:
    p = tmp_path / "specs" / slug / "idea.md"
    p.parent.mkdir(parents=True)
    p.write_text(body)
    return p


def test_append_decision_creates_section(tmp_path: Path):
    path = tmp_path / "specs" / "demo" / "idea.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nstatus: needs-detail\n---\n\n## Raw Idea\n\nhi\n")
    idea = Idea.load(path)
    idea.append_decision("go with variant 2")
    assert "## Decision" in idea.body
    assert "go with variant 2" in idea.body


def test_append_decision_appends_into_existing_section(tmp_path: Path):
    path = tmp_path / "specs" / "demo" / "idea.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        "---\nstatus: needs-detail\n---\n\n## Decision\n\n> 2026-01-01: old call\n"
    )
    idea = Idea.load(path)
    idea.append_decision("revised call")
    assert "revised call" in idea.body
    assert "old call" in idea.body  # didn't clobber


def test_cmd_decide_needs_detail_flips_and_writes(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setattr("harness.state.SPECS_DIR", tmp_path / "specs")
    path = _spec(tmp_path)

    rc = ideas_cmd.cmd_decide(
        argparse.Namespace(slug="steer-me-dec1", decision="ship the simple one", variant="1")
    )
    assert rc == 0

    idea = Idea.load(path)
    assert idea.status == "brainstormed"          # left the gate
    assert idea.get("decided_at") not in (None, "~")  # unblock signal set
    assert "## Decision" in idea.body
    assert "variant 1 — ship the simple one" in idea.body
    # variant mirrored to ## Notes so the builder's scraper picks it up
    assert "## Notes" in idea.body
    assert "variant 1" in idea.body.split("## Notes", 1)[1]


def test_cmd_decide_requires_text_or_variant(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("harness.state.SPECS_DIR", tmp_path / "specs")
    _spec(tmp_path)
    rc = ideas_cmd.cmd_decide(
        argparse.Namespace(slug="steer-me-dec1", decision=None, variant=None)
    )
    assert rc == 2  # refused


def test_cmd_decide_rejects_wrong_status(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("harness.state.SPECS_DIR", tmp_path / "specs")
    body = NEEDS_DETAIL.replace("status: needs-detail", "status: captured")
    _spec(tmp_path, body=body)
    rc = ideas_cmd.cmd_decide(
        argparse.Namespace(slug="steer-me-dec1", decision="too early", variant=None)
    )
    assert rc == 2


def test_cmd_decide_on_brainstormed_keeps_status(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("harness.state.SPECS_DIR", tmp_path / "specs")
    body = NEEDS_DETAIL.replace("status: needs-detail", "status: brainstormed")
    path = _spec(tmp_path, body=body)
    rc = ideas_cmd.cmd_decide(
        argparse.Namespace(slug="steer-me-dec1", decision="steer it left", variant=None)
    )
    assert rc == 0
    idea = Idea.load(path)
    assert idea.status == "brainstormed"  # unchanged — just re-recorded
    assert "steer it left" in idea.body
    assert idea.get("decided_at") not in (None, "~")


def test_tool_ideas_decide_flips_and_returns(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("harness.state.SPECS_DIR", tmp_path / "specs")
    monkeypatch.setattr(
        "harness.commands.mcp_server.SPECS_DIR", tmp_path / "specs", raising=False
    )
    monkeypatch.setattr(
        "harness.commands.mcp_server.index_mod.upsert", lambda _idea: None, raising=False
    )
    path = _spec(tmp_path)
    out = tool_ideas_decide({"slug": "steer-me-dec1", "decision": "go", "variant": "2"})
    assert out["previous_status"] == "needs-detail"
    assert out["status"] == "brainstormed"
    assert out["decided_at"]
    assert "## Decision" in Idea.load(path).body


def test_ideas_decide_registered():
    assert "ideas.decide" in TOOL_REGISTRY
    assert TOOL_REGISTRY["ideas.decide"]["inputSchema"]["required"] == ["slug"]
