"""HTTP MCP transport — token auth, JSON-RPC framing, error paths."""

from __future__ import annotations

import json
import socket
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path

import pytest

from harness.commands import mcp_server as mcp


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start(token: str, port: int) -> tuple["mcp._ThreadingServer", threading.Thread]:
    handler_cls = type("_TestHandler", (mcp._MCPHandler,), {"server_token": token})
    server = mcp._ThreadingServer(("127.0.0.1", port), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Tiny wait for the listener to be ready.
    deadline = time.time() + 2
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
        except OSError:
            time.sleep(0.02)
    return server, thread


def _post(port: int, body: dict | list, *, token: str | None) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/rpc",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            payload = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(payload)
            except json.JSONDecodeError:
                return resp.status, payload
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(body_text)
        except json.JSONDecodeError:
            return exc.code, body_text


@pytest.fixture()
def http_server():
    token = "test-token-" + "x" * 32
    port = _free_port()
    server, thread = _start(token, port)
    try:
        yield port, token
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_unauthed_request_is_401(http_server):
    port, _ = http_server
    status, body = _post(port, {"jsonrpc": "2.0", "id": 1, "method": "initialize"}, token=None)
    assert status == 401


def test_wrong_token_is_401(http_server):
    port, _ = http_server
    status, _ = _post(port, {"jsonrpc": "2.0", "id": 1, "method": "initialize"}, token="wrong")
    assert status == 401


def test_authed_initialize(http_server):
    port, token = http_server
    status, body = _post(port, {"jsonrpc": "2.0", "id": 1, "method": "initialize"}, token=token)
    assert status == 200
    assert body["jsonrpc"] == "2.0"
    assert body["id"] == 1
    assert body["result"]["serverInfo"]["name"] == "idea-harness"
    assert "protocolVersion" in body["result"]


def test_authed_tools_list(http_server):
    port, token = http_server
    status, body = _post(port, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, token=token)
    assert status == 200
    tools = {t["name"] for t in body["result"]["tools"]}
    assert "ideas.list" in tools
    assert "capture" in tools


def test_authed_tools_call_invokes_handler(http_server, tmp_path: Path, monkeypatch):
    # Redirect SPECS_DIR so the handler doesn't read the user's real ideas.
    monkeypatch.setattr("harness.state.SPECS_DIR", tmp_path / "specs")
    monkeypatch.setattr("harness.commands.mcp_server.SPECS_DIR", tmp_path / "specs", raising=False)

    port, token = http_server
    status, body = _post(
        port,
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "ideas.list", "arguments": {}}},
        token=token,
    )
    assert status == 200
    text = body["result"]["content"][0]["text"]
    inner = json.loads(text)
    assert inner["count"] == 0
    assert inner["ideas"] == []


def test_unknown_tool_is_json_rpc_error(http_server):
    port, token = http_server
    status, body = _post(
        port,
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "no.such.tool", "arguments": {}}},
        token=token,
    )
    assert status == 200  # JSON-RPC errors return 200 with error body
    assert "error" in body
    assert body["error"]["code"] == -32601


def test_malformed_body_is_400(http_server):
    port, token = http_server
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/rpc",
        data=b"not json",
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            assert False, "expected HTTPError"
    except urllib.error.HTTPError as exc:
        assert exc.code == 400


def test_generate_token_creates_chmod_600_file(tmp_path: Path):
    target = tmp_path / "token"
    token = mcp._gen_token_to(str(target))
    assert target.is_file()
    assert target.read_text().strip() == token
    assert len(token) >= 32
    # mode bits: owner-read+write only
    mode = target.stat().st_mode & 0o777
    assert mode == 0o600


def test_load_token_rejects_empty(tmp_path: Path):
    p = tmp_path / "empty"
    p.write_text("")
    with pytest.raises(ValueError):
        mcp._load_token(str(p))
