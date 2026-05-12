# Codespace setup for the `codespace` worker

The `harness ideas build --worker codespace` flow creates a Codespace on
the target repo, ssh's in, and runs `worktree-runner.sh` there. For that
to work, the target repo's Codespace devcontainer must have:

1. **The harness skill scripts available at `~/.claude/skills/idea-harness/scripts/`.**
   The simplest path: clone idea-harness into the codespace at start.
2. **The five operator-control hooks copied to `~/.claude/hooks/`** so cloud
   builds get the same kill-switch, steer, verify-gate, track-read, and
   commit-on-stop primitives as local builds.
3. **A bot PAT** wired into `gh auth status` so the builder can push and
   `gh pr create`. Use a Codespace secret named `LETSBARKER_BOT_PAT`
   (or equivalent per project), then `gh auth login --with-token` in
   `postCreateCommand`.

## devcontainer.json (drop into `.devcontainer/devcontainer.json` in the target repo)

```jsonc
{
  "name": "harness build container",
  "image": "mcr.microsoft.com/devcontainers/universal:linux",
  "features": {
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },
  "postCreateCommand": "bash .devcontainer/install-harness.sh",
  "secrets": {
    "HARNESS_BOT_PAT": {
      "description": "PAT used by `gh pr create` inside the codespace"
    },
    "HARNESS_FUNNEL_URL": {
      "description": "Tailscale Funnel URL of the Mac harness MCP"
    },
    "HARNESS_MCP_TOKEN": {
      "description": "Bearer token for the Mac harness MCP"
    }
  }
}
```

## install-harness.sh (drop into `.devcontainer/install-harness.sh`)

```bash
#!/usr/bin/env bash
# postCreateCommand: install the harness skill + hooks + CLI into ~.
set -euo pipefail

# 1) Clone the harness repo and lay out the runtime paths.
git clone --depth=1 https://github.com/taylorpetrehn/idea-harness "$HOME/idea-harness-src"
mkdir -p "$HOME/.claude/skills/idea-harness/scripts"
mkdir -p "$HOME/.claude/skills/idea-harness/references"
mkdir -p "$HOME/.claude/hooks"

cp -r "$HOME/idea-harness-src/templates/skill-scripts/"* \
      "$HOME/.claude/skills/idea-harness/scripts/"
cp -r "$HOME/idea-harness-src/templates/skill-scripts/review-rubrics" \
      "$HOME/.claude/skills/idea-harness/references/" || true
cp "$HOME/idea-harness-src/.claude/hooks/"* "$HOME/.claude/hooks/"
chmod +x "$HOME/.claude/skills/idea-harness/scripts/"*.sh "$HOME/.claude/hooks/"*.sh

# 2) Install the Python CLI (gives us `harness` on PATH).
pip install -e "$HOME/idea-harness-src/cli"

# 3) Log gh in with the bot PAT so `gh pr create` works inside the codespace.
if [[ -n "${HARNESS_BOT_PAT:-}" ]]; then
  echo "$HARNESS_BOT_PAT" | gh auth login --with-token
fi

echo "Harness ready inside codespace. worktree-runner.sh available at:"
echo "  $HOME/.claude/skills/idea-harness/scripts/worktree-runner.sh"
```

## What the operator-control hooks do, in the cloud

The five hooks (kill-switch, steer, verify-gate, track-read, commit-on-stop)
work the same way they do locally:

- `kill-switch.sh` — long-running build sessions check for an `AGENT_STOP`
  file at the workspace root and exit cleanly if present. Lets you halt
  a runaway codespace build by `touch AGENT_STOP` via `gh codespace ssh`.
- `steer.sh` — looks for `STEER.md` in the workspace and surfaces it as a
  message at the start of the next agent turn. Same shape as local.
- `verify-gate.sh` — denies writes to `results.json` unless the right
  evidence (from `evidence.evaluators`) has been Read first.
- `track-read.sh` — records every Read call so verify-gate can see them.
- `commit-on-stop.sh` — on session end, commits any tracked changes so a
  killed codespace doesn't lose work.

Same files, same semantics — the only difference is that the codespace
gets blown away when the build finishes (`gh codespace delete`), so any
non-committed state is gone. The hooks ensure that anything important
makes it onto the branch before the codespace dies.

## Cost note

Each `--worker codespace` invocation spins up a 4-core / 16GB Linux
codespace for the duration of the build (typically 5–30 min) and then
deletes it. GitHub bills compute by the minute; expect ~$0.05–$0.30
per build at the default machine size. Per-project default lives in
`.harness/config.json:vcs.default_worker` so you can opt-in selectively
rather than making it the global default.
