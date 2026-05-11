"""harness mcp serve — JSON-RPC 2.0 stdio MCP transport.

Speaks the MCP "tools" subset over stdio: initialize → tools/list →
tools/call. That's the minimum a Claude Code session needs to discover
and invoke harness verbs as MCP tools.

Why not the official Python MCP SDK: the SDK ships an async stack
(anyio + a server framework) that's overkill for what we need here.
The wire format is plain JSON-RPC 2.0 with content-length framing in
some implementations and newline-delimited in others — Claude Code's
client supports the newline-delimited form, which is much simpler to
serve from stdlib alone.

HTTP+Tailscale transport (for the Phase 3 mobile app) is intentionally
deferred. The shape of the tool registry below is transport-agnostic;
when Phase 3 lands, we add an `http_serve` mode that wraps the same
TOOL_REGISTRY in an aiohttp listener with token auth.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable

from .. import index as index_mod
from ..state import (
    Idea,
    IdeaNotFound,
    InvalidStatus,
    filter_ideas,
    iter_ideas,
    now_iso,
)

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "idea-harness"
SERVER_VERSION = "0.1.0"


# ----- tool implementations ---------------------------------------------


def _idea_summary(idea: Idea) -> dict[str, Any]:
    return {
        "slug": idea.slug,
        "title": idea.title,
        "status": idea.status,
        "project": idea.project,
        "score": idea.score,
        "last_touched": idea.last_touched,
        "path": str(idea.path),
    }


def tool_ideas_list(args: dict[str, Any]) -> dict[str, Any]:
    ideas = filter_ideas(
        iter_ideas(),
        status=args.get("status"),
        project=args.get("project"),
        score_gte=args.get("score_gte"),
    )
    return {"ideas": [_idea_summary(i) for i in ideas], "count": len(ideas)}


def tool_ideas_show(args: dict[str, Any]) -> dict[str, Any]:
    slug = args["slug"]
    idea = Idea.from_slug(slug)
    return {
        **_idea_summary(idea),
        "frontmatter": idea.frontmatter,
        "body": idea.body,
    }


def _mutate(slug: str, new_status: str, *, note: str | None) -> dict[str, Any]:
    idea = Idea.from_slug(slug)
    prev = idea.status
    idea.set_status(new_status)
    if new_status in ("brainstormed", "rejected"):
        idea.set(decided_at=now_iso())
    if note:
        idea.append_note(f"via MCP: {note}")
    else:
        idea.append_note(f"via MCP (status: {prev} → {new_status})")
    idea.save()
    index_mod.upsert(idea)
    return {"slug": slug, "previous_status": prev, "status": new_status}


def tool_ideas_accept(args: dict[str, Any]) -> dict[str, Any]:
    return _mutate(args["slug"], "brainstormed", note=args.get("note"))


def tool_ideas_reject(args: dict[str, Any]) -> dict[str, Any]:
    return _mutate(args["slug"], "rejected", note=args.get("note"))


def tool_ideas_reroute(args: dict[str, Any]) -> dict[str, Any]:
    idea = Idea.from_slug(args["slug"])
    previous = idea.project or "~"
    new_project = args["project"]
    idea.set(project=new_project, last_touched=now_iso())
    idea.append_note(f"rerouted via MCP from {previous} → {new_project}")
    idea.save()
    index_mod.upsert(idea)
    return {"slug": args["slug"], "previous_project": previous, "project": new_project}


def tool_capture(args: dict[str, Any]) -> dict[str, Any]:
    # Implement here to avoid a circular import with commands.capture.
    from ..slug import gen_id, slugify
    from ..state import SPECS_DIR

    title = args["title"].strip()
    project = args.get("project")
    notes = args.get("notes")
    source = args.get("source") or "mcp"

    idea_id = gen_id(8)
    slug = slugify(title, idea_id)
    spec_dir = SPECS_DIR / slug
    if spec_dir.exists():
        raise RuntimeError(f"spec dir already exists: {spec_dir}")

    captured_at = now_iso()
    fm: dict[str, Any] = {
        "id": idea_id,
        "slug": slug,
        "title": title,
        "status": "captured",
        "source": source,
        "captured_at": captured_at,
        "last_touched": captured_at,
        "loop_count": 0,
    }
    if project:
        fm["project"] = project
    body_parts = ["", "## Raw Idea", "", title, ""]
    if notes:
        body_parts += ["## Notes", "", notes.strip(), ""]
    body_parts += ["## Brainstorm", "", "<!-- Filled by the brainstormer. -->", ""]
    idea = Idea(path=spec_dir / "idea.md", frontmatter=fm, body="\n".join(body_parts))
    idea.save()
    index_mod.upsert(idea)
    return {"slug": slug, "path": str(idea.path)}


# Registry: tool name → (handler, JSON schema for inputs, description)
TOOL_REGISTRY: dict[str, dict[str, Any]] = {
    "ideas.list": {
        "handler": tool_ideas_list,
        "description": "List ideas, optionally filtered by status/project/score_gte. Returns a summary array.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string"},
                "project": {"type": "string"},
                "score_gte": {"type": "integer"},
            },
        },
    },
    "ideas.show": {
        "handler": tool_ideas_show,
        "description": "Read the full frontmatter + body of one idea by slug.",
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"],
        },
    },
    "ideas.accept": {
        "handler": tool_ideas_accept,
        "description": "Flip an idea's status to brainstormed (the harness's 'accepted' state).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "note": {"type": "string"},
            },
            "required": ["slug"],
        },
    },
    "ideas.reject": {
        "handler": tool_ideas_reject,
        "description": "Flip an idea's status to rejected. Archived, not deleted.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "note": {"type": "string"},
            },
            "required": ["slug"],
        },
    },
    "ideas.reroute": {
        "handler": tool_ideas_reroute,
        "description": "Change an idea's project key (must match a key in projects.yml).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["slug", "project"],
        },
    },
    "capture": {
        "handler": tool_capture,
        "description": "Capture a new idea at status: captured.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "project": {"type": "string"},
                "notes": {"type": "string"},
                "source": {"type": "string"},
            },
            "required": ["title"],
        },
    },
}


# ----- JSON-RPC plumbing ------------------------------------------------


def _response(req_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    return msg


def _handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method", "")
    req_id = request.get("id")
    params = request.get("params") or {}

    # Notifications have no id; we never reply.
    is_notification = req_id is None

    try:
        if method == "initialize":
            result = {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            }
        elif method == "tools/list":
            tools = [
                {
                    "name": name,
                    "description": spec["description"],
                    "inputSchema": spec["inputSchema"],
                }
                for name, spec in TOOL_REGISTRY.items()
            ]
            result = {"tools": tools}
        elif method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments") or {}
            spec = TOOL_REGISTRY.get(tool_name)
            if not spec:
                return _response(req_id, error={"code": -32601, "message": f"unknown tool: {tool_name}"})
            handler: Callable[[dict[str, Any]], dict[str, Any]] = spec["handler"]
            output = handler(tool_args)
            # MCP tools/call returns `content` array of text blocks.
            result = {
                "content": [{"type": "text", "text": json.dumps(output, indent=2)}],
                "isError": False,
            }
        elif method in ("notifications/initialized", "notifications/cancelled"):
            return None
        elif method == "ping":
            result = {}
        elif method == "shutdown":
            result = None
        else:
            return _response(req_id, error={"code": -32601, "message": f"unknown method: {method}"})
    except IdeaNotFound as exc:
        return _response(req_id, error={"code": -32602, "message": str(exc)})
    except InvalidStatus as exc:
        return _response(req_id, error={"code": -32602, "message": str(exc)})
    except Exception as exc:  # noqa: BLE001
        return _response(req_id, error={"code": -32603, "message": f"internal error: {exc!r}"})

    if is_notification:
        return None
    return _response(req_id, result=result)


def _log(msg: str) -> None:
    # Log to stderr so it doesn't corrupt the JSON-RPC stream on stdout.
    if os.environ.get("HARNESS_MCP_DEBUG"):
        sys.stderr.write(f"[harness-mcp] {msg}\n")
        sys.stderr.flush()


def cmd_serve(args: argparse.Namespace) -> int:
    """Run the stdio server. Reads newline-delimited JSON-RPC from stdin,
    writes responses to stdout."""
    _log(f"started {SERVER_NAME} v{SERVER_VERSION}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            err = _response(None, error={"code": -32700, "message": f"parse error: {exc}"})
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()
            continue

        # Batch: a list of requests means a JSON-RPC batch.
        if isinstance(request, list):
            responses = []
            for sub in request:
                resp = _handle(sub) if isinstance(sub, dict) else None
                if resp is not None:
                    responses.append(resp)
            if responses:
                sys.stdout.write(json.dumps(responses) + "\n")
                sys.stdout.flush()
            continue

        if not isinstance(request, dict):
            continue
        response = _handle(request)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
        if request.get("method") == "shutdown":
            break

    _log("stdin closed; exiting")
    return 0
