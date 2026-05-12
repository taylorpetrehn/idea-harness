"""Claude Code 2.1.139 integration: agents.list MCP tool + init-harness env hints."""

from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from harness.commands import init_harness as init_mod
from harness.commands import mcp_server as mcp


# ---------- agents.list ---------------------------------------------------


def test_agents_list_no_claude_binary(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    out = mcp.tool_agents_list({})
    assert out["count"] == 0
    assert out["agents"] == []
    assert "not on PATH" in out["error"]


def test_agents_list_normalizes_running_sessions(monkeypatch):
    raw = [
        {
            "id": "sess-a",
            "status": "RUNNING",
            "summary": "building tooter v1.2",
            "started_at": "2026-05-11T20:00:00Z",
            "cwd": "/Users/t/Projects/tooter",
            "model": "claude-opus-4-7",
        },
        {
            "session_id": "sess-b",
            "status": "blocked",
            "title": "needs PAT",
            "startedAt": "2026-05-11T20:05:00Z",
            "workdir": "/Users/t/Projects/foo",
        },
        "garbage-not-a-dict",
    ]
    monkeypatch.setattr("shutil.which", lambda _: "/usr/local/bin/claude")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(raw), stderr=""),
    )
    out = mcp.tool_agents_list({})
    assert out["count"] == 2  # garbage entry dropped
    a, b = out["agents"]
    assert a["id"] == "sess-a"
    assert a["status"] == "running"  # lowercased
    assert a["summary"] == "building tooter v1.2"
    assert b["id"] == "sess-b"
    assert b["status"] == "blocked"
    assert b["summary"] == "needs PAT"  # falls back to "title"
    assert b["cwd"] == "/Users/t/Projects/foo"  # falls back to "workdir"


def test_agents_list_status_filter_and_limit(monkeypatch):
    raw = [
        {"id": "r1", "status": "running", "summary": "x"},
        {"id": "r2", "status": "running", "summary": "y"},
        {"id": "b1", "status": "blocked", "summary": "z"},
    ]
    monkeypatch.setattr("shutil.which", lambda _: "/bin/claude")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(raw), stderr=""),
    )
    only_running = mcp.tool_agents_list({"status": "running"})
    assert {a["id"] for a in only_running["agents"]} == {"r1", "r2"}
    limited = mcp.tool_agents_list({"limit": 1})
    assert limited["count"] == 1


def test_agents_list_handles_subprocess_error(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: "/bin/claude")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(returncode=2, stdout="", stderr="boom"),
    )
    out = mcp.tool_agents_list({})
    assert out["count"] == 0
    assert "exited 2" in out["error"]
    assert "boom" in out["error"]


def test_agents_list_in_tool_registry():
    assert "agents.list" in mcp.TOOL_REGISTRY
    spec = mcp.TOOL_REGISTRY["agents.list"]
    assert callable(spec["handler"])
    props = spec["inputSchema"]["properties"]
    assert "status" in props and "limit" in props


# ---------- init-harness env hints ----------------------------------------


def _make_args(repo_path: str, name: str | None = None, apply: bool = False) -> argparse.Namespace:
    return argparse.Namespace(repo_path=repo_path, name=name, apply=apply)


def test_init_harness_uses_claude_project_dir(tmp_path, monkeypatch, capsys):
    (tmp_path / "package.json").write_text("{}")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    rc = init_mod.cmd_init_harness(_make_args("."))
    assert rc == 0
    captured = capsys.readouterr()
    assert "using CLAUDE_PROJECT_DIR" in captured.out
    assert str(tmp_path) in captured.out


def test_init_harness_explicit_path_overrides_claude_project_dir(tmp_path, monkeypatch, capsys):
    other = tmp_path / "other"
    other.mkdir()
    (other / "package.json").write_text("{}")
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))  # should be ignored
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    rc = init_mod.cmd_init_harness(_make_args(str(other)))
    assert rc == 0
    captured = capsys.readouterr()
    # The explicit path was respected; no env hint message.
    assert "using CLAUDE_PROJECT_DIR" not in captured.out


def test_init_harness_warns_on_anthropic_api_key(tmp_path, monkeypatch, capsys):
    (tmp_path / "package.json").write_text("{}")
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-xyz")

    rc = init_mod.cmd_init_harness(_make_args(str(tmp_path)))
    assert rc == 0
    captured = capsys.readouterr()
    assert "ANTHROPIC_API_KEY is set" in captured.err
    assert "Remote Control" in captured.err


def test_init_harness_no_warning_when_api_key_unset(tmp_path, monkeypatch, capsys):
    (tmp_path / "package.json").write_text("{}")
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    rc = init_mod.cmd_init_harness(_make_args(str(tmp_path)))
    assert rc == 0
    captured = capsys.readouterr()
    assert "ANTHROPIC_API_KEY" not in captured.err
