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
from pathlib import Path
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


def tool_agents_list(args: dict[str, Any]) -> dict[str, Any]:
    """Wrap `claude agents --json` (new in Claude Code 2.1.139).

    Returns a normalized {agents: [{id, status, summary, started_at, ...}], count: N}
    so the mobile app can render a "live sessions" section alongside the
    idea Inbox without parsing the raw `claude agents` schema.

    args (all optional):
      - status: filter to one of running|blocked|done|failed
      - limit:  cap result count (default 50)
    """
    import json as _json
    import shutil as _shutil
    import subprocess as _subprocess

    claude = _shutil.which("claude")
    if not claude:
        return {"agents": [], "count": 0, "error": "claude binary not on PATH"}
    try:
        proc = _subprocess.run(
            [claude, "agents", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except _subprocess.TimeoutExpired:
        return {"agents": [], "count": 0, "error": "claude agents --json timed out"}
    if proc.returncode != 0:
        return {
            "agents": [],
            "count": 0,
            "error": f"claude agents --json exited {proc.returncode}: {proc.stderr.strip()[:200]}",
        }
    try:
        raw = _json.loads(proc.stdout or "[]")
    except _json.JSONDecodeError as exc:
        return {"agents": [], "count": 0, "error": f"non-JSON from claude agents: {exc}"}

    # claude agents returns a list of objects; shape isn't 100% locked
    # across versions, so we normalize defensively.
    items = raw if isinstance(raw, list) else (raw.get("agents") or [])
    normalized = []
    for a in items:
        if not isinstance(a, dict):
            continue
        normalized.append(
            {
                "id": a.get("id") or a.get("session_id") or a.get("sessionId"),
                "status": (a.get("status") or "unknown").lower(),
                "summary": a.get("summary") or a.get("title") or a.get("description") or "",
                "started_at": a.get("started_at") or a.get("startedAt"),
                "cwd": a.get("cwd") or a.get("workdir"),
                "model": a.get("model"),
            }
        )

    status_filter = args.get("status")
    if status_filter:
        normalized = [a for a in normalized if a["status"] == status_filter]
    limit = args.get("limit") or 50
    if isinstance(limit, int) and limit > 0:
        normalized = normalized[:limit]
    return {"agents": normalized, "count": len(normalized)}


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
    "agents.list": {
        "handler": tool_agents_list,
        "description": (
            "List live Claude Code agent sessions (new in Claude Code 2.1.139). "
            "Wraps `claude agents --json` and normalizes the shape so the mobile "
            "Inbox can render running / blocked / done sessions alongside ideas."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "description": "Optional filter: running|blocked|done|failed",
                },
                "limit": {"type": "integer", "description": "Cap result count (default 50)"},
            },
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


def _log_env_context() -> None:
    """One-shot at startup: log Claude Code 2.1.139+ env hints if present.

    `CLAUDE_PROJECT_DIR` is automatically set by Claude Code when it
    spawns an MCP server over stdio. Phase-4-and-prior code in this
    package resolved project dirs by reading projects.yml or by
    requiring an explicit --cwd; now we have a project hint for free.
    Tools that need a "current project" anchor (e.g. capture-without-
    explicit-project) can fall back to this env var.
    """
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        _log(f"CLAUDE_PROJECT_DIR={project_dir}")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        _log(
            "ANTHROPIC_API_KEY is set; Remote Control / /schedule / claude.ai "
            "MCP connectors are disabled. The harness escalation flow needs RC — "
            "consider unsetting it for the cron jobs that depend on RC."
        )


def cmd_serve(args: argparse.Namespace) -> int:
    """Dispatch to stdio (default) or HTTP (Phase 3) transport.

    Both transports share the same _handle() entry point and TOOL_REGISTRY;
    only the framing differs.
    """
    if getattr(args, "http", False):
        return _cmd_http_serve(args)
    return _cmd_stdio_serve(args)


def _cmd_stdio_serve(args: argparse.Namespace) -> int:
    """Run the stdio server. Reads newline-delimited JSON-RPC from stdin,
    writes responses to stdout."""
    _log(f"started {SERVER_NAME} v{SERVER_VERSION}")
    _log_env_context()
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


# ===== HTTP transport (Phase 3) =========================================
#
# Wraps the same _handle() in a tiny stdlib HTTP server with bearer-token
# auth. Designed for binding to a Tailscale tailnet IP (or 127.0.0.1 +
# `tailscale serve` for the funnel case).
#
# Wire format:
#   POST /rpc
#   Authorization: Bearer <token>
#   Content-Type: application/json
#   Body: a single JSON-RPC 2.0 request (no batching)
#
#   Response: 200 + JSON-RPC 2.0 response, or:
#     400 — malformed JSON / not an object
#     401 — missing or wrong Authorization header
#     405 — wrong method
#     500 — unexpected server error (the JSON-RPC error case still 200s
#           with an `error` body, like stdio mode)
#
# We deliberately don't speak the full MCP HTTP streaming transport
# spec — the official spec uses Server-Sent Events for notifications,
# which we don't need yet (the mobile app polls). When/if the mobile
# app needs server-pushed events, we add an /events SSE endpoint here.

import http.server
import secrets as _secrets
import socketserver
import threading


def _load_token(path: str) -> str:
    p = Path(path).expanduser()
    if not p.is_file():
        raise FileNotFoundError(f"token file not found: {p}")
    token = p.read_text().strip()
    if not token:
        raise ValueError(f"token file is empty: {p}")
    return token


def _gen_token_to(path: str) -> str:
    """Generate a 32-byte URL-safe token, write to path, chmod 600.
    Returns the token."""
    p = Path(path).expanduser()
    p.parent.mkdir(parents=True, exist_ok=True)
    token = _secrets.token_urlsafe(32)
    p.write_text(token + "\n")
    try:
        p.chmod(0o600)
    except OSError:
        pass  # best effort; non-POSIX FS may not support chmod
    return token


class _MCPHandler(http.server.BaseHTTPRequestHandler):
    # Set by the server factory below.
    server_token: str = ""

    # Quiet the default access log; we use _log() instead.
    def log_message(self, format: str, *args: Any) -> None:  # noqa: D401
        _log(f"http {self.address_string()} {format % args}")

    def _authed(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        provided = header[len("Bearer ") :].strip()
        # Constant-time compare to avoid timing oracles.
        return _secrets.compare_digest(provided, self.server_token)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # CORS for the mobile app — same-origin in production via Tailscale,
        # but the dev client runs on a different origin during expo dev.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _send_plain(self, status: int, msg: str) -> None:
        body = msg.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 — http.server naming
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "server": SERVER_NAME, "version": SERVER_VERSION})
            return
        self._send_plain(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/rpc":
            self._send_plain(404, "not found")
            return
        if not self._authed():
            self._send_plain(401, "unauthorized")
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1_000_000:
            self._send_plain(400, "missing or oversized body")
            return
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as exc:
            self._send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"parse error: {exc}"}})
            return
        if not isinstance(request, dict):
            self._send_plain(400, "expected a single JSON-RPC object (no batching in HTTP transport)")
            return

        response = _handle(request)
        if response is None:
            # Notification with no reply — return 204 No Content.
            self.send_response(204)
            self.end_headers()
            return
        self._send_json(200, response)


