"""harness init-harness <repo> — introspect stacks, scaffold .harness/config.json + CLAUDE.md."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Stack signatures: file or directory → stack name. Order matters for the
# "primary stack" guess in the output.
STACK_SIGNATURES: list[tuple[str, str]] = [
    ("Gemfile", "rails"),
    ("config/application.rb", "rails"),
    ("mobile/app.json", "expo"),
    ("app.json", "expo"),
    ("expo-env.d.ts", "expo"),
    ("vite.config.ts", "vite"),
    ("vite.config.js", "vite"),
    ("package.json", "node"),
    ("pyproject.toml", "python"),
    ("Cargo.toml", "rust"),
    ("go.mod", "go"),
    ("Dockerfile", "docker"),
]


def detect_stacks(repo: Path) -> list[str]:
    seen: list[str] = []
    for marker, stack in STACK_SIGNATURES:
        if (repo / marker).exists() and stack not in seen:
            seen.append(stack)
    return seen


def guess_commands(stacks: list[str], repo: Path) -> dict[str, str]:
    cmds: dict[str, str] = {}
    if "rails" in stacks:
        cmds.setdefault("smoke", "bin/rails runner 'puts ActiveRecord::Base.connection.tables.size'")
        cmds.setdefault("test_rails", "bundle exec rspec")
        cmds.setdefault("lint", "bundle exec rubocop")
        cmds.setdefault("dev_server", "bin/dev")
    if "expo" in stacks:
        mobile_dir = "mobile" if (repo / "mobile").is_dir() else "."
        cmds.setdefault("test_mobile", f"cd {mobile_dir} && npm test -- --watchAll=false")
    if "vite" in stacks or "node" in stacks:
        cmds.setdefault("test_node", "npm test")
        cmds.setdefault("dev_server", "npm run dev")
    if "python" in stacks:
        cmds.setdefault("test_python", "pytest -q")
    if "rust" in stacks:
        cmds.setdefault("test_rust", "cargo test")
        cmds.setdefault("smoke", "cargo check")
    return cmds


def cmd_init_harness(args: argparse.Namespace) -> int:
    # Default repo path: if --repo-path is the literal "." (the argparse
    # default), prefer $CLAUDE_PROJECT_DIR when Claude Code 2.1.139+ has
    # populated it (every Claude Code session sets it to the project root).
    raw = args.repo_path
    if raw == ".":
        project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
        if project_dir:
            raw = project_dir
            sys.stdout.write(f"[init-harness] using CLAUDE_PROJECT_DIR: {project_dir}\n")
    repo = Path(raw).expanduser().resolve()
    if not repo.is_dir():
        sys.stderr.write(f"[harness] not a directory: {repo}\n")
        return 1

    # Claude Code 2.1.139: warn if ANTHROPIC_API_KEY is set. The harness
    # relies on Claude Remote Control (Phase 1 escalation path),
    # /schedule, and claude.ai MCP connectors — all three are disabled
    # when the API key short-circuits the claude.ai login flow.
    if os.environ.get("ANTHROPIC_API_KEY"):
        sys.stderr.write(
            "\n⚠️  ANTHROPIC_API_KEY is set. Remote Control, /schedule, and\n"
            "    claude.ai MCP connectors are DISABLED when ANTHROPIC_API_KEY\n"
            "    is exported. The harness escalation flow (idea → phone) needs\n"
            "    Remote Control. Unset it for an interactive session:\n"
            "        unset ANTHROPIC_API_KEY\n"
            "    Then re-launch your shell or this session.\n\n"
        )

    name = args.name or repo.name.lower().replace(" ", "-")
    stacks = detect_stacks(repo)
    commands = guess_commands(stacks, repo)

    config = {
        "name": name,
        "identity": {
            "github_repo": "OWNER/REPO  # fill in",
            "local_path": str(repo),
        },
        "vcs": {
            "base_branch": "main",
            "branch_pattern": "idea/{slug-stub}-{id4}",
            "uses_worktrees": True,
            "worktree_pattern": f"../{repo.name}-wt-{{slug}}",
            "bot": {
                "name": "BotUser  # fill in",
                "email": "bot@example.com  # fill in",
                "pat_file": "~/.secrets/bot-pat  # fill in",
            },
        },
        "stacks": stacks or ["unknown"],
        "commands": commands or {"smoke": "echo no-op"},
        "evidence": {
            "results_file": ".harness/results.json",
            "evidence_patterns": ["tmp/screenshots/**/*.png", "log/test.log"],
            "evaluators": [],
            "merge_command": ".harness/merge-results.sh",
        },
        "safety": {
            "must_not_touch": [],
            "require_human_review_when_touching": [],
            "never_force_push_branches": ["main"],
            "always_label_pr": ["agent:needs-review"],
        },
    }

    target_config = repo / ".harness" / "config.json"
    target_claude_md = repo / "CLAUDE.md"

    sys.stdout.write(f"[init-harness] repo: {repo}\n")
    sys.stdout.write(f"[init-harness] name: {name}\n")
    sys.stdout.write(f"[init-harness] detected stacks: {', '.join(stacks) or '(none)'}\n")
    sys.stdout.write(f"[init-harness] proposed commands: {', '.join(commands) or '(none)'}\n")
    sys.stdout.write(f"[init-harness] target config: {target_config}\n")
    sys.stdout.write(f"[init-harness] target CLAUDE.md: {target_claude_md} "
                     f"({'exists; would NOT overwrite' if target_claude_md.exists() else 'will create'})\n")

    if not args.apply:
        sys.stdout.write("\n--- proposed .harness/config.json ---\n")
        sys.stdout.write(json.dumps(config, indent=2) + "\n")
        sys.stdout.write("\nRe-run with --apply to write the files.\n")
        return 0

    target_config.parent.mkdir(parents=True, exist_ok=True)
    if target_config.exists():
        sys.stderr.write(f"[init-harness] refusing to overwrite existing {target_config}\n")
        return 1
    target_config.write_text(json.dumps(config, indent=2) + "\n")
    sys.stdout.write(f"wrote {target_config}\n")

    if not target_claude_md.exists():
        # Reference the canonical template — don't bloat init-harness with
        # a duplicate of the template body. The user can `cp` it from the
        # idea-harness templates/repo/CLAUDE.md.
        target_claude_md.write_text(
            "# CLAUDE.md\n\n"
            "> Stub. Copy the canonical template from\n"
            "> https://github.com/taylorpetrehn/idea-harness/blob/main/templates/repo/CLAUDE.md\n"
            "> and customize for this repo. The `.harness/config.json` next to this file is\n"
            "> the machine-readable companion.\n"
        )
        sys.stdout.write(f"wrote {target_claude_md} (stub)\n")
    else:
        sys.stdout.write(f"skipping {target_claude_md} (already exists)\n")

    return 0
