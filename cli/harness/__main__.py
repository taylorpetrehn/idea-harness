"""harness — CLI entry point.

argparse with subparsers. Verbs forward to one handler per file in
harness.commands. Subcommands return an int exit code; missing/invalid
verbs print help and exit 2.
"""

from __future__ import annotations

import argparse
import sys
from typing import Callable

from . import __version__


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler: Callable[[argparse.Namespace], int] | None = getattr(args, "_handler", None)
    if handler is None:
        parser.print_help()
        return 2
    try:
        return handler(args)
    except KeyboardInterrupt:
        sys.stderr.write("\n[harness] interrupted\n")
        return 130


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness",
        description="CLI + MCP surface for the idea-harness skill.",
    )
    parser.add_argument("--version", action="version", version=f"harness {__version__}")
    sub = parser.add_subparsers(dest="verb", metavar="VERB")

    # ----- harness ideas {list|show|accept|reject|reroute|build|brainstorm}
    p_ideas = sub.add_parser("ideas", help="List, show, or mutate captured ideas.")
    ideas_sub = p_ideas.add_subparsers(dest="ideas_verb", metavar="ACTION")

    from .commands import ideas as ideas_cmd

    p_list = ideas_sub.add_parser("list", help="List ideas grouped by status.")
    p_list.add_argument("--status", help="Only ideas with this status.")
    p_list.add_argument("--project", help="Only ideas routed to this project key.")
    p_list.add_argument("--score-gte", type=int, dest="score_gte", help="Score >= N.")
    p_list.add_argument("--json", action="store_true", help="Emit JSON lines, one idea per line.")
    p_list.set_defaults(_handler=ideas_cmd.cmd_list)

    p_show = ideas_sub.add_parser("show", help="Show one idea's frontmatter + body.")
    p_show.add_argument("slug")
    p_show.add_argument("--json", action="store_true", help="Emit JSON, not pretty text.")
    p_show.set_defaults(_handler=ideas_cmd.cmd_show)

    for verb, helptext, fn in (
        ("accept", "Mark an idea accepted (= brainstormed in this consolidated flow).", ideas_cmd.cmd_accept),
        ("reject", "Mark an idea rejected. Archived but not deleted.", ideas_cmd.cmd_reject),
    ):
        p = ideas_sub.add_parser(verb, help=helptext)
        p.add_argument("slug")
        p.add_argument("--note", help="Optional note appended to ## Notes.")
        p.set_defaults(_handler=fn)

    p_decide = ideas_sub.add_parser(
        "decide",
        help="Record a ## Decision + set decided_at (resolve a needs-detail open question / steer the idea).",
    )
    p_decide.add_argument("slug")
    p_decide.add_argument("--decision", help="Decision / steering text written to ## Decision.")
    p_decide.add_argument("--variant", help="Chosen variant identifier (e.g. 2 or 'B'); also mirrored to ## Notes for the builder.")
    p_decide.set_defaults(_handler=ideas_cmd.cmd_decide)

    p_reroute = ideas_sub.add_parser("reroute", help="Change an idea's project key.")
    p_reroute.add_argument("slug")
    p_reroute.add_argument("project", help="New project key (must exist in projects.yml).")
    p_reroute.add_argument("--note", help="Optional note appended to ## Notes.")
    p_reroute.set_defaults(_handler=ideas_cmd.cmd_reroute)

    p_build = ideas_sub.add_parser("build", help="Manually trigger a build for one idea via the chosen worker.")
    p_build.add_argument("slug")
    p_build.add_argument(
        "--worker",
        default="auto",
        choices=("auto", "local", "gh-action", "codespace"),
        help=(
            "Worker backend. Default 'auto' means: respect "
            ".harness/config.json:vcs.default_worker if set, else local. "
            "(Phase 4: gh-action and codespace.)"
        ),
    )
    p_build.set_defaults(_handler=ideas_cmd.cmd_build)

    p_brainstorm = ideas_sub.add_parser("brainstorm", help="Re-run brainstorm-captured.py on one slug.")
    p_brainstorm.add_argument("slug")
    p_brainstorm.set_defaults(_handler=ideas_cmd.cmd_brainstorm)

    # ----- harness capture
    from .commands import capture as capture_cmd

    p_capture = sub.add_parser("capture", help="Capture a new idea from the CLI.")
    p_capture.add_argument("title", help="Idea title (quoted).")
    p_capture.add_argument("--project", help="Force project routing.")
    p_capture.add_argument("--notes", help="Initial body text under ## Notes.")
    p_capture.add_argument("--source", default="cli", help="Source tag (default: cli).")
    p_capture.set_defaults(_handler=capture_cmd.cmd_capture)

    # ----- harness init-harness
    from .commands import init_harness as init_cmd

    p_init = sub.add_parser(
        "init-harness",
        help="Scaffold .harness/config.json + CLAUDE.md in a repo. Introspects stacks.",
    )
    p_init.add_argument("repo_path", nargs="?", default=".", help="Repo path (default: cwd).")
    p_init.add_argument("--name", help="Project key (default: inferred from directory).")
    p_init.add_argument("--apply", action="store_true", help="Write files (default is dry-run).")
    p_init.set_defaults(_handler=init_cmd.cmd_init_harness)

    # ----- harness reindex
    from .commands import reindex as reindex_cmd

    p_reindex = sub.add_parser("reindex", help="Rebuild ~/.claude/plans/index.sqlite from disk.")
    p_reindex.set_defaults(_handler=reindex_cmd.cmd_reindex)

    # ----- harness reconcile
    from .commands import reconcile as reconcile_cmd

    p_reconcile = sub.add_parser(
        "reconcile",
        help="Poll pr-open ideas, update status, and re-dispatch builders for stuck PRs.",
    )
    p_reconcile.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing or re-dispatching.",
    )
    p_reconcile.add_argument(
        "--no-redispatch",
        action="store_true",
        help="Skip the Phase-4 re-dispatch step; only update statuses.",
    )
    p_reconcile.add_argument(
        "--force-redispatch",
        action="store_true",
        help="Re-dispatch even if reconcile_redispatched_at is already set on the idea.",
    )
    p_reconcile.set_defaults(_handler=reconcile_cmd.cmd_reconcile)

    # ----- harness mcp serve
    from .commands import mcp_server as mcp_cmd

    p_mcp = sub.add_parser("mcp", help="MCP transport for Claude Code + the Phase 3 mobile app.")
    mcp_sub = p_mcp.add_subparsers(dest="mcp_verb", metavar="ACTION")
    p_serve = mcp_sub.add_parser(
        "serve",
        help="JSON-RPC 2.0 server. Default: stdio (for Claude Code .mcp.json). --http: bind a port for the mobile app.",
    )
    p_serve.add_argument("--http", action="store_true", help="Use HTTP+bearer-token transport instead of stdio.")
    p_serve.add_argument("--bind", default="127.0.0.1", help="HTTP bind address (default: 127.0.0.1). Set to a Tailscale tailnet IP for mobile.")
    p_serve.add_argument("--port", type=int, default=7777, help="HTTP port (default: 7777).")
    p_serve.add_argument(
        "--token-file",
        default=None,
        help="Path to a file containing the bearer token. Required with --http.",
    )
    p_serve.add_argument(
        "--generate-token",
        action="store_true",
        help="Generate a 32-byte token at --token-file if missing.",
    )
    p_serve.set_defaults(_handler=mcp_cmd.cmd_serve)

    return parser


if __name__ == "__main__":
    sys.exit(main())
