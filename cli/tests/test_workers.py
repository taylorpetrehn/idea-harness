"""Worker factory + worker-selection precedence."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest

from harness import workers
from harness.commands.ideas import _resolve_worker, _read_project_default_worker
from harness.state import Idea


def test_get_worker_local():
    w = workers.get_worker("local")
    assert w.name == "local"
    assert hasattr(w, "build")


def test_get_worker_gh_action():
    w = workers.get_worker("gh-action")
    assert w.name == "gh-action"
    assert hasattr(w, "build")


def test_get_worker_codespace():
    w = workers.get_worker("codespace")
    assert w.name == "codespace"
    assert hasattr(w, "build")


def test_get_worker_unknown():
    with pytest.raises(KeyError):
        workers.get_worker("aws-batch")


def _make_idea_with_project(tmp_path: Path, project: str) -> Idea:
    spec_dir = tmp_path / "specs" / "demo-1234"
    spec_dir.mkdir(parents=True)
    text = textwrap.dedent(f"""\
        ---
        slug: demo-1234
        title: "Demo idea"
        status: brainstormed
        project: {project}
        last_touched: 2026-05-12T00:00:00Z
        ---

        ## Raw Idea

        demo
        """)
    (spec_dir / "idea.md").write_text(text)
    return Idea.load(spec_dir / "idea.md")


def test_resolve_worker_explicit_flag_wins(tmp_path: Path):
    idea = _make_idea_with_project(tmp_path, "letsbarker")
    assert _resolve_worker("gh-action", idea) == "gh-action"
    assert _resolve_worker("codespace", idea) == "codespace"
    assert _resolve_worker("local", idea) == "local"


def test_resolve_worker_auto_falls_back_to_local_when_no_config(tmp_path: Path):
    # No projects.yml on disk in this fake harness skill dir.
    idea = _make_idea_with_project(tmp_path, "definitely-not-real")
    assert _resolve_worker("auto", idea) == "local"


def test_read_project_default_worker_from_harness_config(tmp_path: Path, monkeypatch):
    # Fake the harness skill dir + a project's .harness/config.json with
    # vcs.default_worker set.
    skill_dir = tmp_path / "skills" / "idea-harness"
    skill_dir.mkdir(parents=True)
    refs = skill_dir / "references"
    refs.mkdir()
    project_repo = tmp_path / "fakebarker"
    project_repo.mkdir()
    (project_repo / ".harness").mkdir()
    (project_repo / ".harness" / "config.json").write_text(
        json.dumps({
            "name": "fakebarker",
            "vcs": {
                "base_branch": "main",
                "default_worker": "gh-action",
            },
        })
    )
    (refs / "projects.yml").write_text(
        textwrap.dedent(f"""\
            projects:
              fakebarker:
                github_repo: "owner/fakebarker"
                local_path: "{project_repo}"
                base_branch: "main"
            """)
    )
    monkeypatch.setattr("harness.commands.ideas.SKILL_DIR", skill_dir)
    assert _read_project_default_worker("fakebarker") == "gh-action"


def test_read_project_default_worker_returns_none_when_unset(tmp_path: Path, monkeypatch):
    skill_dir = tmp_path / "skills" / "idea-harness"
    refs = skill_dir / "references"
    refs.mkdir(parents=True)
    project_repo = tmp_path / "fakebarker"
    (project_repo / ".harness").mkdir(parents=True)
    (project_repo / ".harness" / "config.json").write_text(
        json.dumps({"name": "fakebarker", "vcs": {"base_branch": "main"}})
    )
    (refs / "projects.yml").write_text(
        textwrap.dedent(f"""\
            projects:
              fakebarker:
                github_repo: "owner/fakebarker"
                local_path: "{project_repo}"
                base_branch: "main"
            """)
    )
    monkeypatch.setattr("harness.commands.ideas.SKILL_DIR", skill_dir)
    assert _read_project_default_worker("fakebarker") is None


def test_valid_workers_constant():
    assert "local" in workers.VALID_WORKERS
    assert "gh-action" in workers.VALID_WORKERS
    assert "codespace" in workers.VALID_WORKERS
