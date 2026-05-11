---
description: Flip one idea's status to brainstormed (= accepted in this flow). Argument is the idea slug.
argument-hint: "<slug>"
allowed-tools: ["Bash"]
---

Run `harness ideas accept $1` and present the output. The verb flips the idea's status from whatever it was (typically `captured` or `needs-detail`) to `brainstormed`, sets `decided_at` to now, and appends a Notes entry. After the flip, the next `idea-harness-build` LaunchAgent tick (~15 min) will pick it up automatically. If the user wants it built right now, suggest they follow with `/idea-build $1`.

If `harness` is not on PATH, tell the user to install the CLI: `pip install -e ~/Projects/idea-harness/cli/`.