class _ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _cmd_http_serve(args: argparse.Namespace) -> int:
    """Run the HTTP+token server. For the Phase 3 mobile app."""
    if not args.token_file:
        sys.stderr.write("[harness-mcp] --token-file is required for --http mode\n")
        return 2

    token_path = Path(args.token_file).expanduser()
    if not token_path.is_file():
        if args.generate_token:
            token = _gen_token_to(str(token_path))
            sys.stderr.write(f"[harness-mcp] generated token at {token_path} (chmod 600)\n")
        else:
            sys.stderr.write(
                f"[harness-mcp] token file missing: {token_path}\n"
                "[harness-mcp] re-run with --generate-token to create one, or write a token to that path first.\n"
            )
            return 2
    else:
        try:
            token = _load_token(str(token_path))
        except (FileNotFoundError, ValueError) as exc:
            sys.stderr.write(f"[harness-mcp] {exc}\n")
            return 2

    bind = args.bind or "127.0.0.1"
    port = args.port or 7777
    handler_cls = type("_BoundMCPHandler", (_MCPHandler,), {"server_token": token})
    try:
        httpd = _ThreadingServer((bind, port), handler_cls)
    except OSError as exc:
        sys.stderr.write(f"[harness-mcp] failed to bind {bind}:{port}: {exc}\n")
        return 1

    sys.stderr.write(f"[harness-mcp] listening on http://{bind}:{port}/rpc\n")
    sys.stderr.write(f"[harness-mcp] token file: {token_path} ({len(token)} chars)\n")
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[harness-mcp] interrupted; shutting down\n")
    finally:
        httpd.server_close()
    return 0
