---
description: Scaffold a .harness/config.json + CLAUDE.md in the current repo, with stack detection.
argument-hint: "[<repo-path>]"
allowed-tools: ["Bash"]
---

Run `harness init-harness $1` (defaults to `.` if no path given). The verb introspects the repo for stack signatures (Gemfile → rails, package.json → node, app.json → expo, Cargo.toml → rust, etc.), proposes a `.harness/config.json` with sensible commands, and prints it for review.

By default it's a dry run. If the user looks at the output and approves, re-run with `--apply` to actually write the files. The CLAUDE.md scaffold is a stub pointing at the canonical template — encourage the user to copy from `templates/repo/CLAUDE.md` if they need the full conventions doc.

After the files land, the user typically wants to:

1. Fill in the `github_repo`, `vcs.bot.*`, and `safety.*` sections by hand.
2. Add the project's key to `~/.claude/skills/idea-harness/references/projects.yml` so the harness routes captured ideas to it.
